use serde_json::{json, Value};

const TIMETABLE_REFRESH_DEBOUNCE_SECS: u64 = 24 * 60 * 60;

// Sun Ferry publishes one CSV per corridor on data.gov.hk. Each row is one
// sailing: direction, service date (day type), service hour, remark.
const SUN_CENTRAL_CHEUNG_CHAU: &str =
    "https://www.sunferry.com.hk/eta/timetable/SunFerry_central_cheungchau_timetable_eng.csv";
const SUN_CENTRAL_MUI_WO: &str =
    "https://www.sunferry.com.hk/eta/timetable/SunFerry_central_muiwo_timetable_eng.csv";
const SUN_INTER_ISLANDS: &str =
    "https://www.sunferry.com.hk/eta/timetable/SunFerry_interislands_timetable_eng.csv";
const SUN_NORTH_POINT_HUNG_HOM: &str =
    "https://www.sunferry.com.hk/eta/timetable/SunFerry_northpoint_hunghom_timetable_eng.csv";
const SUN_NORTH_POINT_KOWLOON_CITY: &str =
    "https://www.sunferry.com.hk/eta/timetable/SunFerry_northpoint_kowlooncity_timetable_eng.csv";

// Hong Kong & Kowloon Ferry publishes one CSV per route and direction. Each
// row lists the sessions for Monday to Saturday and for Sunday and holidays.
const HKKF_TIMETABLE: &str = "https://www.hkkfeta.com/opendata/time_table";

// Star Ferry publishes frequency bands rather than sailings: each row is a time
// band with its headway in minutes.
const STAR_CENTRAL_TSIM_SHA_TSUI: &str = "https://www.starferry.com.hk/sites/default/files/upload/open_data/csv/ferry_sf_central_tsimshatsui_timetable_eng.csv";
const STAR_WAN_CHAI_TSIM_SHA_TSUI: &str = "https://www.starferry.com.hk/sites/default/files/upload/open_data/csv/ferry_sf_wanchai_tsimshatsui_timetable_eng.csv";

// Tsui Wah publishes one CSV for its services, one row per sailing: route
// start (`A` Aberdeen, `Y` Yung Shue Wan), day type, and time.
const TSUI_WAH_TIMETABLE: &str = "https://www.traway.com.hk/govdata/time.csv";

// Chuen Kee Ferry publishes one CSV for Aberdeen - Sok Kwu Wan via Mo Tat Wan.
const CHUEN_KEE_TIMETABLE: &str = "https://ferry.com.hk/opendataV/time.csv";

#[derive(Clone)]
struct Sailing {
    direction: String,
    day: String,
    time: String,
    remark: String,
}

// One sailing as the sheet shows it: where it goes, which day type, and when.
#[derive(Clone)]
struct Session {
    destination: String,
    day: String,
    time: String,
    remark: String,
    operator: &'static str,
}

// A time band with its headway, for operators that publish frequencies.
#[derive(Clone)]
struct Band {
    destination: String,
    day: String,
    from: String,
    to: String,
    frequency: String,
    operator: &'static str,
}

