# Backend

The Rust service. The build spec is [TECH-STACK.md](../TECH-STACK.md). The product is [DESIGN.md](../DESIGN.md). The page list is [CHECKLIST.md](../CHECKLIST.md). This service polls the official feeds, stores the latest snapshot, and answers the public routes. Next.js does not poll. There is no sign-in.

The first demo is running locally. Redis for local development is `127.0.0.1:6379`. KMB, the MTR station list, and taxi stands load before Citybus and green minibus, which continue in the background.

A stop id is the publisher's id with a mode prefix, so two feeds cannot collide: `mtr:`, `bus:`, `minibus:`, `taxi:`.

```text
GET /stops?south&west&north&east&modes
    { "stops": [ { "id", "mode", "name", "latitude", "longitude" } ] }

GET /stops/{id}/arrivals
    { "fetched_at", "live", "rows": [ { "route", "destination", "minutes" } ] }
```

`modes` is a comma-separated subset of `mtr`, `bus`, `minibus`, `taxi`. `minutes` is omitted when the feed gives a clock time instead; that row then has `time`. A taxi stand has no arrivals key, and `GET` for it says there is no arrival list.

```text
stop:{id}                     string
                              { "mode", "name", "latitude", "longitude" }
arrivals:{id}                 string, EX from that feed's interval
                              { "fetched_at", "live", "rows" }
```

## Service

- [x] Axum and Tokio. One process owns the HTTP routes and the catalogue loaders.
- [x] Config: Redis URL, bind address, and a 60-second arrival cache. No feed is called from Next.js.
- [x] CORS allows the Next.js origin (`CORS_ORIGINS`, including port 3000 and 3002).
- [x] Both routes are public. There is no JWT and no saved-stop key.

## Stops

- [x] Load KMB stops, a fixed MTR station list, and the taxi-stand dataset. Citybus and green minibus catalogues load after the server is already answering.
- [ ] Finish Citybus and green minibus catalogues, and add New Lantao Bus when its stop list is non-empty.
- [ ] Write `stop:{id}` with mode, name, and the coordinates from that catalogue.
- [ ] `GET /stops` returns only the stops inside the box whose mode is in `modes`.
- [ ] A stop absent from the box is absent from the response. Do not invent ids or coordinates.
- [ ] Reject a box that is not finite or whose south is not below north.
- [ ] Red minibuses are not loaded. Taxi stands are places, not vehicles.

## Arrivals

- [ ] Poll the MTR next-train feed. Store the next train on each line, the destination, the minutes or the clock time, and the line status when the feed has it.
- [ ] Poll the KMB, LWB, Citybus, and New Lantao Bus ETA feeds. Store route, destination, minutes, and `fetched_at`.
- [ ] Poll the green-minibus ETA feed where a route has one. Set `live` true.
- [ ] Where a green minibus stop has a timetable and no ETA, store the scheduled times with `live` false.
- [ ] Do not write `arrivals:{id}` for a taxi stand.
- [ ] `GET /stops/{id}/arrivals` returns the stored snapshot, soonest first. The handler does not compute an ETA.
- [ ] A missing or expired arrivals key is a gone snapshot, not an empty timetable.
- [ ] An unknown id is rejected. A taxi id returns the no-arrival result, not a 500.

## Freshness

- [ ] Each arrivals string uses `EX` from that feed's poll interval, so a dead poller drops the snapshot.
- [ ] `fetched_at` is the server clock at the successful poll, not a time from the page.
- [ ] A failed poll does not delete a still-fresh snapshot.
- [ ] The MTR poll, the bus polls, and the minibus poll run on their own intervals in the same process.

## Local run

- [ ] Redis on `127.0.0.1:6379`.
- [ ] The service listens for the page. Document the URL the page calls.

## Checks

- [ ] `GET /stops` with no session returns the stops in the box.
- [ ] Hiding bus in `modes` omits bus stops.
- [ ] Two catalogue ids on the same pavement are two records.
- [ ] A bus ETA snapshot lists route, destination, minutes, and `fetched_at`.
- [ ] A green minibus timetable is returned with `live` false.
- [ ] A taxi stand is on the map and has no arrival rows and no vehicle position.
- [ ] After the arrivals key expires, the stop remains and the arrivals route reports the snapshot gone.
- [ ] A failed poll leaves the previous unexpired snapshot in place.
