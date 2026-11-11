# Frontend

The Next.js page. The build spec is [TECH-STACK.md](TECH-STACK.md). The product is [DESIGN.md](DESIGN.md). Bun installs this app. The page does not call data.gov.hk, the bus ETA hosts, or the MTR feed. It draws what Rust last stored. There is no sign-in.

Nothing here is built yet. The service list is [server/CHECKLIST.md](server/CHECKLIST.md).

```text
GET /stops?south&west&north&east&modes
    { "stops": [ { "id", "mode", "name", "latitude", "longitude" } ] }

GET /stops/{id}/arrivals
    { "fetched_at", "live", "rows": [ { "route", "destination", "minutes" } ] }
```

`id` is the publisher's id with a mode prefix: `mtr:`, `bus:`, `minibus:`, or `taxi:`. `modes` is the subset the user has switched on. `minutes` is absent when the feed gives a clock time instead. A taxi stand has no arrivals document.

## App

- [ ] One Next.js route, installed with Bun. The map fills the viewport.
- [ ] MapLibre loads only in the browser.
- [ ] OpenStreetMap raster tiles, with `© OpenStreetMap contributors` on the map.
- [ ] The map opens on Hong Kong. It does not pitch or rotate.
- [ ] No sign-in control, no account, and no saved-stop list.

## Stops

- [ ] On move end, `GET /stops` for the current view and the modes that are on.
- [ ] Draw one point per stop at the coordinates in the response. The client does not invent an id or a coordinate.
- [ ] Four filters: MTR, bus, minibus, taxi. Hiding a mode drops it from the next request and from the map.
- [ ] Several bus poles on the same pavement stay separate points when their ids differ.
- [ ] Red minibuses are not drawn. Taxis are stands, not moving vehicles.
- [ ] A stop that is absent from the response is not drawn. Do not keep points from the previous view.

## Arrivals

- [ ] Tapping a stop opens its sheet and loads `GET /stops/{id}/arrivals`.
- [ ] Show a loading state and a failure state. Do not keep the previous stop's rows.
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