// Redis-backed cache for a single URL: keep forever, refresh debounced by 24h,
// only overwrite on success.
async fn cached_text_redis(http: &reqwest::Client, redis: ConnectionManager, url: &str) -> Option<String> {
    let key = format!("csv:{}", url);
    let refresh_key = format!("csv:{}:refreshed", url);

    // Redis first.
    let mut conn = redis.clone();
    let cached: Option<String> = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut conn)
        .await
        .ok()
        .flatten();

    if let Some(text) = cached {
        // Debounced background refresh.
        let mut conn2 = redis.clone();
        let needs_refresh: bool = redis::cmd("EXISTS")
            .arg(&refresh_key)
            .query_async::<i64>(&mut conn2)
            .await
            .unwrap_or(1) == 0;

        if needs_refresh {
            let mut conn3 = redis.clone();
            let _: Result<(), _> = redis::cmd("SET")
                .arg(&refresh_key)
                .arg("1")
                .arg("EX")
                .arg(TIMETABLE_REFRESH_DEBOUNCE_SECS)
                .query_async(&mut conn3)
                .await;

            let http = http.clone();
            let redis = redis.clone();
            let url = url.to_string();
            tokio::spawn(async move {
                for attempt in 0..3 {
                    if attempt > 0 {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                    if let Ok(response) = http.get(&url).send().await {
                        if response.status().is_success() {
                            if let Ok(text) = response.text().await {
                                if !text.is_empty() {
                                    let mut conn = redis.clone();
                                    let _: Result<(), _> = redis::cmd("SET")
                                        .arg(format!("csv:{}", url))
                                        .arg(&text)
                                        .query_async(&mut conn)
                                        .await;
                                    break;
                                }
                            }
                        }
                    }
                }
            });
        }

        return Some(text);
    }

    // No cache: fetch synchronously with retries.
    let mut text = None;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        if let Ok(response) = http.get(url).send().await {
            if response.status().is_success() {
                if let Ok(body) = response.text().await {
                    if !body.is_empty() {
                        text = Some(body);
                        break;
                    }
                }
            }
        }
    }
    let text = text?;

    let mut conn = redis.clone();
    let _: Result<(), _> = redis::cmd("SET")
        .arg(&key)
        .arg(&text)
        .query_async(&mut conn)
        .await;
    let mut conn2 = redis.clone();
    let _: Result<(), _> = redis::cmd("SET")
        .arg(&refresh_key)
        .arg("1")
        .arg("EX")
        .arg(TIMETABLE_REFRESH_DEBOUNCE_SECS)
        .query_async(&mut conn2)
        .await;

    Some(text)
}

// `3:00 a.m.`, `12:30 p.m.` and Star Ferry's `6:30am` become `03:00`, `12:30`
// and `06:30`.
fn clock_24(value: &str) -> Option<String> {
    let value = value.trim().to_lowercase().replace('.', "");
    let value = match value.strip_suffix("am").or_else(|| value.strip_suffix("pm")) {
        Some(rest) if !rest.ends_with(' ') => format!("{} {}", rest, &value[value.len() - 2..]),
        _ => value,
    };
    if let Some(clock) = value.strip_suffix(" noon") {
        return (clock_24_hhmm(clock)? == "12:00").then(|| "12:00".to_string());
    }
    let (clock, period) = value.rsplit_once(' ')?;
    let (hour, minute) = clock.split_once(':')?;
    let mut hour: u32 = hour.parse().ok()?;
    if hour > 12 || minute.len() != 2 {
        return None;
    }
    match period {
        "am" if hour == 12 => hour = 0,
        "pm" if hour != 12 => hour += 12,
        "am" | "pm" => {}
        _ => return None,
    }
    Some(format!("{hour:02}:{minute}"))
}

fn parse_sun_sailings(text: &str) -> Vec<Sailing> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            if fields.len() < 3 {
                return None;
            }
            Some(Sailing {
                direction: fields[0].to_string(),
                day: fields[1].to_string(),
                time: clock_24(fields[2])?,
                remark: fields.get(3).copied().unwrap_or("").to_string(),
            })
        })
        .collect()
}

