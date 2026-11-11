mod catalog;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use redis::aio::ConnectionManager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

const ETA_TTL_SECS: u64 = 60;

#[derive(Clone)]
struct Stop {
    id: String,
    mode: String,
    name: String,
    latitude: f64,
    longitude: f64,
    mtr_code: Option<String>,
    mtr_lines: Vec<String>,
}

impl Stop {
    fn new(id: String, mode: &str, name: String, latitude: f64, longitude: f64) -> Self {
        Self {
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
    gmb_routes: RwLock<HashMap<i64, String>>,
    redis: ConnectionManager,
    http: reqwest::Client,
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
    let redis_url = std::env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string());
    let bind = std::env::var("BIND").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let client = redis::Client::open(redis_url).expect("redis url");
    let redis = client
        .get_connection_manager()
        .await
        .expect("redis connection");
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("realtime-hk-traffic")
        .build()
        .expect("http client");
    let app = Arc::new(App {
        stops: RwLock::new(Vec::new()),
        by_id: RwLock::new(HashMap::new()),
        gmb_routes: RwLock::new(HashMap::new()),
        redis,
        http,
    });
    let startup = app.clone();
    tokio::spawn(async move { load_catalogues(startup).await });
    let cors_origins = std::env::var("CORS_ORIGINS")
        .unwrap_or_else(|_| {
            "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002"
                .to_string()
        });
    let origins: Vec<HeaderValue> = cors_origins
        .split(',')
        .filter_map(|origin| origin.trim().parse().ok())
        .collect();
    let router = Router::new()
        .route("/stops", get(list_stops))
        .route("/stops/{id}/arrivals", get(arrivals))
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
    let mtr = catalog::mtr_stops();
    remember(&app, mtr).await;
    let kmb = catalog::kmb_stops(&app.http).await;
    eprintln!("kmb stops {}", kmb.len());
    remember(&app, kmb).await;
    let taxi = catalog::taxi_stands(&app.http).await;
    eprintln!("taxi stands {}", taxi.len());
    remember(&app, taxi).await;
    let http = app.http.clone();
    let citybus_task = tokio::spawn(async move { catalog::citybus_stops(&http).await });
    let http = app.http.clone();
    let minibus_task = tokio::spawn(async move { catalog::minibus_stops(&http).await });
    let citybus = citybus_task.await.unwrap_or_default();
    eprintln!("citybus stops {}", citybus.len());
    remember(&app, citybus).await;
    if let Ok((minibus, routes)) = minibus_task.await {
        eprintln!("minibus stops {}", minibus.len());
        *app.gmb_routes.write().await = routes;
        remember(&app, minibus).await;
    }
    eprintln!("catalogue ready {}", app.stops.read().await.len());
}

async fn remember(app: &App, stops: Vec<Stop>) {
    if stops.is_empty() {
        return;
    }
    let mut redis = app.redis.clone();
    let mut pipe = redis::pipe();
    pipe.atomic();
    for stop in &stops {
        let body = json!({
            "mode": stop.mode,
            "name": stop.name,
            "latitude": stop.latitude,
            "longitude": stop.longitude,
        });
        pipe.cmd("SET")
            .arg(format!("stop:{}", stop.id))
            .arg(body.to_string())
            .ignore();
    }
    if pipe.query_async::<()>(&mut redis).await.is_err() {
        eprintln!("redis stop write failed");
    }
    let mut all = app.stops.write().await;
    let mut index = app.by_id.write().await;
    for stop in stops {
        index.insert(stop.id.clone(), stop.clone());
        all.push(stop);
    }
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
    let allowed: Option<Vec<&str>> = bounds
        .modes
        .as_deref()
        .map(|modes| modes.split(',').map(str::trim).filter(|mode| !mode.is_empty()).collect());
    let stops = app.stops.read().await;
    let mut matched = Vec::new();
    for stop in stops.iter() {
        if let Some(modes) = &allowed {
            if !modes.contains(&stop.mode.as_str()) {
                continue;
            }
        }
        if !in_box(stop.latitude, stop.longitude, bounds.south, bounds.west, bounds.north, bounds.east) {
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
    let Some(stop) = app.by_id.read().await.get(&id).cloned() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "unknown stop"})),
        )
            .into_response();
    };
    if stop.mode == "taxi" {
        let snapshot = Snapshot {
            fetched_at: String::new(),
            live: false,
            status: None,
            note: Some("no-arrivals".to_string()),
            rows: Vec::new(),
        };
        return Json(snapshot).into_response();
    }
    let key = format!("arrivals:{id}");
    let mut redis = app.redis.clone();
    let cached: Option<String> = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut redis)
        .await
        .unwrap_or(None);
    if let Some(cached) = cached {
        if let Ok(snapshot) = serde_json::from_str::<Snapshot>(&cached) {
            return Json(snapshot).into_response();
        }
    }
    let fetched = match stop.mode.as_str() {
        "mtr" => mtr_arrivals(&app.http, &stop).await,
        "bus" => bus_arrivals(&app.http, &stop).await,
        "minibus" => minibus_arrivals(&app, &stop).await,
        _ => None,
    };
    let Some(snapshot) = fetched else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "snapshot is gone"})),
        )
            .into_response();
    };
    let body = serde_json::to_string(&snapshot).unwrap_or_default();
    let _: Result<(), _> = redis::cmd("SET")
        .arg(&key)
        .arg(body)
        .arg("EX")
        .arg(ETA_TTL_SECS)
        .query_async(&mut redis)
        .await;
    Json(snapshot).into_response()
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
        let route = item.get("route").and_then(|value| value.as_str()).unwrap_or("");
        let destination = item
            .get("dest_tc")
            .or_else(|| item.get("dest"))
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let eta = item.get("eta").and_then(|value| value.as_str()).unwrap_or("");
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
            .unwrap_or_else(|| route_id.map(|id| id.to_string()).unwrap_or_default());
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
        let url = format!("https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line={line}&sta={code}");
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
                    let dest = train.get("dest").and_then(|value| value.as_str()).unwrap_or("");
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
    let label = match code {
        "TSW" => "荃灣",
        "CEN" => "中環",
        "TIK" => "調景嶺",
        "POA" => "寶琳",
        "LHP" => "康城",
        "WHA" => "黃埔",
        "TUC" => "東涌",
        "HOK" => "香港",
        "AWE" => "博覽館",
        "CHW" => "柴灣",
        "KET" => "堅尼地城",
        "SOH" => "海怡半島",
        "ADM" => "金鐘",
        "LMC" => "落馬洲",
        "TUM" => "屯門",
        "WKS" => "烏溪沙",
        _ => code,
    };
    label.to_string()
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
