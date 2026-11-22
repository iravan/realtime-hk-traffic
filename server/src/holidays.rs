use redis::aio::ConnectionManager;
use serde_json::Value;
use std::sync::Mutex;
use std::time::Instant;

const HOLIDAY_URL: &str = "https://www.1823.gov.hk/common/ical/en.json";
const REFRESH_DEBOUNCE_SECS: u64 = 24 * 60 * 60;

static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

pub async fn fetch_holidays(http: &reqwest::Client, redis: ConnectionManager) -> Vec<String> {
    let key = "holidays:dates";
    let refresh_key = "holidays:refreshed";

    // Redis first: return cached data instantly if available.
    let mut conn = redis.clone();
    let cached: Option<String> = redis::cmd("GET")
        .arg(key)
        .query_async(&mut conn)
        .await
        .ok()
        .flatten();

    if let Some(body) = cached {
        if let Ok(dates) = serde_json::from_str::<Vec<String>>(&body) {
            // Debounced background refresh.
            let mut conn2 = redis.clone();
            let needs_refresh: bool = redis::cmd("EXISTS")
                .arg(refresh_key)
                .query_async::<i64>(&mut conn2)
                .await
                .unwrap_or(1)
                == 0;

            if needs_refresh {
                let mut conn3 = redis.clone();
                let _: Result<(), _> = redis::cmd("SET")
                    .arg(refresh_key)
                    .arg("1")
                    .arg("EX")
                    .arg(REFRESH_DEBOUNCE_SECS)
                    .query_async(&mut conn3)
                    .await;

                let http = http.clone();
                let redis = redis.clone();
                tokio::spawn(async move {
                    refresh_holidays(&http, redis).await;
                });
            }

            return dates;
        }
    }

    // No cache: fetch synchronously.
    refresh_holidays(http, redis).await
}

async fn refresh_holidays(http: &reqwest::Client, redis: ConnectionManager) -> Vec<String> {
    let key = "holidays:dates";
    let refresh_key = "holidays:refreshed";

    let mut dates = Vec::new();
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        let result = match http.get(HOLIDAY_URL).send().await {
            Ok(response) if response.status().is_success() => {
                let text = response.text().await.unwrap_or_default();
                let text = text.trim_start_matches('\u{feff}');
                match serde_json::from_str::<Value>(text) {
                    Ok(data) => {
                        let mut d = Vec::new();
                        let events = data
                            .get("vcalendar")
                            .and_then(|v| v.get(0))
                            .and_then(|c| c.get("vevent"))
                            .and_then(|e| e.as_array())
                            .cloned()
                            .unwrap_or_default();
                        for event in events {
                            if let Some(dtstart) = event.get("dtstart") {
                                if let Some(date_str) = dtstart.get(0).and_then(|v| v.as_str()) {
                                    if date_str.len() == 8 {
                                        d.push(format!(
                                            "{}-{}-{}",
                                            &date_str[0..4],
                                            &date_str[4..6],
                                            &date_str[6..8]
                                        ));
                                    }
                                }
                            }
                        }
                        if !d.is_empty() {
                            d
                        } else {
                            continue;
                        }
                    }
                    Err(_) => continue,
                }
            }
            _ => continue,
        };
        dates = result;
        break;
    }

    if let Ok(body) = serde_json::to_string(&dates) {
        let mut conn = redis.clone();
        let _: Result<(), _> = redis::cmd("SET")
            .arg(key)
            .arg(&body)
            .query_async(&mut conn)
            .await;
        let mut conn2 = redis.clone();
        let _: Result<(), _> = redis::cmd("SET")
            .arg(refresh_key)
            .arg("1")
            .arg("EX")
            .arg(REFRESH_DEBOUNCE_SECS)
            .query_async(&mut conn2)
            .await;
    }

    // Also update in-memory cache
    {
        let mut guard = CACHE.lock().unwrap();
        *guard = Some((Instant::now(), dates.clone()));
    }

    dates
}
