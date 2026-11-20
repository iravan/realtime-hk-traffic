#!/usr/bin/env python3
"""Draw the MTR heavy-rail lines from OpenStreetMap.

The page has a stop catalogue but no line geometry, so the map shows stops on
an empty basemap. This script asks the Overpass API for the MTR route relations
and their station nodes, then writes a GeoJSON file the map can load:

  web/public/mtr-lines.geojson

The browser never calls Overpass. Each route relation contributes its member
ways; ways shared by the up and down directions are written once. Lines are
grouped by route `ref`, so the whole Tsuen Wan Line is one feature with the
`colour` from the relation.

Usage:
  python3 server/scripts/fetch-mtr-lines.py [--refresh]

Set OVERPASS_URL to use a mirror:
  OVERPASS_URL=https://overpass.private.coffee/api/interpreter \
    python3 server/scripts/fetch-mtr-lines.py --refresh

The raw response is cached under .cache/overpass; --refresh drops the cache.
"""

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".cache" / "overpass"
OUTPUT = ROOT / "web" / "public" / "mtr-lines.geojson"
UA = "realtime-hk-traffic/0.1 (mtr line refresh)"

# Hong Kong bounding box: south, west, north, east.
BBOX = "22.10,113.80,22.60,114.50"

QUERY = f"""
[out:json][timeout:180];
(
  relation["route"="subway"]["network:wikidata"="Q14751"]({BBOX});
  relation["route"="subway"]["operator:wikidata"="Q1479375"]({BBOX});
  relation["route"="train"]["operator:wikidata"="Q1479375"]["service"!="high_speed"]({BBOX});
)->.routes;
(
  node["railway"="station"]["network:wikidata"="Q14751"]({BBOX});
  node["railway"="station"]["operator:wikidata"="Q1479375"]({BBOX});
  node["railway"="station"]["operator"~"MTR|港鐵"]({BBOX});
)->.stations;
.routes out body geom;
.stations out body;
"""


def context() -> ssl.SSLContext:
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if Path(bundle).exists():
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


CTX = context()


def fetch(refresh: bool) -> dict:
    cached = CACHE / "mtr-lines.json"
    if cached.exists() and not refresh:
        try:
            return json.loads(cached.read_text())
        except json.JSONDecodeError:
            cached.unlink()

    endpoint = os.environ.get("OVERPASS_URL", "https://overpass-api.de/api/interpreter")
    request = urllib.request.Request(
        endpoint,
        data=urllib.parse.urlencode({"data": QUERY}).encode(),
        headers={"User-Agent": UA},
    )
    try:
        with urllib.request.urlopen(request, timeout=180, context=CTX) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:500]
        sys.exit(f"Overpass returned {error.code}: {detail}")
    except urllib.error.URLError as error:
        sys.exit(f"Overpass request failed: {error.reason}")

    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    return body


def line_feature(tags: dict, element_id: int) -> dict:
    return {
        "type": "Feature",
        "properties": {
            "kind": "line",
            "ref": tags.get("ref"),
            "name": tags.get("name"),
            "name:en": tags.get("name:en"),
            "route": tags.get("route"),
            "colour": tags.get("colour") or tags.get("color"),
            "osm_id": element_id,
        },
        "geometry": {"type": "MultiLineString", "coordinates": []},
    }


def build(body: dict) -> dict:
    lines: dict[str, dict] = {}
    ways: dict[str, dict[int, list]] = {}
    stations: list[dict] = []

    for element in body.get("elements", []):
        tags = element.get("tags") or {}
        if element["type"] == "relation":
            key = tags.get("ref") or tags.get("name") or str(element["id"])
            feature = lines.setdefault(key, line_feature(tags, element["id"]))
            bucket = ways.setdefault(key, {})

            # Direction-specific relations append "(Southbound)" and similar
            # suffixes; keep the shortest name as the line's own name.
            name_en = tags.get("name:en")
            current = feature["properties"]["name:en"]
            if name_en and (not current or len(name_en) < len(current)):
                feature["properties"]["name"] = tags.get("name")
                feature["properties"]["name:en"] = name_en
            if not feature["properties"]["colour"]:
                feature["properties"]["colour"] = tags.get("colour") or tags.get("color")

            for member in element.get("members", []):
                geometry = member.get("geometry")
                if member.get("type") != "way" or not geometry:
                    continue
                coords = [
                    [point["lon"], point["lat"]]
                    for point in geometry
                    if "lon" in point and "lat" in point
                ]
                if len(coords) >= 2:
                    bucket.setdefault(member["ref"], coords)
        elif element["type"] == "node":
            stations.append(
                {
                    "type": "Feature",
                    "properties": {
                        "kind": "station",
                        "name": tags.get("name"),
                        "name:en": tags.get("name:en"),
                        "ref": tags.get("ref"),
                        "operator": tags.get("operator"),
                        "osm_id": element["id"],
                    },
                    "geometry": {
                        "type": "Point",
                        "coordinates": [element["lon"], element["lat"]],
                    },
                }
            )

    features = []
    for key, feature in lines.items():
        if not ways[key]:
            continue
        feature["geometry"]["coordinates"] = list(ways[key].values())
        features.append(feature)
    features.extend(stations)
    features.sort(
        key=lambda item: (item["properties"]["kind"], item["properties"].get("ref") or "")
    )

    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--refresh", action="store_true", help="ignore the cached Overpass response"
    )
    args = parser.parse_args()

    collection = build(fetch(args.refresh))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(collection, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    line_count = sum(
        1 for feature in collection["features"] if feature["properties"]["kind"] == "line"
    )
    station_count = len(collection["features"]) - line_count
    print(f"wrote {OUTPUT} ({line_count} lines, {station_count} stations)")


if __name__ == "__main__":
    main()
