#!/usr/bin/env python3
"""Fetch Hong Kong Tramway stops from the TD KML feed and merge them in.

Usage:
  python3 scripts/fetch-tram-stops.py
"""

import json
import ssl
import urllib.request
import csv
import io
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
STOPS = ROOT / "server" / "data" / "stops.json"
WEB_STOPS = ROOT / "web" / "public" / "stops-tram.json"
URL = "https://static.data.gov.hk/td/routes-fares-kml/KML_TRAM.zip"
NS = {"k": "http://www.opengis.net/kml/2.2"}


def context():
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if Path(bundle).exists():
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


def fetch_zip(target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(URL, timeout=120, context=context()) as response:
        target.write_bytes(response.read())
    return target



def load_code_map() -> dict[tuple[str, str], str]:
    csv_url = "https://static.data.gov.hk/tramways/datasets/tram_stops/summary_tram_stops_en.csv"
    text = urllib.request.urlopen(csv_url, timeout=60, context=context()).read().decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))

    def norm(value: str) -> str:
        return re.sub(r"\s*\([^)]*\)", "", value).strip().lower()

    def direction(value: str) -> str:
        value = value.lower()
        if "east" in value:
            return "E"
        if "west" in value:
            return "W"
        return ""

    mapping: dict[tuple[str, str], str] = {}
    for row in rows:
        code = row["Stops Code"].strip()
        letter = "E" if code.endswith("E") else "W" if code.endswith("W") else ""
        mapping.setdefault((norm(row["Stops Name"]), letter), code)
    # A few KML spellings differ from the CSV.
    aliases = {
        "holy cross patht": "holy cross path",
        "kennnedy town praya": "kennedy town praya",
        "kennnedy town terminus": "kennedy town terminus",
    }
    for (name, letter), code in list(mapping.items()):
        for wrong, right in aliases.items():
            if name == right:
                mapping.setdefault((wrong, letter), code)
    return mapping


CODE_MAP = load_code_map()


def resolve_code(name: str) -> str | None:
    letter = "E" if "east" in name.lower() else "W" if "west" in name.lower() else ""
    return CODE_MAP.get((re.sub(r"\s*\([^)]*\)", "", name).strip().lower(), letter))

def extract_stops(zip_path: Path) -> dict[str, dict]:
    by_stop: dict[str, dict] = {}
    with zipfile.ZipFile(zip_path) as archive:
        for name in archive.namelist():
            if not name.endswith(".kml"):
                continue
            root = ET.fromstring(archive.read(name))
            for placemark in root.findall(".//k:Placemark", NS):
                def data(key: str) -> str:
                    node = placemark.find(f".//k:Data[@name='{key}']/k:value", NS)
                    return (node.text or "").strip() if node is not None else ""

                stop_id = data("stopId")
                if not stop_id:
                    continue
                coords = placemark.find(".//k:coordinates", NS)
                if coords is None or not coords.text:
                    continue
                lon, lat = [float(part) for part in coords.text.strip().split(",")[:2]]
                name_tc = data("stopNameC") or data("stopNameS")
                name_en = data("stopNameE")
                code = resolve_code(name_en)
                our_id = f"tram:{code}" if code else f"tram:{stop_id}"
                if our_id in by_stop:
                    continue
                by_stop[our_id] = {
                    "id": our_id,
                    "latitude": lat,
                    "longitude": lon,
                    "mode": "tram",
                    "name": f"{name_tc} {name_en}".strip(),
                    "name_tc": name_tc,
                    "name_en": name_en,
                }
    return by_stop


def main() -> None:
    zip_path = Path("/tmp/tram.zip")
    fetch_zip(zip_path)
    by_stop = extract_stops(zip_path)

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