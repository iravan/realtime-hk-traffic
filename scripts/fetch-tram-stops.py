#!/usr/bin/env python3
"""Fetch Hong Kong Tramways stops and merge them into the stop catalogues.

The KML feed gives each stop's coordinates and names. The Tramways CSV gives
the 3-character stop code the arrivals endpoint expects (for example 01E or
08W). A KML stop is matched to the CSV by its English name and direction.
Stops with no match keep the KML stop id.

Usage:
  python3 scripts/fetch-tram-stops.py
"""

import csv
import io
import json
import re
import ssl
import urllib.request
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
STOPS = ROOT / "server" / "data" / "stops.json"
WEB_STOPS = ROOT / "web" / "public" / "stops-tram.json"
KML_URL = "https://static.data.gov.hk/td/routes-fares-kml/KML_TRAM.zip"
CSV_URL = "https://static.data.gov.hk/tramways/datasets/tram_stops/summary_tram_stops_en.csv"
NS = {"k": "http://www.opengis.net/kml/2.2"}

# KML spellings that differ from the CSV.
ALIASES = {
    "holy cross patht": "holy cross path",
    "kennnedy town praya": "kennedy town praya",
    "kennnedy town terminus": "kennedy town terminus",
}


def context():
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if Path(bundle).exists():
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


def download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120, context=context()) as response:
        return response.read()


def plain_name(value: str) -> str:
    return re.sub(r"\s*\([^)]*\)", "", value).strip().lower()


def direction_of(value: str) -> str:
    value = value.lower()
    if "east" in value:
        return "E"
    if "west" in value:
        return "W"
    return ""


def code_map(csv_bytes: bytes) -> dict[tuple[str, str], str]:
    rows = csv.DictReader(io.StringIO(csv_bytes.decode("utf-8-sig")))
    mapping: dict[tuple[str, str], str] = {}
    for row in rows:
        code = row["Stops Code"].strip()
        letter = "E" if code.endswith("E") else "W" if code.endswith("W") else ""
        mapping.setdefault((plain_name(row["Stops Name"]), letter), code)
    for (name, letter), code in list(mapping.items()):
        for wrong, right in ALIASES.items():
            if name == right:
                mapping.setdefault((wrong, letter), code)
    return mapping


def extract_stops(archive_bytes: bytes, codes: dict[tuple[str, str], str]) -> dict[str, dict]:
    by_stop: dict[str, dict] = {}
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        for name in sorted(archive.namelist()):
            if not name.endswith(".kml"):
                continue
            root = ET.fromstring(archive.read(name))

            def route_data(key: str) -> str:
                node = root.find(f".//k:Document/k:ExtendedData/k:Data[@name='{key}']/k:value", NS)
                return (node.text or "").strip() if node is not None else ""

            route_label = f"{route_data('routeNameC')} {route_data('routeNameE')}".strip()
            for placemark in root.findall(".//k:Placemark", NS):

                def data(key: str) -> str:
                    node = placemark.find(f".//k:Data[@name='{key}']/k:value", NS)
                    return (node.text or "").strip() if node is not None else ""

                stop_id = data("stopId")
                coords = placemark.find(".//k:coordinates", NS)
                if not stop_id or coords is None or not coords.text:
                    continue
                lon, lat = [float(part) for part in coords.text.strip().split(",")[:2]]
                name_tc = data("stopNameC") or data("stopNameS")
                name_en = data("stopNameE")
                code = codes.get((plain_name(name_en), direction_of(name_en)))
                our_id = f"tram:{code or stop_id}"
                entry = by_stop.setdefault(
                    our_id,
                    {
                        "id": our_id,
                        "latitude": lat,
                        "longitude": lon,
                        "mode": "tram",
                        "name": f"{name_tc} {name_en}".strip(),
                        "name_tc": name_tc,
                        "name_en": name_en,
                        "routes": [],
                    },
                )
                if route_label and route_label not in entry["routes"]:
                    entry["routes"].append(route_label)
    return by_stop


def main() -> None:
    codes = code_map(download(CSV_URL))
    by_stop = extract_stops(download(KML_URL), codes)

    document = json.loads(STOPS.read_text(encoding="utf-8"))
    stops = document["stops"] if isinstance(document, dict) else document
    stops = [s for s in stops if not (isinstance(s, dict) and str(s.get("id", "")).startswith("tram:"))]
    stops.extend(by_stop.values())
    if isinstance(document, dict):
        document["stops"] = stops
        STOPS.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    else:
        STOPS.write_text(json.dumps(stops, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    WEB_STOPS.write_text(json.dumps({"stops": list(by_stop.values())}, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"merged {len(by_stop)} tram stops")


if __name__ == "__main__":
    main()
