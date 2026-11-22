mod catalog;
mod ferry_timetable;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use futures::future::join_all;
use futures::stream::{self, Stream};
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

const ETA_TTL_SECS: u64 = 90;

#[derive(Clone)]
struct Stop {
    id: String,
    mode: String,
    name: String,
    // Bus feeds publish the two names separately. Keeping them beside the
    // combined name lets the page show one language without guessing where
    // the Chinese half ends.
    name_tc: Option<String>,
    name_en: Option<String>,
    latitude: f64,
    longitude: f64,
    mtr_code: Option<String>,
    mtr_lines: Vec<String>,
    // Ids of stops that publish the same location, so one pin keeps every feed.
    member_ids: Vec<String>,
}

impl Stop {
    fn new(id: String, mode: &str, name: String, latitude: f64, longitude: f64) -> Self {
        Self {
            member_ids: vec![id.clone()],
            id,
            mode: mode.to_string(),
            name,
            name_tc: None,
            name_en: None,
            latitude,
            longitude,
            mtr_code: None,
            mtr_lines: Vec::new(),
        }
    }

    fn with_names(mut self, tc: Option<String>, en: Option<String>) -> Self {
        self.name_tc = tc
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self.name_en = en
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        self
    }
}

#[derive(Clone, Serialize)]
struct StopOut {
    id: String,
    mode: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name_tc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name_en: Option<String>,
    latitude: f64,
    longitude: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Snapshot {
    fetched_at: String,
    live: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    rows: Vec<Row>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Row {
    route: String,
    destination: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    minutes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    time: Option<String>,
    // The minibus has not left its first stop. The sheet prints 始站 beside 未開出.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    not_departed: bool,
}

struct App {
    stops: RwLock<Vec<Stop>>,
    by_id: RwLock<HashMap<String, Stop>>,
    by_location: RwLock<HashMap<String, String>>,
    // Member id -> the id that owns that location, so any id the web app holds
    // still resolves after stops are merged.
    by_member: RwLock<HashMap<String, String>>,
    gmb_routes: RwLock<HashMap<i64, String>>,
    // route id -> route_seq -> bilingual destination. Filled when a stop is opened.
    gmb_directions: RwLock<HashMap<i64, HashMap<i64, String>>>,
    city_routes: RwLock<HashMap<String, catalog::RouteEnds>>,
    redis: ConnectionManager,
    http: reqwest::Client,
    watch: std::sync::Mutex<HashMap<String, Vec<tokio::sync::mpsc::Sender<String>>>>,
}

#[derive(Deserialize)]
struct Bounds {
    south: f64,
    west: f64,
    north: f64,
    east: f64,
    modes: Option<String>,
}

#[tokio::main]
async fn main() {
    // The Upstash integration on Vercel may inject any of these names.
    let redis_url = match std::env::var("REDIS_URL")
        .or_else(|_| std::env::var("KV_URL"))
        .or_else(|_| std::env::var("UPSTASH_REDIS_URL"))
    {
        Ok(url) => url,
        Err(_) => {
            eprintln!("no redis url in the environment, trying redis://127.0.0.1:6379");
            "redis://127.0.0.1:6379".to_string()
        }
    };
    // Vercel injects PORT and expects the server to bind on all interfaces.
    let bind = std::env::var("PORT")
        .map(|port| format!("0.0.0.0:{port}"))
        .or_else(|_| std::env::var("BIND"))
        .unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let client = redis::Client::open(redis_url).expect("redis url");
    // ConnectionManager retries forever, which on a platform looks like a server
    // that never starts listening. Bound startup and say why instead.
    let redis = match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        client.get_connection_manager(),
    )
    .await
    {
        Ok(Ok(manager)) => manager,
        Ok(Err(error)) => {
            // Do not print the URL: it carries the password.
            eprintln!("redis is unreachable, refusing to start: {error}");
            std::process::exit(1);
        }
        Err(_) => {
            eprintln!("redis did not answer within 5s, refusing to start");
            std::process::exit(1);
        }
    };
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("realtime-hk-traffic")
        .build()
        .expect("http client");
    let app = Arc::new(App {
        stops: RwLock::new(Vec::new()),
        by_id: RwLock::new(HashMap::new()),
        by_location: RwLock::new(HashMap::new()),
        by_member: RwLock::new(HashMap::new()),
        gmb_routes: RwLock::new(catalog::bundled_routes()),
        gmb_directions: RwLock::new(HashMap::new()),
        city_routes: RwLock::new(HashMap::new()),
        redis,
        http,
        watch: std::sync::Mutex::new(HashMap::new()),
    });
    let startup = app.clone();
    tokio::spawn(async move { load_catalogues(startup).await });
    let cors_origins = std::env::var("CORS_ORIGINS").unwrap_or_else(|_| {
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002"
            .to_string()
    });
    let origins: Vec<HeaderValue> = cors_origins
        .split(',')
        .filter_map(|origin| origin.trim().parse().ok())
        .collect();
    let api = Router::new()
        .route("/stops", get(list_stops))
        .route("/stops/{id}/arrivals", get(arrivals))
        .route("/stops/{id}/timetable", get(timetable))
        .route("/stops/{id}/events", get(events));
    // Vercel hands the service the /api prefix, so answer on both shapes.
    let router = Router::new()
        .merge(api.clone())
        .nest("/api", api)
        .layer(
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods([Method::GET, Method::OPTIONS]),
        )
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(&bind).await.expect("bind");
    println!("listening on http://{bind}");
    axum::serve(listener, router).await.expect("serve");
}

async fn load_catalogues(app: Arc<App>) {
    let bundled = catalog::bundled_stops();
    let count = bundled.len();
    let (added, updated) = remember_local(&app, bundled).await;
    eprintln!("bundled stops {count} ({added} new, {updated} updated)");

    // MTR arrivals need the station code and lines; attach them before any
    // network or redis work so a cold first request is never missing them.
    let mtr = catalog::mtr_stops();
    let count = mtr.len();
    let (added, updated) = remember_local(&app, mtr).await;
    eprintln!("mtr stops {count} ({added} new, {updated} updated)");

    if live_catalogues_enabled() {
        eprintln!("live catalogue refresh enabled");
        refresh_live_catalogues(&app).await;
    } else {
        eprintln!("live catalogue refresh disabled; using bundled stops");
    }
    eprintln!("catalogue ready {}", app.stops.read().await.len());
}

// The bundled catalogue is complete enough to serve. Live catalogue crawls are
// opt-in because the minibus and Citybus walks cost thousands of requests.
fn live_catalogues_enabled() -> bool {
    std::env::var("LIVE_CATALOGUES")
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

async fn refresh_live_catalogues(app: &App) {
    let kmb = catalog::kmb_stops(&app.http).await;
    let count = kmb.len();
    let (added, updated) = remember(app, kmb).await;
    eprintln!("kmb stops {count} ({added} new, {updated} updated)");

    let taxi = catalog::taxi_stands(&app.http).await;
    let count = taxi.len();
    let (added, updated) = remember(app, taxi).await;
    eprintln!("taxi stands {count} ({added} new, {updated} updated)");

    let http = app.http.clone();
    let citybus_task = tokio::spawn(async move { catalog::citybus_stops(&http).await });
    let http = app.http.clone();
    let minibus_task = tokio::spawn(async move { catalog::minibus_stops(&http).await });

    let citybus = citybus_task.await.unwrap_or_default();
    let count = citybus.len();
    let (added, updated) = remember(app, citybus).await;
    eprintln!("citybus stops {count} ({added} new, {updated} updated)");

    if let Ok((minibus, routes)) = minibus_task.await {
        let count = minibus.len();
        // The bundled map already names every known route; the crawl only adds
        // routes that appeared after it was generated.
        app.gmb_routes.write().await.extend(routes);
        let (added, updated) = remember(app, minibus).await;
        eprintln!("minibus stops {count} ({added} new, {updated} updated)");
    }
}

async fn remember(app: &App, stops: Vec<Stop>) -> (usize, usize) {
    if stops.is_empty() {
        return (0, 0);
    }
    index_stops(app, stops).await
}

// The bundled catalogue already travels in the binary; caching it in redis
// too would cost tens of thousands of writes on every cold start.
async fn remember_local(app: &App, stops: Vec<Stop>) -> (usize, usize) {
    if stops.is_empty() {
        return (0, 0);
    }
    index_stops(app, stops).await
}

async fn index_stops(app: &App, stops: Vec<Stop>) -> (usize, usize) {
    let mut all = app.stops.write().await;
    let mut index = app.by_id.write().await;
    let mut locations = app.by_location.write().await;
    let mut members = app.by_member.write().await;
    let mut added = 0;
    let mut updated = 0;
    for stop in stops {
        let key = location_key(&stop);
        let owner = locations.get(&key).cloned();
        match owner.and_then(|id| index.get_mut(&id).map(|kept| (id, kept))) {
            Some((owner, kept)) => {
                let owns_location = stop.id == owner;
                for member in stop.member_ids {
                    members.insert(member.clone(), owner.clone());
                    if !kept.member_ids.contains(&member) {
                        kept.member_ids.push(member);
                    }
                }
                // A live record carries fields the seed does not, such as MTR lines.
                // Only the id that owns this location may rename it; a duplicate
                // id at the same coordinates must not replace the chosen name.
                let has_live_names =
                    owns_location && (stop.name_tc.is_some() || stop.name_en.is_some());
                if !stop.mtr_lines.is_empty() {
                    kept.mtr_lines = stop.mtr_lines;
                    kept.mtr_code = stop.mtr_code;
                    kept.name = stop.name;
                } else if has_live_names {
                    kept.name = stop.name;
                }
                if has_live_names {
                    kept.name_tc = stop.name_tc;
                    kept.name_en = stop.name_en;
                }
                updated += 1;
            }
            None => {
                locations.insert(key, stop.id.clone());
                members.insert(stop.id.clone(), stop.id.clone());
                index.insert(stop.id.clone(), stop);
                added += 1;
            }
        }
    }
    // One entry per location; a stop seen in two sources is refreshed, not doubled.
    *all = index.values().cloned().collect();
    (added, updated)
}

fn location_key(stop: &Stop) -> String {
    format!("{}:{:.6}:{:.6}", stop.mode, stop.latitude, stop.longitude)
}

async fn owner_id(app: &App, id: &str) -> String {
    app.by_member
        .read()
        .await
        .get(id)
        .cloned()
        .unwrap_or_else(|| id.to_string())
}

async fn list_stops(State(app): State<Arc<App>>, Query(bounds): Query<Bounds>) -> Response {
    if !bounds.south.is_finite()
        || !bounds.west.is_finite()
        || !bounds.north.is_finite()
        || !bounds.east.is_finite()
        || bounds.south >= bounds.north
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "bounds are invalid"})),
        )
            .into_response();
    }
    let allowed: Option<Vec<&str>> = bounds.modes.as_deref().map(|modes| {
        modes
            .split(',')
            .map(str::trim)
            .filter(|mode| !mode.is_empty())
            .collect()
    });
    let stops = app.stops.read().await;
    let mut matched = Vec::new();
    for stop in stops.iter() {
        if let Some(modes) = &allowed {
            if !modes.contains(&stop.mode.as_str()) {
                continue;
            }
        }
        if !in_box(
            stop.latitude,
            stop.longitude,
            bounds.south,
            bounds.west,
            bounds.north,
            bounds.east,
        ) {
            continue;
        }
        matched.push(StopOut {
            id: stop.id.clone(),
            mode: stop.mode.clone(),
            name: stop.name.clone(),
            name_tc: stop.name_tc.clone(),
            name_en: stop.name_en.clone(),
            latitude: stop.latitude,
            longitude: stop.longitude,
        });
    }
    Json(json!({"stops": matched})).into_response()
}

