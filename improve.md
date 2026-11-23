# Improvement backlog

Static and reference data improvements for Realtime HK Traffic. Measurements
were taken from the current repository on 20 November 2026. Items are ordered by
expected impact.

## Priority summary

| Priority | Item | Main impact | Effort | Risk | Status |
| --- | --- | --- | --- | --- | --- |
| P0 | Gate startup catalogue crawls | Faster cold start; fewer upstream requests | Medium | Medium | Done |
| P1 | Lazy-load the MTR line layer | 159 KB gzip less for non-MTR first load | Low | Low | Done |
| P1 | Split the stop catalogue by mode | About 212 KB gzip less on first bus load | Medium | Medium | Done |
| P2 | Deduplicate `stops.json` | Up to 2.28 MB less tracked duplication | Low | Low | Done |
| P2 | Generate the GMB route map offline | Fewer throttled API calls | Low | Low | Done |
| P2 | Generate MTR stop entries and line terminals | Single source of truth | Low | Low | Done |
| P2 | Verify compression and cache headers | Smaller repeat visits | Low | Low | Done |

## Measurements

| File | Raw | gzip |
| --- | ---: | ---: |
| `server/data/stops.json` | 2.28 MB | 569 KB |
| `web/public/stops.json` (generated) | 2.28 MB | 569 KB |
| `web/public/mtr-lines.geojson` | 678 KB | 159 KB |
| `web/public/service-hours.json` | 210 KB | 20 KB |
| `server/data/mtr.json` | 11.6 KB | 2.8 KB |
| `server/data/gmb-routes.json` | 12.3 KB | 3.3 KB |

The generated web copy is byte-identical to the canonical server file. Per-mode
gzip sizes:

| Mode | Stops | gzip |
| --- | ---: | ---: |
| Bus | 9,366 | 357 KB |
| Minibus | 4,772 | 185 KB |
| Taxi | 518 | 25 KB |
| MTR | 98 | 2.6 KB |

## P0: Gate startup catalogue crawls

**Status: done.** The server now defaults to the bundled catalogue. Set
`LIVE_CATALOGUES=1` to run the live KMB, taxi, Citybus and GMB catalogue crawls
at startup. Logs now report new and updated counts per source.

**Problem.** Before this change, `server/src/main.rs::load_catalogues` seeded the
bundled catalogue, then still ran the live KMB, taxi, Citybus and GMB catalogue
crawls. The GMB crawl in `server/src/catalog.rs::minibus_stops` fetched every
route, route-stop sequence and stop. The current data has 4,772 minibus stops
and 779 route ids. Citybus similarly walked routes, route-stops and stops. This
happened on every cold start even though `server/data/stops.json` already
contains those stops.

**Implemented change.**

- Default to the bundled catalogue.
- Put live catalogue refresh behind `LIVE_CATALOGUES=1`.
- Keep MTR codes and lines local through `server/data/mtr.json`.
- Log how many stops were added or updated by each source.

**Validation.**

- With refresh disabled, a cold start makes no calls to the bus, minibus or taxi
  catalogue hosts.
- The bundled stop count and MTR arrivals are unchanged.
- With refresh enabled, the existing crawl path is preserved.
- `cargo check`, `cargo test` and a local startup smoke test pass.

**Risk.** The bundled catalogue may miss newly added stops until it is
regenerated. Mitigate with `LIVE_CATALOGUES=1` when freshness matters, or
regenerate `server/data/stops.json`.

## P1: Lazy-load the MTR line layer

**Status: done.** `mtr-lines.geojson` is fetched once, when the MTR tab is first
opened. The bus, minibus and taxi tabs no longer request it.

**Problem.** `web/app/page.tsx` previously added the `mtr-lines` source with
`web/public/mtr-lines.geojson` during map load. The file is 678 KB raw and
159 KB gzip, and was fetched even when the default bus tab was active.

**Implemented change.**

- The source starts with an empty `FeatureCollection`.
- The first MTR draw fetches the GeoJSON and sets it on the source.
- A ref prevents duplicate fetches across redraws and tab switches.
- A failed fetch leaves the source empty and retries on the next MTR draw.

**Validation.**

- The bus, minibus and taxi tabs do not request `mtr-lines.geojson`.
- The first MTR tab activation fetches it once and draws the line layer.
- Line hover and selection still work.
- `bunx tsc --noEmit` and `bun run build` pass.

**Risk.** Low. Handle the small window between tab activation and the GeoJSON
arriving; the layers can stay hidden until the source has data.

## P1: Split the stop catalogue by mode

**Status: done.** `web/scripts/split-stops.mjs` runs from `predev` and
`prebuild`, writing one `stops-{mode}.json` per mode. The page loads the active
mode first and prefetches the other modes after two seconds.

**Problem.** The page previously loaded all 14,754 stops at once. The full
catalogue is 2.28 MB raw and 569 KB gzip, while only one mode is drawn at a
time.

**Implemented change.**

- Copy the canonical `server/data/stops.json` to `web/public/stops.json` at
  build time.
- Split it into `stops-bus.json`, `stops-minibus.json`, `stops-taxi.json` and
  `stops-mtr.json`.
- Load the active mode first.
- Prefetch the other modes after the active catalogue is interactive.
- Ignore the generated web copy and per-mode files in Git.

