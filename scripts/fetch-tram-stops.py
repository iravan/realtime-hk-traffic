#!/usr/bin/env python3
"""Fetch Hong Kong Tramway stops from the TD KML feed and merge them in.

Usage:
  python3 scripts/fetch-tram-stops.py
"""

import json
import ssl
import urllib.request
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
                our_id = f"tram:{stop_id}"
                if our_id in by_stop:
                    continue
                name_tc = data("stopNameC") or data("stopNameS")
                name_en = data("stopNameE")
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