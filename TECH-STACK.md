# Tech stack

This is how [DESIGN.md](DESIGN.md) is built. The repository still has no app code. The shape matches the 到此一遊 stack: a Next.js page, a Rust service, Redis for the live data, and MapLibre on OpenStreetMap. Bun installs the page. Supabase Auth is only the optional saved-stop list.

## Stack

| Piece | Choice | Role |
| --- | --- | --- |
| Page | Next.js, package manager Bun | Map, mode filters, stop sheet, saved stops |
| Map | MapLibre GL JS, client only | OpenStreetMap raster basemap and the stop layer |
| API | Rust, Axum, Tokio | Poll the official feeds, serve stops and arrivals |
| Store | Redis | The latest stop list and the latest arrival snapshot |
| Sign-in | Supabase Auth | Apple, Google, and Facebook, only for saved stops |
| Clock | Rust process | Polls each feed on its own interval and drops stale snapshots |

The browser never calls data.gov.hk, the bus ETA hosts, or the MTR feed. Those hosts throttle and they are not a page's job. Next.js renders and, when someone signs in, keeps the Supabase session. Rust polls, stores, and answers.

The public `tile.openstreetmap.org` images are the basemap for a light deployment, with `© OpenStreetMap contributors` on the map. A public launch moves the basemap to a tile host that allows the traffic. The stops are drawn by this app either way.

## Feeds

Rust is the only poller.

| Mode | Publisher | What is stored |
| --- | --- | --- |
| MTR | MTR next-train feed on data.gov.hk | Station, line, destination, minutes or clock time, fetch time |
| Bus | KMB, LWB, Citybus, and New Lantao Bus ETA feeds | Stop id, route, destination, minutes, fetch time |
| Minibus | Green-minibus ETA feed on data.gov.hk, where a route has one | Same arrival shape as a bus. No ETA means the timetable only, marked not live |
| Taxi | Taxi-stand locations on data.gov.hk | Stand id, name, coordinates. No vehicle positions |

A stop id is the publisher's id, prefixed by the mode so two feeds cannot collide: `mtr:`, `bus:`, `minibus:`, `taxi:`.

## Page

One Next.js route. The map component loads only in the browser, because MapLibre uses WebGL.

Without a Supabase session the route is the map and the stop sheet. There is no saved-stop list. `GET /stops` and `GET /stops/{id}/arrivals` stay public.

The viewport asks Rust for stops:

```text
GET /stops?south&west&north&east&modes
```

`modes` is the subset the user has switched on. Each item is the stop id, the mode, the name, and the coordinates. Tapping a stop loads:

```text
GET /stops/{id}/arrivals
```

The list is the latest snapshot, soonest first. Every row includes the fetch time so the page can show the age.

## Redis

```text
stop:{id}                     string
                              { "mode", "name", "latitude", "longitude" }
arrivals:{id}                 string, EX set from the feed interval
                              { "fetched_at", "live", "rows" }
```

`rows` is the next arrivals. For a taxi stand the arrivals key is absent. For a green minibus stop with only a timetable, `live` is false and the rows are the scheduled times.

The poller writes both keys. A reader never computes an ETA. If `arrivals:{id}` has expired, the stop is still on the map and the sheet says the snapshot is gone.

## Sign-in

Supabase Auth is the only sign-in. Apple, Google, and Facebook are enabled. Email, phone, magic link, anonymous, and every other provider stay disabled.

The page shows those three buttons and no other way in. Reading the map does not require a session. Saving a stop does. Rust checks the JWT against the Supabase JWKS and reads `sub` as the user id.

```text
saved:{user}                  set of stop ids
```

Two browsers signed in as the same user share one set.

## First build

1. Stop list for all four modes, from the official catalogues, drawn on the map.
2. Rust poller for MTR next train and for franchised-bus ETA. Redis holds the snapshot. The sheet reads it.
3. Green minibus ETA where the feed has it, and timetable-only where it does not.
4. Taxi stands as places, with no vehicle layer.
5. Optional saved stops behind Supabase Auth.
6. Redis on `127.0.0.1:6379` for local development. The page is installed with Bun.

## Out of scope

Live positions of taxis, red minibuses, and private cars are out of scope. So is writing back to any transport feed. A saved stop is a bookmark, not a profile.