async fn timetable(Path(id): Path<String>, State(app): State<Arc<App>>) -> Response {
    let Some(pier) = id.strip_prefix("ferry:") else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no timetable"})),
        )
            .into_response();
    };
    Json(ferry_timetable::for_pier(&app.http, app.redis.clone(), pier).await).into_response()
}

async fn arrivals(State(app): State<Arc<App>>, Path(id): Path<String>) -> Response {
    let id = owner_id(&app, &id).await;
    let Some(stop) = app.by_id.read().await.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "unknown stop"})),
        )
            .into_response();
    };
    if stop.mode == "taxi" {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "no arrivals"}))).into_response();
    }
    if let Some(body) = read_snapshot(&app, &id).await {
        return (StatusCode::OK, [("content-type", "application/json")], body).into_response();
    }
    // A direct caller has no stream to wait on, so fetch once on its behalf
    // instead of reporting a snapshot that was never asked for.
    refresh(&app, &stop).await;
    match read_snapshot(&app, &id).await {
        Some(body) => {
            (StatusCode::OK, [("content-type", "application/json")], body).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "snapshot is gone"})),
        )
            .into_response(),
    }
}

async fn events(
    State(app): State<Arc<App>>,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, Response> {
    let id = owner_id(&app, &id).await;
    let Some(stop) = app.by_id.read().await.get(&id).cloned() else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": "unknown stop"})),
        )
            .into_response());
    };
    if stop.mode == "taxi" {
        return Err((StatusCode::NOT_FOUND, Json(json!({"error": "no arrivals"}))).into_response());
    }
    let (sender, receiver) = tokio::sync::mpsc::channel(8);
    {
        let mut watch = app.watch.lock().expect("watch lock");
        watch.entry(id.clone()).or_default().push(sender);
    }
    if let Some(body) = read_snapshot(&app, &id).await {
        publish(&app, &id, &body);
    } else {
        let app = app.clone();
        tokio::spawn(async move { refresh(&app, &stop).await });
    }
    let stream = stream::unfold(receiver, |mut receiver| async move {
        let message = receiver.recv().await?;
        Some((
            Ok(Event::default().event("arrivals").data(message)),
            receiver,
        ))
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15))))
}

