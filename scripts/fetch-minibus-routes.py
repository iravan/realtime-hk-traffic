#!/usr/bin/env python3
"""Fetch the green-minibus route numbers that serve each stop.

The public feed only lists stops per route, so this walks the route catalogue
once and inverts it. Every response is cached under .cache/gmb, and the run is
paced with a backoff, because the host starts answering 403 to bursts.

Usage:
  python3 scripts/fetch-minibus-routes.py [--budget N] [--routes-only]

--budget caps the number of network requests this run makes, so a large refresh
can be spread over several runs; cached responses are reused. Only a run that
has every route sequence cached rewrites the stop list, so the data is never
half-filled. The canonical stop list in server/data/stops.json gains a `routes`
array; the web copy is generated from it during the web build.

--routes-only stops after rewriting server/data/gmb-routes.json, the route-id
to route-number map the server uses to label minibus arrivals. The map is built
from KML_GMB.zip, so this mode makes no API requests. A full run also merges the
API route details over the KML map to pick up routes added after the archive.

--refresh-kml ignores the cached KML_GMB.zip and downloads it again.
"""

import argparse
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

BASE = "https://data.etagmb.gov.hk"
KML_URL = "https://static.data.gov.hk/td/routes-fares-kml/KML_GMB.zip"
ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache" / "gmb"
UA = "realtime-hk-traffic/0.1 (stop catalogue refresh)"

state = {"requests": 0, "blocked": 0, "spacing": 0.6}


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
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2))


def fetch(name: str, url: str, budget: int | None):
    body = cached(name)
    if body is not None:
        return body
    if budget is not None and state["requests"] >= budget:
        return None
    for attempt in range(6):
        time.sleep(state["spacing"])
        state["requests"] += 1
        try:
            request = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(request, timeout=25, context=CTX) as response:
                body = json.load(response)
            store(name, body)
            state["blocked"] = 0
            state["spacing"] = max(0.6, state["spacing"] * 0.95)
            return body
        except urllib.error.HTTPError as error:
            if error.code not in (403, 429):
                print(f"  {name}: http {error.code}", file=sys.stderr)
                return None
            state["blocked"] += 1
            state["spacing"] = min(8.0, state["spacing"] * 2)
            print(f"  throttled, spacing now {state['spacing']:.1f}s", flush=True)
            time.sleep(min(60, 5 * state["blocked"]))
        except Exception as error:  # noqa: BLE001 - network weather
            print(f"  {name}: {type(error).__name__}", file=sys.stderr)
            time.sleep(2 * (attempt + 1))
    return None


def pairs_from_routes() -> tuple[list[list], int, int]:
    body = fetch("routes.json", f"{BASE}/route", None)
    if not body:
        raise SystemExit("could not read the route list")
    pairs = []
    resolved = 0
    total = 0
    for region, codes in body["data"]["routes"].items():
        for code in codes:
            total += 1
            detail = fetch(f"route-{region}-{code}.json", f"{BASE}/route/{region}/{code}", None)
            if detail:
                resolved += 1
                for variant in detail.get("data") or []:
                    route_id = variant.get("route_id")
                    for direction in variant.get("directions") or []:
                        seq = direction.get("route_seq")
                        if route_id is not None and seq is not None:
                            pairs.append([route_id, seq, code])
    return pairs, resolved, total


def write_route_map(routes: dict[int, str]) -> None:
    body = "{" + ",".join(f'"{route_id}":"{code}"' for route_id, code in sorted(routes.items())) + "}\n"
    path = ROOT / "server" / "data" / "gmb-routes.json"
    path.write_text(body)
    print(f"{path.name}: {len(routes)} route ids carry a route number")


def fetch_kml(refresh: bool) -> Path:
    path = CACHE / "KML_GMB.zip"
    if path.exists() and not refresh:
        return path
    CACHE.mkdir(parents=True, exist_ok=True)
    print("downloading KML_GMB.zip", flush=True)
    request = urllib.request.Request(KML_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=60, context=CTX) as response:
        path.write_bytes(response.read())
    return path


def route_map_from_kml(path: Path) -> dict[int, str]:
    routes: dict[int, str] = {}
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.endswith(".kml"):
                continue
            root = ET.fromstring(archive.read(name))
            values: dict[str, str] = {}
            for data in root.iter():
                if not data.tag.endswith("Data"):
                    continue
                key = data.attrib.get("name")
                if key not in ("routeId", "routeNameC") or key in values:
                    continue
                value = next((child for child in data if child.tag.endswith("value")), None)
                if value is not None:
                    values[key] = (value.text or "").strip()
            route_id = values.get("routeId")
            code = values.get("routeNameC")
            if route_id and code:
                routes[int(route_id)] = code
    if not routes:
        raise SystemExit("KML_GMB.zip had no route ids")
    return routes


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--budget", type=int, default=None)
    parser.add_argument("--routes-only", action="store_true")
    parser.add_argument("--refresh-kml", action="store_true")
    args = parser.parse_args()

    kml_routes = route_map_from_kml(fetch_kml(args.refresh_kml))
    write_route_map(kml_routes)
    if args.routes_only:
        return

    pairs, resolved, total = pairs_from_routes()
    if resolved == total:
        api_routes = {int(route_id): code for route_id, _seq, code in pairs}
        write_route_map({**kml_routes, **api_routes})
    else:
        print(f"route map kept from KML; {resolved}/{total} API route details cached")
    by_stop: dict[str, set[str]] = {}
    done = 0
    exhausted = False
    for route_id, seq, code in pairs:
        body = fetch(f"stop-{route_id}-{seq}.json", f"{BASE}/route-stop/{route_id}/{seq}", args.budget)
        if body is None:
            exhausted = exhausted or (
                args.budget is not None and state["requests"] >= args.budget
            )
            continue
        done += 1
        for stop in body.get("data", {}).get("route_stops") or []:
            stop_id = stop.get("stop_id")
            if stop_id is not None:
                by_stop.setdefault(str(stop_id), set()).add(code)
    print(f"route sequences cached: {done}/{len(pairs)} | requests this run: {state['requests']}")

    if exhausted and done < len(pairs):
        print("budget reached; run again to continue")
        return

    path = ROOT / "server" / "data" / "stops.json"
    data = json.loads(path.read_text())
    hits = 0
    for stop in data["stops"]:
        if stop["mode"] != "minibus":
            continue
        stop_id = stop["id"].split(":")[1]
        codes = sorted(by_stop.get(stop_id, []))
        if codes:
            stop["routes"] = codes
            hits += 1
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"{path.name}: {hits} minibus stops carry route numbers")


if __name__ == "__main__":
    main()
