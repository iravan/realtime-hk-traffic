mod catalog;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
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
            latitude,
            longitude,
            mtr_code: None,
            mtr_lines: Vec::new(),
        }
    }
}

#[derive(Clone, Serialize)]
struct StopOut {
    id: String,
    mode: String,
    name: String,
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
}

struct App {
    stops: RwLock<Vec<Stop>>,
    by_id: RwLock<HashMap<String, Stop>>,
    by_location: RwLock<HashMap<String, String>>,
    // Member id -> the id that owns that location, so any id the web app holds
    // still resolves after stops are merged.
    by_member: RwLock<HashMap<String, String>>,
    gmb_routes: RwLock<HashMap<i64, String>>,
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
                for member in stop.member_ids {
                    members.insert(member.clone(), owner.clone());
                    if !kept.member_ids.contains(&member) {
                        kept.member_ids.push(member);
                    }
                }
                // A live record carries fields the seed does not, such as MTR lines.
                if !stop.mtr_lines.is_empty() {
                    kept.mtr_lines = stop.mtr_lines;
                    kept.mtr_code = stop.mtr_code;
                    kept.name = stop.name;
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
            latitude: stop.latitude,
            longitude: stop.longitude,
        });
    }
    Json(json!({"stops": matched})).into_response()
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
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no arrivals"})),
        )
            .into_response();
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
        return Err((
            StatusCode::NOT_FOUND,
            Json(json!({"error": "no arrivals"})),
        )
            .into_response());
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
        "bus" => bus_arrivals(&app.http, stop).await,
        "minibus" => minibus_arrivals(app, stop).await,
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

fn publish(app: &App, id: &str, body: &str) {
    let mut watch = app.watch.lock().expect("watch lock");
    let Some(senders) = watch.get_mut(id) else {
        return;
    };
    senders.retain(|sender| sender.try_send(body.to_string()).is_ok());
}

async fn bus_arrivals(http: &reqwest::Client, stop: &Stop) -> Option<Snapshot> {
    let raw = stop.id.split(':').nth(2)?;
    let url = if stop.id.starts_with("bus:ctb:") {
        format!("https://rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/{raw}")
    } else {
        format!("https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/{raw}")
    };
    let response = http.get(url).send().await.ok()?;
    let parsed = response.json::<Value>().await.ok()?;
    let rows_in = parsed.get("data")?.as_array()?;
    let mut rows = Vec::new();
    for item in rows_in {
        let route = item
            .get("route")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let destination = item
            .get("dest_tc")
            .or_else(|| item.get("dest"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
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
    let names = app.gmb_routes.read().await;
    let mut rows = Vec::new();
    for group in groups {
        let route_id = group.get("route_id").and_then(|value| value.as_i64());
        let route = route_id
            .and_then(|id| names.get(&id).cloned())
            .unwrap_or_default();
        let Some(etas) = group.get("eta").and_then(|value| value.as_array()) else {
            continue;
        };
        for eta in etas {
            let minutes = eta.get("diff").and_then(|value| value.as_i64());
            let destination = eta
                .get("remarks_tc")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            rows.push(Row {
                route: route.clone(),
                destination,
                minutes,
                time: None,
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