async fn fetch_arrivals(app: &App, stop: &Stop) -> Option<Snapshot> {
    match stop.mode.as_str() {
        "mtr" => mtr_arrivals(&app.http, stop).await,
        "bus" => bus_arrivals(app, stop).await,
        "minibus" => minibus_arrivals(app, stop).await,
        "ferry" => ferry_arrivals(&app.http, stop).await,
        _ => None,
    }
}

fn merge_snapshots(parts: Vec<Snapshot>) -> Option<Snapshot> {
    if parts.is_empty() {
        return None;
    }
    let mut rows: Vec<Row> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut status = None;
    let mut live = false;
    for part in &parts {
        live = live || part.live;
        if status.is_none() {
            status = part.status.clone();
        }
        for row in &part.rows {
            let key = (
                row.route.clone(),
                row.destination.clone(),
                row.minutes,
                row.time.clone(),
            );
            if seen.insert(key) {
                rows.push(row.clone());
            }
        }
    }
    Some(Snapshot {
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        live,
        status,
        note: None,
        rows,
    })
}

async fn refresh(app: &App, stop: &Stop) {
    let mut parts = Vec::new();
    for member in &stop.member_ids {
        let mut one = stop.clone();
        one.id = member.clone();
        one.member_ids = vec![member.clone()];
        if let Some(snapshot) = fetch_arrivals(app, &one).await {
            parts.push(snapshot);
        }
    }
    // A feed can list one departure under several service types; the row shape
    // has no field for that, so identical arrivals collapse into one.
    let snapshot = merge_snapshots(parts);
    let Some(snapshot) = snapshot else {
        return;
    };
    let Ok(body) = serde_json::to_string(&snapshot) else {
        return;
    };
    let mut redis = app.redis.clone();
    let saved: Result<(), _> = redis::cmd("SET")
        .arg(format!("arrivals:{}", stop.id))
        .arg(&body)
        .arg("EX")
        .arg(ETA_TTL_SECS)
        .query_async(&mut redis)
        .await;
    if saved.is_err() {
        eprintln!("redis arrival write failed for {}", stop.id);
        return;
    }
    publish(app, &stop.id, &body);
}

