use crate::Stop;
use futures::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

pub async fn kmb_stops(http: &reqwest::Client) -> Vec<Stop> {
    let Ok(body) = http
        .get("https://data.etabus.gov.hk/v1/transport/kmb/stop")
        .send()
        .await
    else {
        eprintln!("kmb stop list failed");
        return Vec::new();
    };
    let Ok(parsed) = body.json::<Data<Vec<KmbStop>>>().await else {
        eprintln!("kmb stop list was not json");
        return Vec::new();
    };
    parsed
        .data
        .into_iter()
        .filter_map(|stop| {
            let latitude = stop.lat.parse().ok()?;
            let longitude = stop.long.parse().ok()?;
            Some(
                Stop::new(
                    format!("bus:kmb:{}", stop.stop),
                    "bus",
                    name(&stop.name_tc, &stop.name_en),
                    latitude,
                    longitude,
                )
                .with_names(Some(stop.name_tc), Some(stop.name_en)),
            )
        })
        .collect()
}

pub async fn citybus_stops(http: &reqwest::Client) -> Vec<Stop> {
    let Ok(body) = http
        .get("https://rt.data.gov.hk/v2/transport/citybus/route/CTB")
        .send()
        .await
    else {
        eprintln!("citybus routes failed");
        return Vec::new();
    };
    let Ok(parsed) = body.json::<Data<Vec<CityRoute>>>().await else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    let routes: Vec<String> = parsed.data.into_iter().map(|route| route.route).collect();
    let listed = stream::iter(routes)
        .map(|route| async move {
            let mut found = Vec::new();
            for dir in ["outbound", "inbound"] {
                let url = format!(
                    "https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/{route}/{dir}"
                );
                let Ok(response) = http.get(url).send().await else {
                    continue;
                };
                let Ok(parsed) = response.json::<Data<Vec<CityRouteStop>>>().await else {
                    continue;
                };
                found.extend(parsed.data.into_iter().map(|stop| stop.stop));
            }
            found
        })
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
    for batch in listed {
        ids.extend(batch);
    }
    ids.sort();
    ids.dedup();
    eprintln!("citybus unique stops {}", ids.len());
    stream::iter(ids)
        .map(|id| async move {
            let url = format!("https://rt.data.gov.hk/v2/transport/citybus/stop/{id}");
            let response = http.get(url).send().await.ok()?;
            let parsed = response.json::<Data<CityStop>>().await.ok()?;
            let latitude = parsed.data.lat.parse().ok()?;
            let longitude = parsed.data.long.parse().ok()?;
            Some(
                Stop::new(
                    format!("bus:ctb:{}", parsed.data.stop),
                    "bus",
                    name(&parsed.data.name_tc, &parsed.data.name_en),
                    latitude,
                    longitude,
                )
                .with_names(Some(parsed.data.name_tc), Some(parsed.data.name_en)),
            )
        })
        .buffer_unordered(12)
        .filter_map(|stop| async move { stop })
        .collect()
        .await
}