// The pier a sailing leaves from, using the confirmed rules: all Central to
// Cheung Chau sailings leave Central Pier No. 5, the 03:00 Central to Mui Wo
// sailing leaves Pier No. 5 as well, and the other Central to Mui Wo sailings
// leave Pier No. 6.
fn sun_sailings_for_pier(
    pier: &str,
    cheung_chau: &[Sailing],
    mui_wo: &[Sailing],
    other: &[Sailing],
) -> Vec<Sailing> {
    let central: Vec<Sailing> = match pier {
        "101102" => cheung_chau
            .iter()
            .filter(|s| s.direction == "Central to Cheung Chau")
            .cloned()
            .chain(
                mui_wo
                    .iter()
                    .filter(|s| s.direction == "Central to Mui Wo" && s.time == "03:00")
                    .cloned(),
            )
            .collect(),
        "101108" => mui_wo
            .iter()
            .filter(|s| s.direction == "Central to Mui Wo" && s.time != "03:00")
            .cloned()
            .collect(),
        "101101" => cheung_chau
            .iter()
            .filter(|s| s.direction == "Cheung Chau to Central")
            .cloned()
            .collect(),
        "101107" => mui_wo
            .iter()
            .filter(|s| s.direction == "Mui Wo to Central")
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    let islands = other
        .iter()
        .filter(|s| origin_pier(&s.direction) == Some(pier))
        .cloned();
    central.into_iter().chain(islands).collect()
}

// "Central to Mui Wo" leaves Central and reaches Mui Wo, so the destination is
// the part after " to ".
fn destination_of(direction: &str) -> String {
    let english = direction
        .split_once(" to ")
        .map(|(_, to)| to.to_string())
        .unwrap_or_else(|| direction.to_string());
    bilingual_destination(&english)
}

// The timetable CSVs carry English destination names. The colour table and the
// bilingual name splitter both expect "Chinese English", so map each known
// destination to that form here.
fn bilingual_destination(english: &str) -> String {
    match english.trim() {
        "Cheung Chau" => "長洲 Cheung Chau".to_string(),
        "Mui Wo" => "梅窩 Mui Wo".to_string(),
        "Sok Kwu Wan" => "南丫島 (索罟灣) Sok Kwu Wan".to_string(),
        "Yung Shue Wan" => "南丫島 (榕樹灣) Yung Shue Wan".to_string(),
        "Peng Chau" => "坪洲 Peng Chau".to_string(),
        "Hei Ling Chau" => "喜靈洲 Hei Ling Chau".to_string(),
        "Chi Ma Wan" => "芝麻灣 Chi Ma Wan".to_string(),
        "Central" => "中環 Central".to_string(),
        "Tsim Sha Tsui" => "尖沙咀 Tsim Sha Tsui".to_string(),
        "Wanchai" | "Wan Chai" => "灣仔 Wan Chai".to_string(),
        "Hung Hom" => "紅磡 Hung Hom".to_string(),
        "Kowloon City" => "九龍城 Kowloon City".to_string(),
        "North Point" => "北角 North Point".to_string(),
        "Aberdeen" => "香港仔 Aberdeen".to_string(),
        other => other.to_string(),
    }
}

// Inter-island and North Point corridors each leave from one pier per origin.
// The inter-island CSV spells Cheung Chau two ways and the names carry stray
// spaces, so the origin is normalised before matching.
fn origin_pier(direction: &str) -> Option<&'static str> {
    let origin = direction.split_once(" to ")?.0;
    let origin = origin.split_whitespace().collect::<Vec<_>>().join(" ");
    match origin.as_str() {
        "Cheung Chau" | "Chueung Chau" => Some("101101"),
        "Mui Wo" => Some("101107"),
        "Peng Chau" => Some("101109"),
        "Chi Ma Wan" => Some("101115"),
        "North Point" => Some("101110"),
        "Hung Hom" => Some("101111"),
        "Kowloon City" => Some("101112"),
        _ => None,
    }
}

// RFC 4180-style records: quoted fields may hold commas and line breaks.
fn csv_records(text: &str) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut record = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();
    while let Some(c) = chars.next() {
        match (quoted, c) {
            (true, '"') if chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            (true, '"') => quoted = false,
            (true, _) => field.push(c),
            (false, '"') => quoted = true,
            (false, ',') => record.push(std::mem::take(&mut field)),
            (false, '\n') | (false, '\r') => {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                record.push(std::mem::take(&mut field));
                records.push(std::mem::take(&mut record));
            }
            (false, _) => field.push(c),
        }
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    records
}