async fn read_snapshot(app: &App, id: &str) -> Option<String> {
    let mut redis = app.redis.clone();
    redis::cmd("GET")
        .arg(format!("arrivals:{id}"))
        .query_async(&mut redis)
        .await
        .ok()
        .flatten()
}

async fn city_places(app: &App) -> Vec<(String, String)> {
    let stops = app.stops.read().await;
    stops
        .iter()
        .filter(|stop| stop.id.starts_with("bus:ctb:"))
        .filter_map(|stop| match (&stop.name_tc, &stop.name_en) {
            (Some(tc), Some(en)) => Some((tc.clone(), en.clone())),
            _ => catalog::bilingual_name(&stop.name),
        })
        .collect()
}

async fn city_routes(app: &App) -> HashMap<String, catalog::RouteEnds> {
    {
        let cached = app.city_routes.read().await;
        if !cached.is_empty() {
            return cached.clone();
        }
    }
    let fetched = catalog::citybus_route_ends(&app.http).await;
    if fetched.is_empty() {
        return fetched;
    }
    let mut cached = app.city_routes.write().await;
    if cached.is_empty() {
        *cached = fetched.clone();
    }
    cached.clone()
}

fn publish(app: &App, id: &str, body: &str) {
    let mut watch = app.watch.lock().expect("watch lock");
    let Some(senders) = watch.get_mut(id) else {
        return;
    };
    senders.retain(|sender| sender.try_send(body.to_string()).is_ok());
}

async fn eta_rows(app: &App, url: &str) -> Option<Vec<Value>> {
    let response = app.http.get(url).send().await.ok()?;
    let parsed = response.json::<Value>().await.ok()?;
    Some(parsed.get("data")?.as_array()?.clone())
}

// The batch feed returns one language in `dest`. The same trip is the same
// route, direction, stop sequence, ETA sequence and ETA in both responses.
fn citybus_row_key(item: &Value) -> String {
    let text = |name| {
        item.get(name)
            .and_then(|value| value.as_str())
            .unwrap_or("")
    };
    let number = |name| item.get(name).and_then(|value| value.as_i64()).unwrap_or(0);
    format!(
        "{}|{}|{}|{}|{}",
        text("route"),
        text("dir"),
        number("seq"),
        number("eta_seq"),
        text("eta")
    )
}

