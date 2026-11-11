# Frontend

The Next.js page. The build spec is [TECH-STACK.md](TECH-STACK.md). The product is [DESIGN.md](DESIGN.md). Bun installs this app. The page loads the saved stop list in `web/public/stops.json` when it starts. It does not call the API, data.gov.hk, the bus ETA hosts, or the MTR feed. There is no sign-in.

The first demo is the map in `web/`. The service list is [server/CHECKLIST.md](server/CHECKLIST.md).

```text
GET /stops?south&west&north&east&modes
    { "stops": [ { "id", "mode", "name", "latitude", "longitude" } ] }

GET /stops/{id}/arrivals
    { "fetched_at", "live", "rows": [ { "route", "destination", "minutes" } ] }
```

`id` is the publisher's id with a mode prefix: `mtr:`, `bus:`, `minibus:`, or `taxi:`. `modes` is the subset the user has switched on. `minutes` is absent when the feed gives a clock time instead. A taxi stand has no arrivals document.

## App

- [x] One Next.js route, installed with Bun. The map fills the viewport.
- [x] MapLibre loads only in the browser.
- [x] OpenStreetMap raster tiles, with `© OpenStreetMap contributors` on the map.
- [x] The map opens on Hong Kong. It does not pitch or rotate.
- [x] No sign-in control, no account, and no saved-stop list.

## Stops

- [x] On start, load every stop from `web/public/stops.json`.
- [x] On move end, draw the saved stops in the current view. The page does not call a server.
- [x] Draw one stop per saved record, at that record's coordinates. The client does not invent an id or a coordinate.
- [x] Four filters: MTR, bus, minibus, taxi. Hiding a mode drops it from the map.
- [ ] Several bus poles on the same pavement stay separate points when their ids differ.
- [ ] Red minibuses are not drawn. Taxis are stands, not moving vehicles.
- [ ] A stop that is absent from the response is not drawn. Do not keep points from the previous view.

## Arrivals

- [x] Tapping a stop opens its saved name and mode. The static page does not request arrivals.
- [ ] List rows soonest first. Each row shows the route, the destination, and the minutes or the clock time.
- [ ] Show the age from `fetched_at`.
- [ ] `live: false` is a timetable. The sheet says the arrival is not live.
- [ ] A missing or expired snapshot says the snapshot is gone. The stop stays on the map.
- [ ] A taxi stand opens its name and says there is no arrival list.
- [ ] An MTR station lists the next train on each line the feed returned, and the line status when that field is present.
- [ ] The page does not compute an ETA.

## Checks

- [ ] Panning with bus hidden does not request or draw bus stops.
- [ ] A signed-out visitor, which is every visitor, can open a stop.
- [ ] Two stops with different ids at nearly the same place are both tappable.
- [ ] A stale snapshot stays visible and shows its age.
- [ ] A green minibus stop with `live: false` shows the timetable and the not-live line.
- [ ] A taxi stand does not show a vehicle or a minute count.