pub async fn minibus_stops(http: &reqwest::Client) -> (Vec<Stop>, HashMap<i64, String>) {
    let mut route_names = HashMap::new();
    let Ok(body) = http.get("https://data.etagmb.gov.hk/route").send().await else {
        return (Vec::new(), route_names);
    };
    let Ok(parsed) = body.json::<Value>().await else {
        return (Vec::new(), route_names);
    };
    let Some(regions) = parsed
        .pointer("/data/routes")
        .and_then(|value| value.as_object())
    else {
        return (Vec::new(), route_names);
    };
    let mut jobs = Vec::new();
    for (region, codes) in regions {
        let Some(codes) = codes.as_array() else {
            continue;
        };
        for code in codes {
            let Some(code) = code.as_str() else {
                continue;
            };
            jobs.push((region.clone(), code.to_string()));
        }
    }
    let details = stream::iter(jobs)
        .map(|(region, code)| {
            let http = http.clone();
            async move {
                let url = format!("https://data.etagmb.gov.hk/route/{region}/{code}");
                let Ok(response) = http.get(url).send().await else {
                    return Vec::new();
                };
                let Ok(parsed) = response.json::<Value>().await else {
                    return Vec::new();
                };
                let Some(variants) = parsed.get("data").and_then(|value| value.as_array()) else {
                    return Vec::new();
                };
                let mut pairs = Vec::new();
                for variant in variants {
                    let Some(route_id) = variant.get("route_id").and_then(|value| value.as_i64())
                    else {
                        continue;
                    };
                    let Some(directions) =
                        variant.get("directions").and_then(|value| value.as_array())
                    else {
                        continue;
                    };
                    for direction in directions {
                        let Some(seq) = direction.get("route_seq").and_then(|value| value.as_i64())
                        else {
                            continue;
                        };
                        pairs.push((route_id, code.clone(), seq));
                    }
                }
                pairs
            }
        })
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
    let mut pairs = Vec::new();
    for batch in details {
        for (route_id, code, seq) in batch {
            route_names.insert(route_id, code.clone());
            pairs.push((route_id, seq));
        }
    }
    let named = stream::iter(pairs)
        .map(|(route_id, seq)| {
            let http = http.clone();
            async move {
                let url = format!("https://data.etagmb.gov.hk/route-stop/{route_id}/{seq}");
                let Ok(response) = http.get(url).send().await else {
                    return Vec::new();
                };
                let Ok(parsed) = response.json::<Value>().await else {
                    return Vec::new();
                };
                let Some(stops) = parsed
                    .pointer("/data/route_stops")
                    .and_then(|value| value.as_array())
                else {
                    return Vec::new();
                };
                stops
                    .iter()
                    .filter_map(|stop| {
                        let id = stop.get("stop_id")?.as_i64()?;
                        let tc = stop
                            .get("name_tc")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        let en = stop
                            .get("name_en")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        Some((id, name(tc, en)))
                    })
                    .collect::<Vec<_>>()
            }
        })
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
    let mut names = HashMap::new();
    for batch in named {
        for (id, name) in batch {
            names.entry(id).or_insert(name);
        }
    }
    let ids: Vec<i64> = names.keys().copied().collect();
    eprintln!("minibus unique stops {}", ids.len());
    let stops = stream::iter(ids)
        .map(|id| {
            let http = http.clone();
            let label = names.get(&id).cloned().unwrap_or_default();
            async move {
                let url = format!("https://data.etagmb.gov.hk/stop/{id}");
                let response = http.get(url).send().await.ok()?;
                let parsed = response.json::<Value>().await.ok()?;
                let latitude = parsed
                    .pointer("/data/coordinates/wgs84/latitude")?
                    .as_f64()?;
                let longitude = parsed
                    .pointer("/data/coordinates/wgs84/longitude")?
                    .as_f64()?;
                Some(Stop::new(
                    format!("minibus:{id}"),
                    "minibus",
                    if label.is_empty() {
                        id.to_string()
                    } else {
                        label
                    },
                    latitude,
                    longitude,
                ))
            }
        })
        .buffer_unordered(12)
        .filter_map(|stop| async move { stop })
        .collect()
        .await;
    (stops, route_names)
}