// A session list cell looks like `['07:20', '*06:30', '{02:30}', '^23:30', '']`.
// HKKF's remarks define the markers: `{ }` only on Saturdays, `^` the last
// sailing, `#` one-day advance booking for large freight, `*` small freight
// only, and `@` an optional service. Each one is kept as the remark code.
fn hkkf_sessions(cell: &str) -> Vec<(String, String)> {
    cell.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split(',')
        .filter_map(|token| {
            let token = token.trim().trim_matches('\'').trim();
            let (remark, clock) = if let Some(inner) = token
                .strip_prefix('{')
                .and_then(|rest| rest.strip_suffix('}'))
            {
                ("{}".to_string(), inner)
            } else if let Some(marker) = token.chars().next().filter(|c| "@^#*".contains(*c)) {
                (marker.to_string(), &token[marker.len_utf8()..])
            } else {
                (String::new(), token)
            };
            Some((clock_24_hhmm(clock)?, remark))
        })
        .collect()
}

fn clock_24_hhmm(value: &str) -> Option<String> {
    let (hour, minute) = value.trim().split_once(':')?;
    let hour: u32 = hour.parse().ok()?;
    if hour > 23 || minute.len() != 2 || minute.parse::<u32>().ok()? > 59 {
        return None;
    }
    Some(format!("{hour:02}:{minute}"))
}

fn parse_hkkf_sessions(text: &str, destination: &str) -> Vec<Session> {
    let records = csv_records(text);
    let Some(header) = records.first() else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    for record in records.iter().skip(1) {
        // The last two columns are the Monday to Saturday and Sunday/holiday lists.
        for column in [11usize, 12] {
            let (Some(day), Some(cell)) = (header.get(column), record.get(column)) else {
                continue;
            };
            let day = day.split('/').next().unwrap_or(day).trim().to_string();
            for (time, remark) in hkkf_sessions(cell) {
                sessions.push(Session {
                    destination: bilingual_destination(destination),
                    day: day.clone(),
                    time,
                    remark,
                    operator: "hkkf",
                });
            }
        }
    }
    sessions
}

// Which HKKF route and direction leaves each pier, as in `ferry-departures.json`.
// Outbound leaves the route's origin, inbound returns to it.
fn hkkf_sources(pier: &str) -> &'static [(u32, &'static str, &'static str)] {
    match pier {
        "101126" => &[(1, "outbound", "Sok Kwu Wan"), (2, "outbound", "Yung Shue Wan")],
        "101348" => &[(1, "inbound", "Central")],
        "101123" => &[(2, "inbound", "Central")],
        "101108" => &[(3, "outbound", "Peng Chau")],
        "101109" => &[(3, "inbound", "Central"), (4, "outbound", "Hei Ling Chau")],
        "101324" => &[(4, "inbound", "Peng Chau")],
        _ => &[],
    }
}

// Tsui Wah runs Aberdeen to Yung Shue Wan. Each row starts at one end, so the
// pier and the destination both follow from the route start.
fn tsui_wah_leg(route_start: &str) -> Option<(&'static str, &'static str)> {
    match route_start {
        "A" => Some(("101125", "Yung Shue Wan")),
        "Y" => Some(("101123", "Aberdeen")),
        _ => None,
    }
}

// The day codes are not defined in the file. `W` is read as weekdays, `S` as
// Saturday and `H` as public holidays.
fn tsui_wah_day(date_type: &str) -> Option<&'static str> {
    match date_type {
        "W" => Some("Weekdays"),
        "S" => Some("Saturday"),
        "H" => Some("Public holidays"),
        _ => None,
    }
}

fn parse_tsui_wah_sessions(text: &str, pier: &str) -> Vec<Session> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            let [_, date_type, route_start, time] = fields[..] else {
                return None;
            };
            let (leg_pier, destination) = tsui_wah_leg(route_start)?;
            if leg_pier != pier {
                return None;
            }
            Some(Session {
                destination: bilingual_destination(destination),
                day: tsui_wah_day(date_type)?.to_string(),
                time: clock_24_hhmm(time)?,
                remark: String::new(),
                operator: "tsuiwah",
            })
        })
        .collect()
}