async fn bus_arrivals(app: &App, stop: &Stop) -> Option<Snapshot> {
    let raw = stop.id.split(':').nth(2)?;
    let citybus = stop.id.starts_with("bus:ctb:");
    let routes = if citybus {
        city_routes(app).await
    } else {
        HashMap::new()
    };
    let places = if citybus {
        city_places(app).await
    } else {
        Vec::new()
    };
    let place_refs: Vec<(&str, &str)> = places
        .iter()
        .map(|(chinese, english)| (chinese.as_str(), english.as_str()))
        .collect();
    // Citybus `lang` selects the language of `dest`. One call cannot return
    // both, so the Chinese and English batches are requested together.
    let (rows_in, chinese_dest) = if citybus {
        let english_url =
            format!("https://rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/{raw}?lang=en");
        let chinese_url =
            format!("https://rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/{raw}?lang=zh-Hant");
        let (english, chinese) =
            tokio::join!(eta_rows(app, &english_url), eta_rows(app, &chinese_url));
        let mut chinese_dest = HashMap::new();
        if let Some(chinese) = chinese {
            for item in chinese {
                if let Some(dest) = item.get("dest").and_then(|value| value.as_str()) {
                    chinese_dest.insert(citybus_row_key(&item), dest.to_string());
                }
            }
        }
        (english?, chinese_dest)
    } else {
        let url = format!("https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/{raw}");
        (eta_rows(app, &url).await?, HashMap::new())
    };
    let mut rows = Vec::new();
    for item in &rows_in {
        let route = item
            .get("route")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let paired = chinese_dest.get(&citybus_row_key(item)).map(String::as_str);
        let tc = paired.unwrap_or_else(|| {
            item.get("dest_tc")
                .and_then(|value| value.as_str())
                .unwrap_or("")
        });
        let en = item
            .get("dest_en")
            .or_else(|| item.get("dest"))
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let dir = item
            .get("dir")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let destination = catalog::arrival_destination(routes.get(route), &place_refs, dir, tc, en);
        let eta = item
            .get("eta")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if eta.is_empty() {
            continue;
        }
        let Some(minutes) = minutes_until(eta) else {
            continue;
        };
        rows.push(Row {
            route: route.to_string(),
            destination,
            minutes: Some(minutes),
            time: None,
            not_departed: false,
        });
    }
    rows.sort_by_key(|row| row.minutes.unwrap_or(i64::MAX));
    rows.truncate(16);
    Some(Snapshot {
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        live: true,
        status: None,
        note: None,
        rows,
    })
}

async fn minibus_arrivals(app: &App, stop: &Stop) -> Option<Snapshot> {
    let raw = stop.id.strip_prefix("minibus:")?;
    let url = format!("https://data.etagmb.gov.hk/eta/stop/{raw}");
    let response = app.http.get(url).send().await.ok()?;
    let parsed = response.json::<Value>().await.ok()?;
    let groups = parsed.get("data")?.as_array()?;
    let route_ids: Vec<i64> = groups
        .iter()
        .filter_map(|group| group.get("route_id").and_then(|value| value.as_i64()))
        .collect();
    let destinations = gmb_destinations(app, &route_ids).await;
    let names = app.gmb_routes.read().await;
    let mut rows = Vec::new();
    for group in groups {
        let route_id = group.get("route_id").and_then(|value| value.as_i64());
        let route_seq = group.get("route_seq").and_then(|value| value.as_i64());
        let route = route_id
            .and_then(|id| names.get(&id).cloned())
            .unwrap_or_default();
        let destination = route_id
            .zip(route_seq)
            .and_then(|key| destinations.get(&key).cloned())
            .unwrap_or_default();
        let Some(etas) = group.get("eta").and_then(|value| value.as_array()) else {
            continue;
        };
        for eta in etas {
            let minutes = eta.get("diff").and_then(|value| value.as_i64());
            let remark = eta
                .get("remarks_tc")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            rows.push(Row {
                route: route.clone(),
                destination: destination.clone(),
                minutes,
                time: None,
                not_departed: gmb_not_departed(remark),
            });
        }
    }
    rows.sort_by_key(|row| row.minutes.unwrap_or(i64::MAX));
    rows.truncate(16);
    Some(Snapshot {
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        live: true,
        status: None,
        note: None,
        rows,
    })
}

fn gmb_not_departed(remark: &str) -> bool {
    remark == "未開出" || remark == "未开出"
}

fn bilingual(tc: &str, en: &str) -> String {
    let tc = tc.trim();
    let en = en.trim();
    if tc.is_empty() {
        en.to_string()
    } else if en.is_empty() {
        tc.to_string()
    } else {
        format!("{tc} {en}")
    }
}

