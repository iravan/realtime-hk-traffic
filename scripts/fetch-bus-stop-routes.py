#!/usr/bin/env python3
"""Attach bus route numbers to the bus stop catalogue.

The bus pins can be searched by route number. The bus stop file has no route
list, so this script reads the KMB/LWB and Citybus route-stop feeds and writes
a `routes` array onto every matching record in `web/public/stops-bus.json`.

- KMB/LWB: one bulk list of every route variant's ordered stops
  (`bus:kmb:{stop}`).
- Citybus: one request per route and direction (`bus:ctb:{stop}`). Requests
  run through curl, because Python's bundled SSL store is missing the
  certificate chain on some machines.

Stops that no route serves keep no `routes` key. Re-run this script after the
bus network changes, then commit the regenerated file.

Usage:
  python3 scripts/fetch-bus-stop-routes.py
"""

import json
import subprocess
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STOPS = ROOT / "web" / "public" / "stops-bus.json"
KMB_ROUTE_STOP = "https://data.etabus.gov.hk/v1/transport/kmb/route-stop/"
CTB_ROUTE = "https://rt.data.gov.hk/v2/transport/citybus/route/CTB"
CTB_ROUTE_STOP = "https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/{route}/{direction}"


def get_json(url: str) -> dict:
    out = subprocess.run(
        ["curl", "-s", "-f", "-m", "60", url], capture_output=True, check=True
    ).stdout
    return json.loads(out)


def main() -> None:
    routes_by_stop: dict[str, set[str]] = defaultdict(set)

    for row in get_json(KMB_ROUTE_STOP)["data"]:
        routes_by_stop[f"bus:kmb:{row['stop']}"].add(row["route"])

    ctb_routes = sorted({row["route"] for row in get_json(CTB_ROUTE)["data"]})
    jobs = [(route, direction) for route in ctb_routes for direction in ("outbound", "inbound")]

    def fetch(job: tuple[str, str]) -> list[dict]:
        route, direction = job
        return get_json(CTB_ROUTE_STOP.format(route=route, direction=direction))["data"]

    with ThreadPoolExecutor(max_workers=12) as pool:
        for rows in pool.map(fetch, jobs):
            for row in rows:
                routes_by_stop[f"bus:ctb:{row['stop']}"].add(row["route"])

    data = json.loads(STOPS.read_text(encoding="utf-8"))
    matched = 0
    for stop in data["stops"]:
        routes = routes_by_stop.get(stop["id"])
        if routes:
            stop["routes"] = sorted(routes, key=lambda r: (len(r), r))
            matched += 1
        else:
            stop.pop("routes", None)

    STOPS.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"KMB/LWB and Citybus routes: {len(ctb_routes)} Citybus routes, {matched} stops matched")


if __name__ == "__main__":
    main()