// Star Ferry's place names are `Central`, `Tsim Sha Tsui` and `Wanchai`. Its
// boarding piers are Central Pier No. 7, Kowloon Point (Tsim Sha Tsui) and Wan
// Chai Ferry Pier.
fn star_origin_pier(direction: &str) -> Option<&'static str> {
    let origin = direction.split_once(" to ")?.0;
    match origin.trim() {
        "Central" => Some("101339"),
        "Tsim Sha Tsui" => Some("101119"),
        "Wanchai" | "Wan Chai" => Some("101118"),
        _ => None,
    }
}

fn parse_star_bands(text: &str, pier: &str) -> Vec<Band> {
    let records = csv_records(text);
    let Some(start) = records
        .iter()
        .position(|record| record.first().map(String::as_str) == Some("Direction"))
    else {
        return Vec::new();
    };
    records[start + 1..]
        .iter()
        .filter_map(|record| {
            let [direction, day, hours, frequency] = record.get(..4)? else {
                return None;
            };
            if star_origin_pier(direction)? != pier {
                return None;
            }
            let (from, to) = hours.split_once('-')?;
            Some(Band {
                destination: destination_of(direction),
                day: day.split_whitespace().collect::<Vec<_>>().join(" "),
                from: clock_24(from)?,
                to: clock_24(to)?,
                frequency: frequency
                    .split("--")
                    .map(str::trim)
                    .collect::<Vec<_>>()
                    .join("–"),
                operator: "star",
            })
        })
        .collect()
}

// Chuen Kee Ferry runs Aberdeen to Sok Kwu Wan via Mo Tat Wan. Each row starts
// at one end, so the pier and the destination both follow from the route start.
fn chuen_kee_leg(route_start: &str) -> Option<(&'static str, &'static str)> {
    match route_start {
        "A" => Some(("101125", "Sok Kwu Wan")),
        "S" => Some(("101124", "Aberdeen")),
        _ => None,
    }
}

fn chuen_kee_day(date_type: &str) -> Option<&'static str> {
    match date_type {
        "W" => Some("Weekdays"),
        "WW" => Some("Saturday"),
        "S" => Some("Sundays and public holidays"),
        _ => None,
    }
}

fn parse_chuen_kee_sessions(text: &str, pier: &str) -> Vec<Session> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(',').map(str::trim).collect();
            let [_, date_type, route_start, time] = fields[..] else {
                return None;
            };
            let (leg_pier, destination) = chuen_kee_leg(route_start)?;
            if leg_pier != pier {
                return None;
            }
            Some(Session {
                destination: bilingual_destination(destination),
                day: chuen_kee_day(date_type)?.to_string(),
                time: clock_24_hhmm(time)?,
                remark: String::new(),
                operator: "chuenkee",
            })
        })
        .collect()
}

fn sun_sessions(sailings: Vec<Sailing>) -> Vec<Session> {
    let mut sessions = Vec::new();
    for s in sailings {
        let destination = destination_of(&s.direction);
        // Sun Ferry's "Mondays to Saturdays except public holidays" group mixes
        // weekday and Saturday sailings. Split it so the sheet can show separate
        // Monday-to-Friday and Saturday tabs. Remark 2 is weekday-only, remark 3
        // (and 4, which inherits it) is Saturday-only; the rest run on both.
        if s.day == "Mondays to Saturdays except public holidays" {
            let weekday_only = s.remark == "2";
            let saturday_only = s.remark == "3" || s.remark == "4";
            if !saturday_only {
                sessions.push(Session {
                    destination: destination.clone(),
                    day: "Mondays to Fridays except public holidays".to_string(),
                    time: s.time.clone(),
                    remark: s.remark.clone(),
                    operator: "sun",
                });
            }
            if !weekday_only {
                sessions.push(Session {
                    destination,
                    day: "Saturdays except public holidays".to_string(),
                    time: s.time,
                    remark: s.remark,
                    operator: "sun",
                });
            }
        } else {
            sessions.push(Session {
                destination,
                day: s.day,
                time: s.time,
                remark: s.remark,
                operator: "sun",
            });
        }
    }
    sessions
}

use redis::aio::ConnectionManager;