pub async fn taxi_stands(http: &reqwest::Client) -> Vec<Stop> {
    let mut stops = Vec::new();
    let mut offset = 0;
    loop {
        let url = format!(
            "https://portal.csdi.gov.hk/server/rest/services/common/td_rcd_1697081907714_17556/FeatureServer/0/query?where=1%3D1&outFields=Location_TC,Location_EN,OBJECTID&outSR=4326&f=geojson&resultRecordCount=200&resultOffset={offset}"
        );
        let Ok(response) = http.get(url).send().await else {
            break;
        };
        let Ok(parsed) = response.json::<Value>().await else {
            break;
        };
        let Some(features) = parsed.get("features").and_then(|value| value.as_array()) else {
            break;
        };
        if features.is_empty() {
            break;
        }
        let count = features.len();
        for feature in features {
            let Some(coords) = feature
                .pointer("/geometry/coordinates")
                .and_then(|value| value.as_array())
            else {
                continue;
            };
            let Some(longitude) = coords.first().and_then(|value| value.as_f64()) else {
                continue;
            };
            let Some(latitude) = coords.get(1).and_then(|value| value.as_f64()) else {
                continue;
            };
            let id = feature
                .pointer("/properties/OBJECTID")
                .and_then(|value| value.as_i64())
                .unwrap_or(stops.len() as i64);
            let tc = feature
                .pointer("/properties/Location_TC")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let en = feature
                .pointer("/properties/Location_EN")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            stops.push(Stop::new(
                format!("taxi:{id}"),
                "taxi",
                name(tc, en),
                latitude,
                longitude,
            ));
        }
        offset += count;
        if count < 200 {
            break;
        }
    }
    stops
}

/// Route ids are stable, but the route catalogue that names them is fetched
/// live. That crawl is best-effort and the feed throttles bursts, so a build
/// without it would label minibus arrivals with their numeric route id. Keep
/// the id-to-number map beside the bundled stops and let the live crawl extend
/// it. The map is derived from the static reference
/// https://static.data.gov.hk/td/routes-fares-xml/ROUTE_GMB.xml.
pub fn bundled_routes() -> HashMap<i64, String> {
    let raw: HashMap<String, String> =
        serde_json::from_str(include_str!("../data/gmb-routes.json")).unwrap_or_default();
    raw.into_iter()
        .filter_map(|(id, code)| Some((id.parse().ok()?, code)))
        .collect()
}

pub fn mtr_label(code: &str) -> String {
    static LABELS: OnceLock<HashMap<String, String>> = OnceLock::new();
    let labels = LABELS.get_or_init(|| {
        let raw: Vec<MtrStation> =
            serde_json::from_str(include_str!("../data/mtr.json")).unwrap_or_default();
        raw.into_iter()
            .map(|station| (station.code, name(&station.name_tc, &station.name_en)))
            .collect()
    });
    labels
        .get(code)
        .cloned()
        .unwrap_or_else(|| code.to_string())
}

pub fn mtr_stops() -> Vec<Stop> {
    let raw: Vec<MtrStation> =
        serde_json::from_str(include_str!("../data/mtr.json")).unwrap_or_default();
    raw.into_iter()
        .map(|station| {
            let mut stop = Stop::new(
                format!("mtr:{}", station.code),
                "mtr",
                name(&station.name_tc, &station.name_en),
                station.lat,
                station.lng,
            );
            stop.mtr_code = Some(station.code);
            stop.mtr_lines = station.lines;
            stop
        })
        .collect()
}

fn name(tc: &str, en: &str) -> String {
    if tc.is_empty() {
        en.to_string()
    } else if en.is_empty() {
        tc.to_string()
    } else {
        format!("{tc} {en}")
    }
}

/// One Citybus route's two ends. The batch ETA names the destination in
/// English only, so the route list supplies the Chinese.
#[derive(Clone)]
pub struct RouteEnds {
    origin_tc: String,
    origin_en: String,
    dest_tc: String,
    dest_en: String,
}

pub async fn citybus_route_ends(http: &reqwest::Client) -> HashMap<String, RouteEnds> {
    let Ok(body) = http
        .get("https://rt.data.gov.hk/v2/transport/citybus/route/CTB")
        .send()
        .await
    else {
        eprintln!("citybus route names failed");
        return HashMap::new();
    };
    let Ok(parsed) = body.json::<Data<Vec<CityRouteName>>>().await else {
        eprintln!("citybus route names were not json");
        return HashMap::new();
    };
    parsed
        .data
        .into_iter()
        .map(|route| {
            (
                route.route,
                RouteEnds {
                    origin_tc: route.orig_tc,
                    origin_en: route.orig_en,
                    dest_tc: route.dest_tc,
                    dest_en: route.dest_en,
                },
            )
        })
        .collect()
}