fn gmb_direction_names(parsed: &Value) -> HashMap<i64, String> {
    let mut names = HashMap::new();
    let Some(variants) = parsed.get("data").and_then(|value| value.as_array()) else {
        return names;
    };
    for variant in variants {
        let Some(directions) = variant.get("directions").and_then(|value| value.as_array()) else {
            continue;
        };
        for direction in directions {
            let Some(seq) = direction.get("route_seq").and_then(|value| value.as_i64()) else {
                continue;
            };
            let tc = direction
                .get("dest_tc")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let en = direction
                .get("dest_en")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let destination = bilingual(tc, en);
            if !destination.is_empty() {
                names.insert(seq, destination);
            }
        }
    }
    names
}

async fn gmb_route_directions(
    http: &reqwest::Client,
    route_id: i64,
) -> Option<HashMap<i64, String>> {
    let url = format!("https://data.etagmb.gov.hk/route/{route_id}");
    let response = http.get(url).send().await.ok()?;
    let parsed = response.json::<Value>().await.ok()?;
    Some(gmb_direction_names(&parsed))
}

async fn gmb_destinations(app: &App, route_ids: &[i64]) -> HashMap<(i64, i64), String> {
    let missing: Vec<i64> = {
        let cached = app.gmb_directions.read().await;
        route_ids
            .iter()
            .copied()
            .filter(|id| !cached.contains_key(id))
            .collect()
    };
    if !missing.is_empty() {
        let fetched = join_all(
            missing
                .iter()
                .map(|id| gmb_route_directions(&app.http, *id)),
        )
        .await;
        let mut cached = app.gmb_directions.write().await;
        for (id, directions) in missing.into_iter().zip(fetched) {
            if let Some(directions) = directions {
                cached.entry(id).or_insert(directions);
            }
        }
    }
    let cached = app.gmb_directions.read().await;
    let mut destinations = HashMap::new();
    for id in route_ids {
        let Some(directions) = cached.get(id) else {
            continue;
        };
        for (seq, destination) in directions {
            destinations.insert((*id, *seq), destination.clone());
        }
    }
    destinations
}

async fn mtr_arrivals(http: &reqwest::Client, stop: &Stop) -> Option<Snapshot> {
    let code = stop.mtr_code.as_deref()?;
    let mut rows = Vec::new();
    let mut delayed = false;
    for line in &stop.mtr_lines {
        let url = format!(
            "https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line={line}&sta={code}"
        );
        let Ok(response) = http.get(url).send().await else {
            continue;
        };
        let Ok(parsed) = response.json::<Value>().await else {
            continue;
        };
        if parsed.get("isdelay").and_then(|value| value.as_str()) == Some("Y") {
            delayed = true;
        }
        let Some(entry) = parsed.get("data").and_then(|value| value.as_object()) else {
            continue;
        };
        for trains in entry.values() {
            for direction in ["UP", "DOWN"] {
                let Some(list) = trains.get(direction).and_then(|value| value.as_array()) else {
                    continue;
                };
                for train in list {
                    if train.get("valid").and_then(|value| value.as_str()) == Some("N") {
                        continue;
                    }
                    let dest = train
                        .get("dest")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    let minutes = train
                        .get("ttnt")
                        .and_then(|value| value.as_str())
                        .and_then(|value| value.parse().ok());
                    let time = train
                        .get("time")
                        .and_then(|value| value.as_str())
                        .map(|value| value.split(' ').nth(1).unwrap_or(value).to_string());
                    rows.push(Row {
                        route: line.clone(),
                        destination: mtr_dest(dest),
                        minutes,
                        time,
                        not_departed: false,
                    });
                }
            }
        }
    }
    rows.sort_by_key(|row| row.minutes.unwrap_or(i64::MAX));
    rows.truncate(16);
    Some(Snapshot {
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        live: true,
        status: delayed.then(|| "delayed".to_string()),
        note: None,
        rows,
    })
}

#[derive(Clone, Deserialize)]
struct FerrySailing {
    op: String,
    route: String,
    #[serde(default)]
    direction: String,
    label: String,
    destination: String,
}

fn ferry_sailings() -> &'static HashMap<String, Vec<FerrySailing>> {
    static SAILINGS: std::sync::OnceLock<HashMap<String, Vec<FerrySailing>>> =
        std::sync::OnceLock::new();
    SAILINGS.get_or_init(|| {
        match serde_json::from_str(include_str!("../data/ferry-departures.json")) {
            Ok(parsed) => parsed,
            Err(error) => {
                eprintln!("ferry departures unreadable: {error}");
                HashMap::new()
            }
        }
    })
}

async fn ferry_arrivals(http: &reqwest::Client, stop: &Stop) -> Option<Snapshot> {
    let pier = stop.id.strip_prefix("ferry:")?;
    let sailings = ferry_sailings().get(pier).cloned().unwrap_or_default();
    if sailings.is_empty() {
        return Some(empty_snapshot());
    }
    let fetched = join_all(sailings.iter().map(|sailing| ferry_sailing(http, sailing))).await;
    if fetched.iter().all(Result::is_err) {
        return None;
    }
    let mut rows = Vec::new();
    for part in fetched.into_iter().flatten() {
        rows.extend(part);
    }
    rows.sort_by_key(|row| row.minutes.unwrap_or(i64::MAX));
    rows.truncate(16);
    Some(Snapshot {
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        live: true,
        status: None,
        note: None,
        rows,
    })
}

