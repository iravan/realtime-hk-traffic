#!/usr/bin/env python3
"""Refresh ferry piers in the bundled stop catalogue.

Stop names come from the Transport Department ferry stop sequence. Coordinates
come from the CSDI ferry-pier layer, joined on STOP_ID. Each pier row also
carries every place it reaches (`destinations`) and its full timetable
(`timetable`), built by ferry_timetables.py from the operator and Transport
Department files, so the page never asks a server for them.

Hand-maintained patches in server/data/ferry-overrides.json are applied last,
so a pier the feeds cannot supply can be filled in by hand and survives every
re-run. See DATA.md, "Manual overrides".

Live departures are not in those files: Hong Kong & Kowloon Ferry and Sun
Ferry publish ETA by route, so this script also writes the pier-to-sailing map
the server uses when a pier is opened.

Usage:
  python3 server/scripts/fetch-ferry-stops.py
"""

import json
import ssl
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import ferry_timetables

ROOT = Path(__file__).resolve().parents[2]
STOPS = ROOT / "server" / "data" / "stops.json"
DEPARTURES = ROOT / "server" / "data" / "ferry-departures.json"
OVERRIDES = ROOT / "server" / "data" / "ferry-overrides.json"
RSTOP_URL = "https://static.data.gov.hk/td/routes-fares-xml/RSTOP_FERRY.xml"
PIER_QUERY = (
    "https://portal.csdi.gov.hk/server/rest/services/common/"
    "td_rcd_1671692797539_19916/FeatureServer/0/query"
    "?where=1%3D1&outFields=STOP_ID&outSR=4326&f=geojson"
    "&resultRecordCount=200&resultOffset={offset}"
)
UA = "realtime-hk-traffic/0.1 (ferry catalogue refresh)"

# Operator ETA feeds are per route, not per pier. Each sailing is the
# departure from one pier. Stop ids are the Transport Department STOP_ID.
# HKKF direction follows their spec: outbound leaves the route origin.
SAILINGS = {
    "101126": [  # Central Pier 4
        ("hkkf", "1", "outbound", "港九小輪 HK & Kowloon Ferry", "索罟灣 Sok Kwu Wan"),
        ("hkkf", "2", "outbound", "港九小輪 HK & Kowloon Ferry", "榕樹灣 Yung Shue Wan"),
    ],
    "101348": [("hkkf", "1", "inbound", "港九小輪 HK & Kowloon Ferry", "中環 Central")],  # Sok Kwu Wan Pier 2
    "101123": [("hkkf", "2", "inbound", "港九小輪 HK & Kowloon Ferry", "中環 Central")],  # Yung Shue Wan
    "101108": [  # Central Pier 6, western berth
        ("hkkf", "3", "outbound", "港九小輪 HK & Kowloon Ferry", "坪洲 Peng Chau"),
        ("sun", "CEMW", "", "新渡輪 Sun Ferry", "梅窩 Mui Wo"),
    ],
    "101109": [  # Peng Chau Ferry Pier
        ("hkkf", "3", "inbound", "港九小輪 HK & Kowloon Ferry", "中環 Central"),
        ("hkkf", "4", "outbound", "港九小輪 HK & Kowloon Ferry", "喜靈洲 Hei Ling Chau"),
        ("sun", "IIPECMUW", "", "新渡輪 Sun Ferry", "梅窩 Mui Wo"),
    ],
    "101324": [("hkkf", "4", "inbound", "港九小輪 HK & Kowloon Ferry", "坪洲 Peng Chau")],  # Hei Ling Chau
    "101102": [  # Central Pier 5
        ("sun", "CECC", "", "新渡輪 Sun Ferry", "長洲 Cheung Chau"),
        ("sun", "CEMW", "", "新渡輪 Sun Ferry", "梅窩 Mui Wo"),
    ],
    "101101": [  # Cheung Chau
        ("sun", "CCCE", "", "新渡輪 Sun Ferry", "中環 Central"),
        ("sun", "IICHCCMW", "", "新渡輪 Sun Ferry", "芝麻灣 Chi Ma Wan"),
        ("sun", "IICHCMUW", "", "新渡輪 Sun Ferry", "梅窩 Mui Wo"),
    ],
    "101107": [  # Mui Wo Ferry Pier
        ("sun", "MWCE", "", "新渡輪 Sun Ferry", "中環 Central"),
        ("sun", "IIMUWPEC", "", "新渡輪 Sun Ferry", "坪洲 Peng Chau"),
        ("sun", "IIMUWCMW", "", "新渡輪 Sun Ferry", "芝麻灣 Chi Ma Wan"),
        ("sun", "IIMUWCHC", "", "新渡輪 Sun Ferry", "長洲 Cheung Chau"),
    ],
    "101115": [  # Chi Ma Wan
        ("sun", "IICMWMUW", "", "新渡輪 Sun Ferry", "梅窩 Mui Wo"),
        ("sun", "IICMWCHC", "", "新渡輪 Sun Ferry", "長洲 Cheung Chau"),
    ],
    "101110": [  # North Point (West)
        ("sun", "NPHH", "", "新渡輪 Sun Ferry", "紅磡 Hung Hom"),
        ("sun", "NPKC", "", "新渡輪 Sun Ferry", "九龍城 Kowloon City"),
    ],
    "101111": [("sun", "HHNP", "", "新渡輪 Sun Ferry", "北角 North Point")],  # Hung Hom (North)
    "101112": [("sun", "KCNP", "", "新渡輪 Sun Ferry", "北角 North Point")],  # Kowloon City
}


