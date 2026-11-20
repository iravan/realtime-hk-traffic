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
| P2 | Deduplicate `stops.json` | Up to 2.28 MB less tracked duplication | Low | Low | Open |
| P2 | Generate the GMB route map offline | Fewer throttled API calls | Low | Low | Open |
| P2 | Generate MTR stop entries and line terminals | Single source of truth | Low | Low | Open |
| P2 | Verify compression and cache headers | Smaller repeat visits | Low | Low | Open |

## Measurements

| File | Raw | gzip |
| --- | ---: | ---: |
| `server/data/stops.json` | 2.28 MB | 569 KB |
| `web/public/stops.json` | 2.28 MB | 569 KB |
| `web/public/mtr-lines.geojson` | 678 KB | 159 KB |
| `web/public/service-hours.json` | 210 KB | 20 KB |
| `server/data/mtr.json` | 11.6 KB | 2.8 KB |
| `server/data/gmb-routes.json` | 12.3 KB | 3.3 KB |

The two stop catalogues are byte-identical. Per-mode gzip sizes:

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

- Split `web/public/stops.json` into `stops-bus.json`, `stops-minibus.json`,
  `stops-taxi.json` and `stops-mtr.json` at build time.
- Load the active mode first.
- Prefetch the other modes after the active catalogue is interactive.
- Keep the full `stops.json` for the server and for compatibility.
- Ignore the generated per-mode files in Git.

**Validation.**

- The default bus tab requests `stops-bus.json` only, at 357 KB gzip.
- Each tab requests its own file: minibus 185 KB, taxi 25 KB, MTR 2.6 KB.
- Mode switching and nearest-stop selection still work.
- `bunx tsc --noEmit` and `bun run build` pass.

**Risk.** Medium. More files and a small loading state. The idle prefetch should
keep tab switches fast.

## P2: Deduplicate `stops.json`

**Problem.** `server/data/stops.json` and `web/public/stops.json` are
byte-identical, 2.28 MB each. Both are tracked in the repository.

**Proposed change.**

- Keep one canonical file and generate the other in a prebuild step.
- Because the Vercel services use separate roots, a generated copy is safer than
  a single shared path.
- Add a CI check that fails if the two files differ.

**Validation.**

- Both service and page still receive the same catalogue.
- The generated file is reproducible.
- CI catches a mismatch before deployment.

**Risk.** Low. If generation is added to the wrong service root, the build will
fail before deployment.

## P2: Generate the GMB route map offline

**Problem.** `server/data/gmb-routes.json` maps 779 numeric route ids to route
numbers. `KML_GMB.zip` contains the same 779 route ids, and `ROUTE_GMB.xml`
contains the official route and fare reference. The current generation script
uses the throttled GMB API to build the map.

**Proposed change.**

- Generate `gmb-routes.json` from `KML_GMB.zip` or `ROUTE_GMB.xml`.
- Keep the API crawl only for detecting routes that appeared after the archive.
- Add a check that every route id used by the API has a map entry.

**Validation.**

- Generated map matches the current `gmb-routes.json` keys and values.
- Minibus arrivals render the printed route number, not the numeric id.

**Risk.** Low. Keep the current map in the repository until the new generator
produces an identical result.

## P2: Generate MTR stop entries and line terminals

**Problem.** The 98 MTR stops appear in both `server/data/mtr.json` and
`stops.json`. Line terminal names are also hardcoded in `web/app/page.tsx`.

**Proposed change.**

- Generate the MTR subset of the stop catalogue from `server/data/mtr.json`.
- Generate the line terminal labels from the same station data or the MTR CSV.
- Keep one checked-in source of station names, coordinates and lines.

**Validation.**

- MTR stop count, names and coordinates match the current catalogue.
- Line tooltips show the same endpoints as today.

**Risk.** Low. This is a maintainability change, not a runtime change.

## P2: Verify compression and cache headers

**Problem.** The static files are much smaller when compressed:

- `stops.json`: 2.28 MB to 569 KB gzip
- `mtr-lines.geojson`: 678 KB to 159 KB gzip
- `service-hours.json`: 210 KB to 20 KB gzip

**Proposed change.**

- Confirm the production host serves gzip or Brotli for JSON and GeoJSON.
- Give versioned static assets a long cache lifetime.
- Avoid serving uncompressed copies from a static host.

**Validation.**

- Check the production response headers with `curl -I`.
- Confirm the transferred size and cache status in browser dev tools.

**Risk.** Low. This is a hosting and caching check, not an application change.
