use crate::Stop;
use futures::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

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
            Some(Stop::new(
                format!("bus:kmb:{}", stop.stop),
                "bus",
                name(&stop.name_tc, &stop.name_en),
                latitude,
                longitude,
            ))
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
            Some(Stop::new(
                format!("bus:ctb:{}", parsed.data.stop),
                "bus",
                name(&parsed.data.name_tc, &parsed.data.name_en),
                latitude,
                longitude,
            ))
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
    let Some(regions) = parsed.pointer("/data/routes").and_then(|value| value.as_object()) else {
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
                    let Some(route_id) = variant.get("route_id").and_then(|value| value.as_i64()) else {
                        continue;
                    };
                    let Some(directions) = variant.get("directions").and_then(|value| value.as_array()) else {
                        continue;
                    };
                    for direction in directions {
                        let Some(seq) = direction.get("route_seq").and_then(|value| value.as_i64()) else {
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
                let Some(stops) = parsed.pointer("/data/route_stops").and_then(|value| value.as_array()) else {
                    return Vec::new();
                };
                stops
                    .iter()
                    .filter_map(|stop| {
                        let id = stop.get("stop_id")?.as_i64()?;
                        let name = stop.get("name_tc").and_then(|value| value.as_str()).unwrap_or("");
                        Some((id, name.to_string()))
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
                let latitude = parsed.pointer("/data/coordinates/wgs84/latitude")?.as_f64()?;
                let longitude = parsed.pointer("/data/coordinates/wgs84/longitude")?.as_f64()?;
                Some(Stop::new(
                    format!("minibus:{id}"),
                    "minibus",
                    if label.is_empty() { id.to_string() } else { label },
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
            let Some(coords) = feature.pointer("/geometry/coordinates").and_then(|value| value.as_array()) else {
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

pub fn mtr_stops() -> Vec<Stop> {
    let raw: Vec<MtrStation> = serde_json::from_str(include_str!("../data/mtr.json")).unwrap_or_default();
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