/// KMB publishes both languages on the arrival. Citybus publishes English
/// only, and that English is often a shorter form of the route's origin or
/// destination. `dir` `I` is towards the origin and `O` towards the destination.
/// `places` are Citybus stop names `(chinese, english)`. A short working can
/// name a stop instead of the route's official end, sometimes with extra words
/// ("The Peninsula Hong Kong" for the stop "The Peninsula").
pub fn arrival_destination(
    ends: Option<&RouteEnds>,
    places: &[(&str, &str)],
    dir: &str,
    tc: &str,
    en: &str,
) -> String {
    let tc = tc.trim();
    let en = en.trim();
    if !tc.is_empty() && !en.is_empty() {
        return name(tc, en);
    }
    if !tc.is_empty() {
        return tc.to_string();
    }
    if let Some(ends) = ends {
        if let Some(matched) = ends.matching(dir, en) {
            return matched;
        }
    }
    if let Some(chinese) = matching_place(places, en) {
        return name(chinese, en);
    }
    en.to_string()
}

/// Catalogue names are one string, "半島酒店 The Peninsula". The English half
/// starts at the first Latin word after the last Chinese character.
pub fn bilingual_name(name: &str) -> Option<(String, String)> {
    let name = name.trim();
    let mut after_cjk = None;
    for (index, ch) in name.char_indices() {
        if ('\u{3400}'..='\u{9fff}').contains(&ch) {
            after_cjk = Some(index + ch.len_utf8());
        }
    }
    let mut index = after_cjk?;
    while index < name.len() {
        let ch = name[index..].chars().next()?;
        if ch.is_whitespace() || ch.is_ascii_alphabetic() {
            break;
        }
        index += ch.len_utf8();
    }
    let chinese = name[..index].trim();
    let english = name[index..].trim();
    if chinese.is_empty() || !english.starts_with(|ch: char| ch.is_ascii_alphabetic()) {
        return None;
    }
    Some((chinese.to_string(), english.to_string()))
}

fn matching_place<'a>(places: &'a [(&str, &str)], english: &str) -> Option<&'a str> {
    let mut best_len = 0usize;
    let mut best: Option<&str> = None;
    let mut conflict = false;
    for (chinese, place) in places {
        if !same_place(english, place) && !same_place(place, english) {
            continue;
        }
        if place.len() > best_len {
            best_len = place.len();
            best = Some(*chinese);
            conflict = false;
        } else if place.len() == best_len && best != Some(*chinese) {
            conflict = true;
        }
    }
    if conflict {
        None
    } else {
        best
    }
}

impl RouteEnds {
    fn matching(&self, dir: &str, english: &str) -> Option<String> {
        let inbound = dir.eq_ignore_ascii_case("I") || dir.eq_ignore_ascii_case("inbound");
        let (first, second) = if inbound {
            (self.origin(), self.destination())
        } else {
            (self.destination(), self.origin())
        };
        for (tc, en) in [first, second] {
            if same_place(en, english) {
                return Some(name(tc, en));
            }
        }
        // "Central (Ferry Piers)" is the end "Central" with a bracketed
        // qualifier. Keep the feed's English and the route's Chinese.
        for (tc, en) in [first, second] {
            if parenthetical(english, en) {
                return Some(name(tc, english));
            }
        }
        None
    }

    fn origin(&self) -> (&str, &str) {
        (&self.origin_tc, &self.origin_en)
    }

    fn destination(&self) -> (&str, &str) {
        (&self.dest_tc, &self.dest_en)
    }
}

fn same_place(full: &str, short: &str) -> bool {
    let full = plain_place(full);
    let short = plain_place(short);
    if short.is_empty() || full.is_empty() {
        return false;
    }
    full == short
        || full.starts_with(&(short.clone() + " "))
        || full.starts_with(&(short.clone() + "/"))
        || full.starts_with(&(short + " /"))
}