pub async fn for_pier(http: &reqwest::Client, redis: ConnectionManager, pier: &str) -> Value {
    let key = format!("timetable:v2:{pier}");
    let refresh_key = format!("timetable:v2:{pier}:refreshed");

    // Redis first: return cached data instantly if available.
    let mut conn = redis.clone();
    let cached: Option<String> = redis::cmd("GET")
        .arg(&key)
        .query_async(&mut conn)
        .await
        .ok()
        .flatten();

    if let Some(body) = cached {
        if let Ok(value) = serde_json::from_str::<Value>(&body) {
            // Debounced background refresh: only trigger if the refresh key
            // has expired (i.e., more than 24 hours since last refresh).
            let mut conn2 = redis.clone();
            let needs_refresh: bool = redis::cmd("EXISTS")
                .arg(&refresh_key)
                .query_async::<i64>(&mut conn2)
                .await
                .unwrap_or(1) == 0;

            if needs_refresh {
                // Set the refresh key with 24h TTL to debounce.
                let mut conn3 = redis.clone();
                let _: Result<(), _> = redis::cmd("SET")
                    .arg(&refresh_key)
                    .arg("1")
                    .arg("EX")
                    .arg(TIMETABLE_REFRESH_DEBOUNCE_SECS)
                    .query_async(&mut conn3)
                    .await;

                // Spawn background refresh.
                let http = http.clone();
                let redis = redis.clone();
                let pier = pier.to_string();
                tokio::spawn(async move {
                    refresh_timetable(&http, redis, &pier).await;
                });
            }

            return value;
        }
    }

    // No cache: fetch synchronously.
    refresh_timetable(http, redis, pier).await
}

async fn refresh_timetable(http: &reqwest::Client, redis: ConnectionManager, pier: &str) -> Value {
    let key = format!("timetable:v2:{pier}");
    let refresh_key = format!("timetable:v2:{pier}:refreshed");

    let cheung_chau_text = cached_text_redis(http, redis.clone(), SUN_CENTRAL_CHEUNG_CHAU).await.unwrap_or_default();
    let mui_wo_text = cached_text_redis(http, redis.clone(), SUN_CENTRAL_MUI_WO).await.unwrap_or_default();
    let cheung_chau = parse_sun_sailings(&cheung_chau_text);
    let mui_wo = parse_sun_sailings(&mui_wo_text);
    let mut other = Vec::new();
    for url in [SUN_INTER_ISLANDS, SUN_NORTH_POINT_HUNG_HOM, SUN_NORTH_POINT_KOWLOON_CITY] {
        let text = cached_text_redis(http, redis.clone(), url).await.unwrap_or_default();
        other.extend(parse_sun_sailings(&text));
    }
    let mut sessions = sun_sessions(sun_sailings_for_pier(pier, &cheung_chau, &mui_wo, &other));
    for (route, direction, destination) in hkkf_sources(pier) {
        let url = format!("{HKKF_TIMETABLE}/{route}/{direction}");
        if let Some(text) = cached_text_redis(http, redis.clone(), &url).await {
            sessions.extend(parse_hkkf_sessions(&text, destination));
        }
    }

    if let Some(text) = cached_text_redis(http, redis.clone(), TSUI_WAH_TIMETABLE).await {
        sessions.extend(parse_tsui_wah_sessions(&text, pier));
    }

    // Chuen Kee: cache the CSV in Redis forever, refresh debounced by 24h,
    // only overwrite on success.
    match cached_text_redis(http, redis.clone(), CHUEN_KEE_TIMETABLE).await {
        Some(text) => {
            sessions.extend(parse_chuen_kee_sessions(&text, pier));
        }
        None => {
            eprintln!("Chuen Kee cached_text_redis returned None");
        }
    }

    let mut bands = Vec::new();
    for url in [STAR_CENTRAL_TSIM_SHA_TSUI, STAR_WAN_CHAI_TSIM_SHA_TSUI] {
        let text = cached_text_redis(http, redis.clone(), url).await.unwrap_or_default();
        bands.extend(parse_star_bands(&text, pier));
    }

    let value = group(sessions, bands);
    if let Ok(body) = serde_json::to_string(&value) {
        let mut conn = redis.clone();
        let _: Result<(), _> = redis::cmd("SET")
            .arg(&key)
            .arg(&body)
            .query_async(&mut conn)
            .await;
        let mut conn2 = redis.clone();
        let _: Result<(), _> = redis::cmd("SET")
            .arg(&refresh_key)
            .arg("1")
            .arg("EX")
            .arg(TIMETABLE_REFRESH_DEBOUNCE_SECS)
            .query_async(&mut conn2)
            .await;
    }
    value
}

