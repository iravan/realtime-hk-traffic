#!/usr/bin/env python3
"""Fetch New Lantao Bus stops and merge them into server/data/stops.json.

Usage:
  python3 scripts/fetch-nlb-stops.py
"""

import json
import ssl
import urllib.request
from pathlib import Path

def context():
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        from pathlib import Path as _P
        if _P(bundle).exists():
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()

ROOT = Path(__file__).resolve().parents[1]
STOPS = ROOT / "server" / "data" / "stops.json"
BASE = "https://rt.data.gov.hk/v2/transport/nlb"


def get(path: str) -> dict:
    with urllib.request.urlopen(BASE + "/" + path, timeout=60, context=context()) as response:
        return json.loads(response.read())


def main() -> None:
    routes = get("route.php?action=list").get("routes", [])
    by_stop: dict[str, dict] = {}
    for route in routes:
        route_id = route["routeId"]
        try:
            stops = get(f"stop.php?action=list&routeId={route_id}").get("stops", [])
        except Exception as exc:  # noqa: BLE001
            print("skip route", route_id, exc)
            continue
        for stop in stops:
            stop_id = stop["stopId"]
            our_id = f"bus:nlb:{stop_id}"
            if our_id in by_stop:
                continue
            by_stop[our_id] = {
                "id": our_id,
                "latitude": float(stop["latitude"]),
                "longitude": float(stop["longitude"]),
                "mode": "bus",
                "name": f"{stop['stopName_c']} {stop['stopName_e']}",
                "name_tc": stop["stopName_c"],
                "name_en": stop["stopName_e"],
            }

    document = json.loads(STOPS.read_text(encoding="utf-8"))
    stops = document["stops"] if isinstance(document, dict) else document
    # remove old nlb stops
    stops = [s for s in stops if not (isinstance(s, dict) and s.get("id", "").startswith("bus:nlb:"))]
    stops.extend(by_stop.values())
    if isinstance(document, dict):
        document["stops"] = stops
    STOPS.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"merged {len(by_stop)} NLB stops")


if __name__ == "__main__":
    main()