// The feed and the route list write the same place with different brackets:
// "Central (Pier 3)" and "Central Pier 3".
fn parenthetical(eta: &str, route_en: &str) -> bool {
    let bare = strip_paren_groups(eta);
    let bare = plain_place(&bare);
    let route = plain_place(route_en);
    !bare.is_empty() && bare == route && plain_place(eta) != route
}

fn strip_paren_groups(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut depth = 0;
    for ch in value.chars() {
        match ch {
            '(' | '（' => depth += 1,
            ')' | '）' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

fn plain_place(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut spaced = false;
    for ch in value.chars() {
        if matches!(ch, '(' | ')' | '（' | '）') || ch.is_whitespace() {
            spaced = !out.is_empty();
            continue;
        }
        if spaced {
            out.push(' ');
            spaced = false;
        }
        out.extend(ch.to_lowercase());
    }
    out
}

#[derive(Deserialize)]
struct Data<T> {
    data: T,
}

#[derive(Deserialize)]
struct KmbStop {
    stop: String,
    name_tc: String,
    name_en: String,
    lat: String,
    long: String,
}

#[derive(Deserialize)]
struct CityRoute {
    route: String,
}

#[derive(Deserialize)]
struct CityRouteName {
    route: String,
    #[serde(default)]
    orig_tc: String,
    #[serde(default)]
    orig_en: String,
    #[serde(default)]
    dest_tc: String,
    #[serde(default)]
    dest_en: String,
}

#[derive(Deserialize)]
struct CityRouteStop {
    stop: String,
}

#[derive(Deserialize)]
struct CityStop {
    stop: String,
    name_tc: String,
    name_en: String,
    lat: String,
    long: String,
}

#[derive(Deserialize)]
struct MtrStation {
    code: String,
    name_tc: String,
    name_en: String,
    lat: f64,
    lng: f64,
    lines: Vec<String>,
}

#[derive(Deserialize)]
struct BundledStop {
    id: String,
    mode: String,
    name: String,
    #[serde(default)]
    name_tc: Option<String>,
    #[serde(default)]
    name_en: Option<String>,
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize)]
struct BundledStops {
    stops: Vec<BundledStop>,
}

/// The whole catalogue, embedded at build time. Fetching it live costs
/// thousands of requests to data.etagmb.gov.hk, which never finishes inside a
/// function that is frozen between requests.
pub fn bundled_stops() -> Vec<Stop> {
    let parsed: BundledStops = match serde_json::from_str(include_str!("../data/stops.json")) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("bundled stops unreadable: {error}");
            return Vec::new();
        }
    };
    parsed
        .stops
        .into_iter()
        .map(|stop| {
            Stop::new(
                stop.id,
                &stop.mode,
                stop.name,
                stop.latitude,
                stop.longitude,
            )
            .with_names(stop.name_tc, stop.name_en)
        })
        .collect()
}


#[derive(Deserialize)]
struct LrtStop {
    id: String,
    name_tc: String,
    name_en: String,
    lat: f64,
    lng: f64,
    stop_id: String,
}