// A day group holds the sailings it lists and the frequency bands it lists.
type Day = (String, Vec<Value>, Vec<Value>);

fn day_entry<'a>(destinations: &'a mut Vec<(String, Vec<Day>)>, destination: &str, day: &str) -> &'a mut Day {
    let index = match destinations.iter().position(|(name, _)| name == destination) {
        Some(index) => index,
        None => {
            destinations.push((destination.to_string(), Vec::new()));
            destinations.len() - 1
        }
    };
    let days = &mut destinations[index].1;
    let day_index = match days.iter().position(|(name, _, _)| name == day) {
        Some(day_index) => day_index,
        None => {
            days.push((day.to_string(), Vec::new(), Vec::new()));
            days.len() - 1
        }
    };
    &mut days[day_index]
}

fn group(sessions: Vec<Session>, bands: Vec<Band>) -> Value {
    let mut destinations: Vec<(String, Vec<Day>)> = Vec::new();
    for session in sessions {
        let day = day_entry(&mut destinations, &session.destination, &session.day);
        day.1.push(json!({
            "time": session.time,
            "remark": session.remark,
            "operator": session.operator,
        }));
    }
    for band in bands {
        let day = day_entry(&mut destinations, &band.destination, &band.day);
        day.2.push(json!({
            "from": band.from,
            "to": band.to,
            "frequency": band.frequency,
            "operator": band.operator,
        }));
    }
    json!({
        "destinations": destinations
            .into_iter()
            .map(|(destination, days)| json!({
                "destination": destination,
                "days": days
                    .into_iter()
                    .map(|(day, sessions, bands)| json!({
                        "day": day,
                        "sessions": sessions,
                        "bands": bands,
                    }))
                    .collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_converts_am_and_pm_around_noon() {
        assert_eq!(clock_24("12:30 a.m.").as_deref(), Some("00:30"));
        assert_eq!(clock_24("3:00 a.m.").as_deref(), Some("03:00"));
        assert_eq!(clock_24("12:30 p.m.").as_deref(), Some("12:30"));
        assert_eq!(clock_24("1:10 p.m.").as_deref(), Some("13:10"));
        assert_eq!(clock_24("11:30 p.m.").as_deref(), Some("23:30"));
        assert_eq!(clock_24("12:00 noon").as_deref(), Some("12:00"));
    }

    #[test]
    fn pier_five_takes_only_the_three_am_mui_wo_sailing() {
        let mui_wo = parse_sun_sailings(
            "Direction,Service Date,Service Hour,Remark\n\
             Central to Mui Wo,Mondays to Fridays except public holidays,3:00 a.m.,\n\
             Central to Mui Wo,Mondays to Fridays except public holidays,6:10 a.m.,1\n",
        );
        let pier_five = sun_sailings_for_pier("101102", &[], &mui_wo, &[]);
        assert_eq!(pier_five.len(), 1);
        assert_eq!(pier_five[0].time, "03:00");
        let pier_six = sun_sailings_for_pier("101108", &[], &mui_wo, &[]);
        assert_eq!(pier_six.len(), 1);
        assert_eq!(pier_six[0].time, "06:10");
    }

    #[test]
    fn island_and_north_point_origins_map_to_their_pier() {
        assert_eq!(origin_pier("Chueung Chau to Mui Wo"), Some("101101"));
        assert_eq!(origin_pier("Mui Wo  to Chi Ma Wan"), Some("101107"));
        assert_eq!(origin_pier("North Point to Hung Hom"), Some("101110"));
        assert_eq!(origin_pier("Hung Hom to North Point"), Some("101111"));
        assert_eq!(origin_pier("Central to Mui Wo"), None);
    }

    #[test]
    fn star_bands_read_the_origin_pier_and_frequency_range() {
        let text = "Ferry Service Details,,,\n\
                    Operator:,\"The \"\"Star\"\" Ferry\",,\n\
                    Boarding location:,\"Central: Central Pier No.7\nTsim Sha Tsui: Kowloon Point\",,\n\
                    ,,,\n\
                    Direction,Service Date,Service Hour,\"Frequency\n(minutes)\"\n\
                    Central to Tsim Sha Tsui,Mon – Fri  (Except Public Holidays),6:30am-7:25am,10 -- 12\n\
                    Tsim Sha Tsui to Central,\"Sat, Sun & Public Holidays\",10:30pm-11:30pm,10 -- 12\n";
        let central = parse_star_bands(text, "101339");
        assert_eq!(central.len(), 1);
        assert_eq!(central[0].destination, "尖沙咀 Tsim Sha Tsui");
        assert_eq!(central[0].day, "Mon – Fri (Except Public Holidays)");
        assert_eq!((central[0].from.as_str(), central[0].to.as_str()), ("06:30", "07:25"));
        assert_eq!(central[0].frequency, "10–12");
        let tst = parse_star_bands(text, "101119");
        assert_eq!(tst.len(), 1);
        assert_eq!(tst[0].destination, "中環 Central");
        assert_eq!((tst[0].from.as_str(), tst[0].to.as_str()), ("22:30", "23:30"));
    }

    #[test]
    fn tsui_wah_rows_leave_from_their_route_start() {
        let text = "route_type,date_type,route_start,time\n\
                    L,W,A,6:00\n\
                    L,W,Y,6:40\n\
                    L,S,A,7:20\n";
        let aberdeen = parse_tsui_wah_sessions(text, "101125");
        let shape: Vec<(&str, &str, &str)> = aberdeen
            .iter()
            .map(|s| (s.day.as_str(), s.time.as_str(), s.destination.as_str()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("Weekdays", "06:00", "南丫島 (榕樹灣) Yung Shue Wan"),
                ("Saturday", "07:20", "南丫島 (榕樹灣) Yung Shue Wan"),
            ]
        );
        let yung_shue_wan = parse_tsui_wah_sessions(text, "101123");
        assert_eq!(yung_shue_wan.len(), 1);
        assert_eq!(yung_shue_wan[0].destination, "香港仔 Aberdeen");
    }

    #[test]
    fn hkkf_cell_keeps_every_session_with_its_marker() {
        let sessions = hkkf_sessions("['07:20', '@12:50', '^23:30', '*06:30', '{02:30}', '#11:00', '']");
        assert_eq!(
            sessions,
            vec![
                ("07:20".to_string(), String::new()),
                ("12:50".to_string(), "@".to_string()),
                ("23:30".to_string(), "^".to_string()),
                ("06:30".to_string(), "*".to_string()),
                ("02:30".to_string(), "{}".to_string()),
                ("11:00".to_string(), "#".to_string()),
            ]
        );
    }

    #[test]
    fn hkkf_csv_reads_both_day_columns_with_quoted_commas() {
        let text = "\u{feff}route id,direction,origin_en,a,b,destination_en,c,d,remarks_en,e,f,Monday to Saturday/星期,Sunday and Public Holidays/星期\n\
                    1,outbound,Central,中環,中环,Sok Kwu Wan,索罟灣,索罟湾,\"x, y\",,,\"['07:20', '^23:30']\",\"['08:00']\"\n";
        let sessions = parse_hkkf_sessions(text, "Sok Kwu Wan");
        let shape: Vec<(&str, &str, &str)> = sessions
            .iter()
            .map(|s| (s.day.as_str(), s.time.as_str(), s.remark.as_str()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("Monday to Saturday", "07:20", ""),
                ("Monday to Saturday", "23:30", "^"),
                ("Sunday and Public Holidays", "08:00", ""),
            ]
        );
    }
}
