#!/usr/bin/env python3
"""Mark the stops that an overnight bus or minibus route serves.

The page greys a stop outside its service hours. Some bus and minibus routes
run through the small hours, so their stops must stay clickable. This script
unions the stops of every route that is running at 03:00 and writes
`"night": true` onto those records in the canonical stop list. A re-run
refreshes the flags: a stop that no night route serves loses its flag. The web
copy is generated from the canonical list during the web build.

Night routes come from three places:

- KMB/LWB routes whose code starts with `N` (this includes the `NA` airport
  night routes), read from the published route list.
- Citybus routes whose code starts with `N`, read the same way.
- Green-minibus routes whose cached headways in `.cache/gmb` cover 03:00.

Every response is cached under `.cache/night`, and requests are paced, because
the minibus host starts answering 403 to bursts.

Usage:
  python3 scripts/fetch-night-stops.py [--budget N]
"""

import argparse
import glob
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "night"
GMB_CACHE = ROOT / ".cache" / "gmb"
UA = "realtime-hk-traffic/0.1 (night stop refresh)"

state = {"requests": 0, "blocked": 0, "spacing": 0.15, "missing": 0}


def context() -> ssl.SSLContext:
    for bundle in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
        if Path(bundle).exists():
            return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


CTX = context()


def cached(name: str):
    path = CACHE / name
    if path.exists():
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            path.unlink()
    return None


def store(name: str, body) -> None:
    path = CACHE / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, ensure_ascii=False))


def fetch(name: str, url: str, budget: int | None):
    body = cached(name)
    if body is not None:
        return body
    if budget is not None and state["requests"] >= budget:
        state["missing"] += 1
        return None
    for attempt in range(5):
        time.sleep(state["spacing"])
        state["requests"] += 1
        try:
            request = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(request, timeout=25, context=CTX) as response:
                body = json.load(response)
            store(name, body)
            state["blocked"] = 0
            state["spacing"] = max(0.15, state["spacing"] * 0.95)
            return body
        except urllib.error.HTTPError as error:
            if error.code not in (403, 429):
                print(f"  {name}: http {error.code}", file=sys.stderr)
                state["missing"] += 1
                return None
            state["blocked"] += 1
            state["spacing"] = min(8.0, state["spacing"] * 2)
            print(f"  throttled, spacing now {state['spacing']:.1f}s", flush=True)
            time.sleep(min(30, 3 * state["blocked"]))
        except Exception as error:  # noqa: BLE001 - network weather
            print(f"  {name}: {type(error).__name__}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    state["missing"] += 1
    return None


def minute(value: str) -> int:
    hour, mins = value.split(":")[:2]
    return int(hour) * 60 + int(mins)


def covers_3am(start: str, end: str) -> bool:
    begin, finish = minute(start), minute(end)
    if begin == finish:
        # A single departure, not a span. Count it only inside the gap that the
        # minibus default leaves closed; a 00:25 trip is already covered.
        return 30 <= begin <= 330
    if finish > begin:
        return begin <= 180 < finish
    # The window opened on the previous day.
    return 180 >= begin or 180 < finish


def kmb_night_stops(budget: int | None) -> set[str]:
    body = fetch("kmb-routes.json", "https://data.etabus.gov.hk/v1/transport/kmb/route/", budget)
    if not body:
        return set()
    combos = set()
    for route in body.get("data") or []:
        code = route.get("route") or ""
        if not code.upper().startswith("N"):
            continue
        combos.add((code, route.get("bound"), route.get("service_type")))
    print(f"kmb night route sequences: {len(combos)}")
    stops = set()
    for code, bound, service_type in sorted(combos):
        # The route list calls the direction "O"/"I"; the route-stop endpoint
        # spells it out.
        direction = {"O": "outbound", "I": "inbound"}.get(bound, bound)
        name = f"kmb-{code}-{bound}-{service_type}.json"
        url = f"https://data.etabus.gov.hk/v1/transport/kmb/route-stop/{code}/{direction}/{service_type}"
        body = fetch(name, url, budget)
        if not body:
            continue
        for row in body.get("data") or []:
            stop = row.get("stop")
            if stop:
                stops.add(f"bus:kmb:{stop}")
    return stops


def citybus_night_stops(budget: int | None) -> set[str]:
    body = fetch("ctb-routes.json", "https://rt.data.gov.hk/v2/transport/citybus/route/CTB", budget)
    if not body:
        return set()
    codes = set()
    for route in body.get("data") or []:
        code = route.get("route") or ""
        if code.upper().startswith("N"):
            codes.add(code)
    print(f"citybus night routes: {len(codes)}")
    stops = set()
    for code in sorted(codes):
        for direction in ("outbound", "inbound"):
            name = f"ctb-{code}-{direction}.json"
            url = f"https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/{code}/{direction}"
            body = fetch(name, url, budget)
            if not body:
                continue
            for row in body.get("data") or []:
                stop = row.get("stop")
                if stop:
                    stops.add(f"bus:ctb:{stop}")
    return stops


def minibus_night_sequences() -> list[tuple[int, int]]:
    sequences = set()
    for path in glob.glob(str(GMB_CACHE / "route-*.json")):
        try:
            body = json.loads(Path(path).read_text())
        except (OSError, json.JSONDecodeError):
            continue
        for variant in body.get("data") or []:
            for direction in variant.get("directions") or []:
                seq = direction.get("route_seq")
                if seq is None:
                    continue
                for headway in direction.get("headways") or []:
                    started = headway.get("start_time")
                    ended = headway.get("end_time")
                    weekdays = headway.get("weekdays") or []
                    if not started or not ended or not any(weekdays):
                        continue
                    if covers_3am(started, ended):
                        sequences.add((variant.get("route_id"), seq))
                        break
    return sorted(sequence for sequence in sequences if None not in sequence)


def minibus_night_stops(budget: int | None) -> set[str]:
    sequences = minibus_night_sequences()
    if not sequences:
        print("no cached GMB route details; minibus night stops skipped", file=sys.stderr)
        return set()
    print(f"minibus night route sequences: {len(sequences)}")
    stops = set()
    for route_id, seq in sequences:
        name = f"gmb-{route_id}-{seq}.json"
        url = f"https://data.etagmb.gov.hk/route-stop/{route_id}/{seq}"
        body = fetch(name, url, budget)
        if not body:
            continue
        for row in (body.get("data") or {}).get("route_stops") or []:
            stop = row.get("stop_id")
            if stop is not None:
                stops.add(f"minibus:{stop}")
    return stops


def rewrite(path: Path, night: set[str]) -> tuple[int, int]:
    data = json.loads(path.read_text())
    kept = 0
    flagged = 0
    for stop in data["stops"]:
        if stop.get("night"):
            flagged += 1
        stop.pop("night", None)
        if stop["id"] in night:
            stop["night"] = True
            kept += 1
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    return kept, flagged


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=int, default=None)
    args = parser.parse_args()

    night: set[str] = set()
    night |= kmb_night_stops(args.budget)
    night |= citybus_night_stops(args.budget)
    night |= minibus_night_stops(args.budget)
    print(f"night stops: {len(night)} | requests this run: {state['requests']}")
    if state["missing"]:
        # Writing now would strip the flag from every stop we could not read.
        print(f"{state['missing']} feeds missing; stop list left unchanged", file=sys.stderr)
        return

    path = ROOT / "server" / "data" / "stops.json"
    kept, previous = rewrite(path, night)
    print(f"{path.name}: {kept} night stops ({previous} before)")


if __name__ == "__main__":
    main()