pub fn lrt_stops() -> Vec<Stop> {
    let raw: Vec<LrtStop> =
        serde_json::from_str(include_str!("../data/lrt-stops.json")).unwrap_or_default();
    raw.into_iter()
        .map(|stop| {
            let mut s = Stop::new(
                stop.id,
                "mtr",
                name(&stop.name_tc, &stop.name_en),
                stop.lat,
                stop.lng,
            );
            s.mtr_code = Some(stop.stop_id);
            s.with_names(Some(stop.name_tc), Some(stop.name_en))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn mtr_label_has_both_names() {
        assert_eq!(super::mtr_label("CEN"), "中環 Central");
    }

    fn ends() -> super::RouteEnds {
        super::RouteEnds {
            origin_tc: "海麗邨／南昌站".to_string(),
            origin_en: "Hoi Lai Estate / Nam Cheong Station".to_string(),
            dest_tc: "旺角".to_string(),
            dest_en: "Mong Kok".to_string(),
        }
    }

    #[test]
    fn kmb_arrival_keeps_both_languages() {
        let name = super::arrival_destination(
            None,
            &[],
            "O",
            "小西灣(藍灣半島)",
            "SIU SAI WAN (ISLAND RESORT)",
        );
        assert_eq!(name, "小西灣(藍灣半島) SIU SAI WAN (ISLAND RESORT)");
    }

    #[test]
    fn citybus_inbound_uses_the_origin_when_the_english_is_shorter() {
        let name = super::arrival_destination(Some(&ends()), &[], "I", "", "Hoi Lai Estate");
        assert_eq!(name, "海麗邨／南昌站 Hoi Lai Estate / Nam Cheong Station");
    }

    #[test]
    fn citybus_outbound_uses_the_destination() {
        let name = super::arrival_destination(Some(&ends()), &[], "O", "", "Mong Kok");
        assert_eq!(name, "旺角 Mong Kok");
    }

    #[test]
    fn unmatched_english_destination_stays_as_published() {
        let name = super::arrival_destination(Some(&ends()), &[], "I", "", "Somewhere Else");
        assert_eq!(name, "Somewhere Else");
    }

    #[test]
    fn citybus_parenthetical_uses_the_route_chinese() {
        let ends = super::RouteEnds {
            origin_tc: "中環".to_string(),
            origin_en: "Central".to_string(),
            dest_tc: "山頂".to_string(),
            dest_en: "The Peak".to_string(),
        };
        let name = super::arrival_destination(Some(&ends), &[], "I", "", "Central (Ferry Piers)");
        assert_eq!(name, "中環 Central (Ferry Piers)");
    }

    #[test]
    fn citybus_parentheses_match_the_route_end() {
        let ends = super::RouteEnds {
            origin_tc: "中環3號碼頭".to_string(),
            origin_en: "Central Pier 3".to_string(),
            dest_tc: "羅便臣道／柏道".to_string(),
            dest_en: "Robinson Road / Park Road".to_string(),
        };
        let name = super::arrival_destination(Some(&ends), &[], "I", "", "Central (Pier 3)");
        assert_eq!(name, "中環3號碼頭 Central Pier 3");
    }

    #[test]
    fn citybus_stop_name_translates_a_longer_destination() {
        let ends = super::RouteEnds {
            origin_tc: "中環碼頭-天星小輪".to_string(),
            origin_en: "Central Ferry - Star Ferry".to_string(),
            dest_tc: "尖沙咀 ．落日飛車".to_string(),
            dest_en: "Tsim Sha Tsui".to_string(),
        };
        let places = [("半島酒店", "The Peninsula")];
        let name =
            super::arrival_destination(Some(&ends), &places, "O", "", "The Peninsula Hong Kong");
        assert_eq!(name, "半島酒店 The Peninsula Hong Kong");
    }

    #[test]
    fn conflicting_stop_names_stay_as_published() {
        let places = [("半島酒店", "The Peninsula"), ("其他", "The Peninsula")];
        let name = super::arrival_destination(None, &places, "O", "", "The Peninsula Hong Kong");
        assert_eq!(name, "The Peninsula Hong Kong");
    }

    #[test]
    fn bilingual_stop_name_keeps_the_bracket_with_the_chinese() {
        assert_eq!(
            super::bilingual_name("半島酒店 The Peninsula"),
            Some(("半島酒店".to_string(), "The Peninsula".to_string()))
        );
        assert_eq!(
            super::bilingual_name("中環 (港澳碼頭) Central (Macao Ferry)"),
            Some((
                "中環 (港澳碼頭)".to_string(),
                "Central (Macao Ferry)".to_string()
            ))
        );
    }
}