fn empty_snapshot() -> Snapshot {
    Snapshot {
        fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        live: true,
        status: None,
        note: None,
        rows: Vec::new(),
    }
}

async fn ferry_sailing(http: &reqwest::Client, sailing: &FerrySailing) -> Result<Vec<Row>, ()> {
    let url = match sailing.op.as_str() {
        "hkkf" => format!(
            "https://www.hkkfeta.com/opendata/eta/{}/{}",
            sailing.route, sailing.direction
        ),
        "sun" => format!("https://www.sunferry.com.hk/eta/?route={}", sailing.route),
        _ => return Err(()),
    };
    let response = http.get(url).send().await.map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let parsed = response.json::<Value>().await.map_err(|_| ())?;
    let items = parsed
        .get("data")
        .and_then(|value| value.as_array())
        .ok_or(())?;
    let mut rows = Vec::new();
    for item in items {
        let shown = match sailing.op.as_str() {
            "hkkf" => hkkf_shown(item),
            "sun" => sun_shown(item),
            _ => None,
        };
        let Some(when) = shown else { continue };
        let Some(minutes) = minutes_from(when) else {
            continue;
        };
        rows.push(Row {
            route: sailing.label.clone(),
            destination: sailing.destination.clone(),
            minutes: Some(minutes),
            time: Some(when.format("%H:%M").to_string()),
            not_departed: false,
        });
    }
    Ok(rows)
}

// The departure is shown while it is still ahead. Once the boat has left, `ETA`
// is its arrival, shown the same way as a Sun Ferry trip that is under way.
fn hkkf_shown(item: &Value) -> Option<DateTime<chrono::FixedOffset>> {
    let date = item.get("date").and_then(|value| value.as_str())?;
    let session = item.get("session_time").and_then(|value| value.as_str())?;
    let departs = hk_stamp(date, session)?;
    if minutes_from(departs).is_some() {
        return Some(departs);
    }
    let eta = item.get("ETA").and_then(|value| value.as_str())?;
    DateTime::parse_from_rfc3339(eta).ok()
}

// `depart_time` and `eta` are clocks. `date_timestamp` is when Sun Ferry
// generated the row, so each clock is the occurrence nearest that instant.
// `eta` is the arrival of this trip. A departure already in the past is not
// moved to the next day.
fn sun_shown(item: &Value) -> Option<DateTime<chrono::FixedOffset>> {
    let stamped = item
        .get("date_timestamp")
        .and_then(|value| value.as_str())?;
    let generated = DateTime::parse_from_rfc3339(stamped).ok()?;
    for key in ["eta", "depart_time"] {
        let Some(clock) = item
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(when) = sun_clock(&generated, clock) else {
            continue;
        };
        if when.signed_duration_since(generated).num_seconds() >= -90 {
            return Some(when);
        }
    }
    None
}

fn sun_clock(
    generated: &DateTime<chrono::FixedOffset>,
    clock: &str,
) -> Option<DateTime<chrono::FixedOffset>> {
    if clock.contains('T') {
        return DateTime::parse_from_rfc3339(clock)
            .ok()
            .map(|when| when.fixed_offset());
    }
    nearest_clock(*generated, clock)
}

fn nearest_clock(
    generated: DateTime<chrono::FixedOffset>,
    clock: &str,
) -> Option<DateTime<chrono::FixedOffset>> {
    let mut parts = clock.split(':');
    let hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = parts.next()?.parse().ok()?;
    let second: u32 = parts.next().unwrap_or("0").parse().ok()?;
    let time = chrono::NaiveTime::from_hms_opt(hour, minute, second)?;
    let mut best: Option<DateTime<chrono::FixedOffset>> = None;
    let mut best_abs = i64::MAX;
    for delta in [-1_i64, 0, 1] {
        let day = generated.date_naive() + chrono::Duration::days(delta);
        let when = day
            .and_time(time)
            .and_local_timezone(*generated.offset())
            .single()?;
        let abs = when.signed_duration_since(generated).num_seconds().abs();
        if abs < best_abs {
            best_abs = abs;
            best = Some(when);
        }
    }
    best
}