def context() -> ssl.SSLContext:
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if Path(bundle).exists():
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


CTX = context()


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=40, context=CTX) as response:
        return response.read()


def pier_coordinates() -> dict[int, tuple[float, float]]:
    coords: dict[int, tuple[float, float]] = {}
    offset = 0
    while True:
        payload = json.loads(fetch(PIER_QUERY.format(offset=offset)))
        features = payload.get("features") or []
        for feature in features:
            stop_id = feature.get("properties", {}).get("STOP_ID")
            point = (feature.get("geometry") or {}).get("coordinates") or []
            if stop_id is None or len(point) < 2:
                continue
            coords[int(stop_id)] = (float(point[1]), float(point[0]))
        if not features or not payload.get("exceededTransferLimit"):
            break
        offset += len(features)
    return coords


def fetch_text(url: str) -> str:
    return fetch(url).decode("utf-8-sig", errors="replace")


def route_stops() -> list[ET.Element]:
    return list(ET.fromstring(fetch(RSTOP_URL)))


def pier_names(rows: list[ET.Element]) -> dict[int, tuple[str, str]]:
    names: dict[int, tuple[str, str]] = {}
    for row in rows:
        stop_id = row.findtext("STOP_ID")
        if not stop_id:
            continue
        names[int(stop_id)] = (
            (row.findtext("STOP_NAMEC") or "").strip(),
            (row.findtext("STOP_NAMEE") or "").strip(),
        )
    return names


def bilingual(tc: str, en: str) -> str:
    if not tc:
        return en
    if not en:
        return tc
    return f"{tc} {en}"


def main() -> None:
    coords = pier_coordinates()
    rstop = route_stops()
    names = pier_names(rstop)
    missing = sorted(set(SAILINGS) - {str(stop_id) for stop_id in names})
    if missing:
        raise SystemExit(f"sailing map names a pier that is not in RSTOP_FERRY.xml: {missing}")
    # Any source that fails to load stops the refresh before anything is written.
    timetables = ferry_timetables.build(fetch_text)
    boards = ferry_timetables.board(
        timetables,
        [
            tuple(row.findtext(field) or "" for field in ("ROUTE_ID", "ROUTE_SEQ", "STOP_SEQ", "STOP_ID", "STOP_PICK_DROP"))
            for row in rstop
        ],
    )
    overrides = ferry_timetables.load_overrides(OVERRIDES)
    unknown = sorted(set(overrides) - {str(stop_id) for stop_id in names})
    if unknown:
        raise SystemExit(f"{OVERRIDES.name} names piers not in RSTOP_FERRY.xml: {unknown}")
    stops = []
    for stop_id in sorted(names):
        patch = overrides.get(str(stop_id), {})
        if stop_id in coords:
            latitude, longitude = coords[stop_id]
        elif "latitude" in patch and "longitude" in patch:
            latitude, longitude = patch["latitude"], patch["longitude"]
        else:
            continue
        latitude = patch.get("latitude", latitude)
        longitude = patch.get("longitude", longitude)
        tc, en = names[stop_id]
        stop = {
            "id": f"ferry:{stop_id}",
            "latitude": latitude,
            "longitude": longitude,
            "mode": "ferry",
            "name": patch.get("name", bilingual(tc, en)),
        }
        timetable = patch.get("timetable", timetables.get(str(stop_id), []))
        destinations = patch.get(
            "destinations",
            [destination["destination"] for destination in timetable] if "timetable" in patch else boards.get(str(stop_id), []),
        )
        if destinations:
            stop["destinations"] = destinations
        if timetable:
            stop["timetable"] = timetable
        stops.append(stop)
    if len(stops) < 40:
        raise SystemExit(f"only {len(stops)} ferry piers joined; refusing to rewrite the catalogue")

    document = json.loads(STOPS.read_text(encoding="utf-8"))
    kept = [stop for stop in document["stops"] if stop.get("mode") != "ferry"]
    document["stops"] = kept + stops
    STOPS.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )

    departures = {
        stop_id: [
            {
                "op": op,
                "route": route,
                "direction": direction,
                "label": label,
                "destination": destination,
            }
            for op, route, direction, label, destination in rows
        ]
        for stop_id, rows in sorted(SAILINGS.items())
    }
    DEPARTURES.write_text(
        json.dumps(departures, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    with_board = sum(1 for stop in stops if stop.get("destinations"))
    with_timetable = sum(1 for stop in stops if stop.get("timetable"))
    print(
        f"ferry piers {len(stops)}; destinations at {with_board}; "
        f"timetables at {with_timetable}; sailings at {len(departures)} piers"
    )


if __name__ == "__main__":
    main()
