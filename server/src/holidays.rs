use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const HOLIDAY_URL: &str = "https://www.1823.gov.hk/common/ical/en.json";
const CACHE_TTL: Duration = Duration::from_secs(365 * 24 * 60 * 60);

static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

pub async fn fetch_holidays(http: &reqwest::Client) -> Vec<String> {
    // Check in-memory cache
    {
        let guard = CACHE.lock().unwrap();
        if let Some((at, dates)) = guard.as_ref() {
            if at.elapsed() < CACHE_TTL {
                return dates.clone();
            }
        }
    }

    // Fetch from 1823.gov.hk
    let dates = match http.get(HOLIDAY_URL).send().await {
        Ok(response) if response.status().is_success() => {
            match response.json::<Value>().await {
                Ok(data) => {
                    let mut dates = Vec::new();
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
                                    let formatted = format!(
                                        "{}-{}-{}",
                                        &date_str[0..4],
                                        &date_str[4..6],
                                        &date_str[6..8]
                                    );
                                    dates.push(formatted);
                                }
                            }
                        }
                    }
                    dates
                }
                Err(_) => Vec::new(),
            }
        }
        _ => Vec::new(),
    };

    // Cache in memory
    {
        let mut guard = CACHE.lock().unwrap();
        *guard = Some((Instant::now(), dates.clone()));
    }

    dates
}