**Validation.**

- The default bus tab requests `stops-bus.json` only, at 357 KB gzip.
- Each tab requests its own file: minibus 185 KB, taxi 25 KB, MTR 2.6 KB.
- Mode switching and nearest-stop selection still work.
- `bunx tsc --noEmit` and `bun run build` pass.

**Risk.** Medium. More files and a small loading state. The idle prefetch should
keep tab switches fast.

## P2: Deduplicate `stops.json`

**Status: done.** `server/data/stops.json` is now the only tracked stop
catalogue. `web/public/stops.json` is generated from it during `predev` and
`prebuild` and ignored by Git.

**Problem.** `server/data/stops.json` and `web/public/stops.json` were
byte-identical, 2.28 MB each. Both were tracked in the repository.

**Implemented change.**

- Keep `server/data/stops.json` as the canonical file.
- Copy it to `web/public/stops.json` in `web/scripts/split-stops.mjs`.
- Generate the per-mode files from the same canonical copy.
- Update the minibus and night scripts to write only the canonical file.
- Ignore the generated web copy and per-mode files in Git.

**Validation.**

- The web build works with no tracked `web/public/stops.json`.
- The generated copy matches the canonical file.
- Per-mode files still split correctly.
- `bunx tsc --noEmit` and `bun run build` pass.

**Risk.** Low. If generation is added to the wrong service root, the build will
fail before deployment.

## P2: Generate the GMB route map offline

**Status: done.** `fetch-minibus-routes.py --routes-only` now builds
`gmb-routes.json` from `KML_GMB.zip` and exits without calling the GMB API. A
full run seeds from KML, then merges API details to pick up new routes.

**Problem.** `server/data/gmb-routes.json` maps 779 numeric route ids to route
numbers. `KML_GMB.zip` contains the same 779 route ids, and `ROUTE_GMB.xml`
contains the official route and fare reference. The generation script previously
used the throttled GMB API to build the map.

**Implemented change.**

- Download and cache `KML_GMB.zip` under `.cache/gmb`.
- Parse `routeId` and `routeNameC` from every KML document.
- Write `gmb-routes.json` from the KML map.
- `--routes-only` returns before any API call.
- A full run merges API route details over the KML map for new routes.

**Validation.**

- Generated map matches the current `gmb-routes.json` keys and values exactly.
- The offline run writes 779 route ids.
- Minibus arrivals still render printed route numbers, not numeric ids.

## P2: Generate MTR stop entries and line terminals

**Status: done.** `scripts/build-mtr-catalogue.py` syncs the `mtr:` rows
in `server/data/stops.json` from `mtr.json` and generates
`web/app/mtr-line-terminals.json` from the MTR CSV. The page imports the JSON
instead of hardcoding terminal names.

**Problem.** The 98 MTR stops appeared in both `server/data/mtr.json` and
`stops.json`. Line terminal names were hardcoded in `web/app/page.tsx`.

**Implemented change.**

- Build the MTR subset of the stop catalogue from `server/data/mtr.json`.
- Derive terminal labels from the MTR CSV and the station lookup.
- Write `web/app/mtr-line-terminals.json` and import it in the page.
- Add `--refresh` to download the CSV again instead of using the cache.

**Validation.**

- The script reports 98 MTR stops with 0 changes against the current catalogue.
- Generated line terminals match the previous hardcoded labels exactly.
- The page type-checks and builds with the JSON import.

**Risk.** Low. This is a maintainability change, not a runtime change.

## P2: Verify compression and cache headers

**Status: verified.** GitHub Pages serves gzip for the JSON and GeoJSON assets
and sends `vary: Accept-Encoding`. It also sends `cache-control: max-age=600`,
so repeat visits revalidate after ten minutes.

**Verified headers.**

| Asset | Raw | Transferred gzip | Cache |
| --- | ---: | ---: | --- |
| `stops-bus.json` | 1,388,089 B | 358,774 B | `max-age=600` |
| `service-hours.json` | 210,287 B | 21,443 B | `max-age=600` |
| `mtr-lines.geojson` | 678,252 B | 160,147 B | `max-age=600` |

All three responses also carry `etag`, `last-modified` and
`vary: Accept-Encoding`.

**Vercel.** `https://realtime-hk-traffic.vercel.app` uses Brotli instead of gzip
(`content-encoding: br`), but currently sends
`cache-control: public, max-age=0, must-revalidate`. That means repeat visits
always revalidate. `vercel.json` now sets one-hour caching with background
revalidation for `stops-*.json`, `service-hours.json` and
`mtr-lines.geojson`:

```text
public, max-age=3600, stale-while-revalidate=86400
```

Recheck after the next deployment:

```bash
curl -sI --compressed https://realtime-hk-traffic.vercel.app/stops-bus.json
```

Expect `content-encoding: br` and the new `cache-control` value.

**Conclusion.** Compression is already effective on both hosts. GitHub Pages
caps static-file caching at ten minutes; Vercel now has a longer policy in
config. The filenames are not content-hashed, so the cache stays bounded to
avoid serving stale data indefinitely.

**Recommendation.** Keep the Vercel header policy and recheck it after deploy.
On GitHub Pages, keep the ten-minute cache because custom headers are not
available.