fn hk_stamp(date: &str, clock: &str) -> Option<DateTime<chrono::FixedOffset>> {
    let mut parts = clock.split(':');
    let hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = parts.next()?.parse().ok()?;
    let second: u32 = parts.next().unwrap_or("0").parse().ok()?;
    let offset = chrono::FixedOffset::east_opt(8 * 3600)?;
    let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let time = chrono::NaiveTime::from_hms_opt(hour, minute, second)?;
    day.and_time(time).and_local_timezone(offset).single()
}

fn minutes_from(when: DateTime<chrono::FixedOffset>) -> Option<i64> {
    let seconds = when
        .with_timezone(&Utc)
        .signed_duration_since(Utc::now())
        .num_seconds();
    if seconds < -90 {
        return None;
    }
    Some((seconds / 60).max(0))
}

fn minutes_until(eta: &str) -> Option<i64> {
    let when = DateTime::parse_from_rfc3339(eta).ok()?;
    let seconds = when
        .with_timezone(&Utc)
        .signed_duration_since(Utc::now())
        .num_seconds();
    Some((seconds / 60).max(0))
}

fn mtr_dest(code: &str) -> String {
    catalog::mtr_label(code)
}

fn in_box(lat: f64, lng: f64, south: f64, west: f64, north: f64, east: f64) -> bool {
    if lat < south || lat > north {
        return false;
    }
    if west <= east {
        lng >= west && lng <= east
    } else {
        lng >= west || lng <= east
    }
}

#[cfg(test)]
mod tests {
    use super::hk_stamp;

    #[test]
    fn ferry_clock_is_hong_kong_time() {
        let when = hk_stamp("2026-11-21", "04:15").expect("stamp");
        assert_eq!(when.to_rfc3339(), "2026-11-21T04:15:00+08:00");
    }

    #[test]
    fn departed_hkkf_sailing_is_dropped() {
        let item = serde_json::json!({
            "date": "2020-01-01",
            "session_time": "12:15:00"
        });
        assert!(super::hkkf_shown(&item).is_none());
    }

    #[test]
    fn hkkf_sailing_in_transit_shows_its_arrival() {
        let hong_kong = chrono::FixedOffset::east_opt(8 * 3600).expect("offset");
        let departed = chrono::Utc::now().with_timezone(&hong_kong) - chrono::Duration::minutes(30);
        let arrives = chrono::Utc::now().with_timezone(&hong_kong) + chrono::Duration::minutes(20);
        let item = serde_json::json!({
            "date": departed.format("%Y-%m-%d").to_string(),
            "session_time": departed.format("%H:%M:%S").to_string(),
            "ETA": arrives.to_rfc3339()
        });
        let when = super::hkkf_shown(&item).expect("arrival");
        assert_eq!(
            when.format("%H:%M").to_string(),
            arrives.format("%H:%M").to_string()
        );
        assert!((19..=20).contains(&super::minutes_from(when).expect("ahead")));
    }

    #[test]
    fn departed_sun_sailing_uses_its_arrival() {
        let item = serde_json::json!({
            "depart_time": "04:15",
            "eta": "04:48",
            "date_timestamp": "2026-11-21T04:22:07+08:00"
        });
        let when = super::sun_shown(&item).expect("arrival");
        assert_eq!(when.to_rfc3339(), "2026-11-21T04:48:00+08:00");
    }

    #[test]
    fn minibus_destination_comes_from_the_route_and_not_the_remark() {
        let parsed = serde_json::json!({
            "data": [{
                "route_id": 2001524,
                "directions": [
                    { "route_seq": 1, "dest_tc": "崇仁街", "dest_en": "Shung Yan Street" },
                    { "route_seq": 2, "dest_tc": "麗晶花園", "dest_en": "Richland Gardens" }
                ]
            }]
        });
        let names = super::gmb_direction_names(&parsed);
        assert_eq!(
            names.get(&1).map(String::as_str),
            Some("崇仁街 Shung Yan Street")
        );
        assert!(super::gmb_not_departed("未開出"));
        assert!(!super::gmb_not_departed(""));
    }

    #[test]
    fn sun_clock_after_midnight_is_the_coming_morning() {
        let item = serde_json::json!({
            "depart_time": "07:23",
            "date_timestamp": "2026-11-20T23:59:07+08:00"
        });
        let when = super::sun_shown(&item).expect("departure");
        assert_eq!(when.to_rfc3339(), "2026-11-21T07:23:00+08:00");
    }

    #[test]
    fn bundled_bus_stops_keep_the_published_names_apart() {
        let stops = super::catalog::bundled_stops();
        let stop = stops
            .iter()
            .find(|stop| stop.id == "bus:kmb:1E10D70B8D3AC179")
            .expect("stop");
        assert_eq!(stop.name_tc.as_deref(), Some("太古廣場 (A1)"));
        assert_eq!(stop.name_en.as_deref(), Some("PACIFIC PLACE (A1)"));
    }
}
