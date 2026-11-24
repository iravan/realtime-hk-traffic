#!/usr/bin/env python3
"""Sync the bundled MTR stops and line terminal labels.

`server/data/mtr.json` is the station source of truth. This script uses it to
refresh the `mtr:` rows in `server/data/stops.json`, then reads the MTR lines and
stations CSV to write `web/app/mtr-line-terminals.json`. The web build copies
the stop catalogue from the server file, so only the canonical stop list is
rewritten here.

Usage:
  python3 scripts/build-mtr-catalogue.py [--refresh]

--refresh ignores the cached CSV and downloads it again.
"""

import argparse
import collections
import csv
import json
import ssl
import urllib.request
from pathlib import Path

CSV_URL = "https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv"
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "mtr"
STATIONS = ROOT / "server" / "data" / "mtr.json"
STOPS = ROOT / "server" / "data" / "stops.json"
TERMINALS = ROOT / "web" / "app" / "mtr-line-terminals.json"
UA = "realtime-hk-traffic/0.1 (MTR catalogue refresh)"

# The CSV direction order is not the reading direction used by the line
# tooltip. These two lines run the other way in the current UI.
NO_REVERSE = {"DRL", "SIL"}


def context() -> ssl.SSLContext:
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if Path(bundle).exists():
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


CTX = context()


def fetch_csv(refresh: bool) -> Path:
    path = CACHE / "mtr_lines_and_stations.csv"
    if path.exists() and not refresh:
        return path
    CACHE.mkdir(parents=True, exist_ok=True)
    print("downloading MTR lines and stations CSV", flush=True)
    request = urllib.request.Request(CSV_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=60, context=CTX) as response:
        path.write_bytes(response.read())
    return path


def station_label(station: dict) -> str:
    return f"{station['name_tc']} {station['name_en']}".strip()


def line_terminals(path: Path, stations: dict[str, dict]) -> dict[str, dict]:
    rows = [
        row
        for row in csv.DictReader(path.open(newline="", encoding="utf-8-sig"))
        if row["Line Code"]
    ]
    by_line: dict[str, list[dict]] = collections.defaultdict(list)
    for row in rows:
        by_line[row["Line Code"]].append(row)

    terminals: dict[str, dict] = {}
    for line in sorted(by_line):
        directions = []
        for direction in dict.fromkeys(row["Direction"] for row in by_line[line]):
            sequence = sorted(
                (row for row in by_line[line] if row["Direction"] == direction),
                key=lambda row: float(row["Sequence"]),
            )
            directions.append((direction, sequence))

        _, main = max(directions, key=lambda item: len(item[1]))
        first = main[0]["Station Code"]
        last = main[-1]["Station Code"]
        if line not in NO_REVERSE:
            first, last = last, first

        internal = {row["Station Code"] for row in main[1:-1]}
        endpoints = []
        for _, sequence in directions:
            for code in (sequence[0]["Station Code"], sequence[-1]["Station Code"]):
                if code != first and code not in internal and code not in endpoints:
                    endpoints.append(code)

        if not endpoints:
            raise SystemExit(f"no terminal found for {line}")
        for code in [first, *endpoints]:
            if code not in stations:
                raise SystemExit(f"{line} refers to unknown station {code}")

        terminals[line] = {
            "from": station_label(stations[first]),
            "to": " / ".join(station_label(stations[code]) for code in endpoints),
        }
    return terminals


def sync_stops(stations: list[dict]) -> tuple[int, int, int]:
    generated = {
        f"mtr:{station['code']}": {
            "id": f"mtr:{station['code']}",
            "latitude": station["lat"],
            "longitude": station["lng"],
            "mode": "mtr",
            "name": station_label(station),
        }
        for station in stations
    }

    document = json.loads(STOPS.read_text(encoding="utf-8"))
    seen = set()
    stops = []
    updated = 0
    removed = 0
    for stop in document["stops"]:
        if stop["mode"] != "mtr":
            stops.append(stop)
            continue
        fresh = generated.get(stop["id"])
        if not fresh:
            removed += 1
            continue
        if any(stop.get(key) != value for key, value in fresh.items()):
            updated += 1
        stop.update(fresh)
        stops.append(stop)
        seen.add(stop["id"])

    added = 0
    for stop_id, stop in generated.items():
        if stop_id not in seen:
            stops.append(stop)
            added += 1

    document["stops"] = stops
    STOPS.write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return added, updated, removed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()

    stations = json.loads(STATIONS.read_text(encoding="utf-8"))
    by_code = {station["code"]: station for station in stations}

    added, updated, removed = sync_stops(stations)
    print(
        f"{STOPS.name}: {len(stations)} MTR stops "
        f"({added} new, {updated} updated, {removed} removed)"
    )

    terminals = line_terminals(fetch_csv(args.refresh), by_code)
    TERMINALS.write_text(
        json.dumps(terminals, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"{TERMINALS.name}: {len(terminals)} lines")


if __name__ == "__main__":
    main()
