#!/usr/bin/env python3
"""Fetch MTR station coordinates from OpenStreetMap (Overpass) and update
server/data/mtr.json plus the mtr rows in server/data/stops.json.

Usage:
  python3 scripts/fetch-mtr-geolocation.py
"""

import json
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MTR = ROOT / "server" / "data" / "mtr.json"
STOPS = ROOT / "server" / "data" / "stops.json"
OVERPASS = "https://overpass-api.de/api/interpreter"
QUERY = (
    "[out:json][timeout:25];\n"
    "area[\"ISO3166-1\"=\"HK\"]->.hk;\n"
    "(\n"
    '  node["railway"="station"]["operator"~"MTR|港鐵"](area.hk);\n'
    '  way["railway"="station"]["operator"~"MTR|港鐵"](area.hk);\n'
    ");\n"
    "out center tags;\n"
)


def fetch() -> dict:
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    request = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": "HKTransitMap/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def main() -> None:
    result = fetch()
    coord = {}
    for element in result.get("elements", []):
        tags = element.get("tags", {})
        ref = tags.get("ref")
        if not ref:
            continue
        if "lat" in element and "lon" in element:
            coord[ref] = (element["lat"], element["lon"])
        elif "center" in element:
            coord[ref] = (element["center"]["lat"], element["center"]["lon"])

    stations = json.loads(MTR.read_text(encoding="utf-8"))
    arr = stations if isinstance(stations, list) else stations.get("stations", [])
    updated = 0
    for station in arr:
        code = station.get("code")
        if code in coord:
            lat, lon = coord[code]
            station["lat"] = lat
            station["lng"] = lon
            updated += 1
    MTR.write_text(json.dumps(stations, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    document = json.loads(STOPS.read_text(encoding="utf-8"))
    stops = document["stops"] if isinstance(document, dict) else document
    changed = 0
    for stop in stops:
        if stop.get("mode") != "mtr":
            continue
        code = stop["id"].split(":", 1)[-1]
        if code in coord:
            lat, lon = coord[code]
            stop["latitude"] = lat
            stop["longitude"] = lon
            changed += 1
    if isinstance(document, dict):
        document["stops"] = stops
    STOPS.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"updated {updated} stations in mtr.json, {changed} stops in stops.json")


if __name__ == "__main__":
    main()
PY
chmod +x scripts/fetch-mtr-geolocation.py