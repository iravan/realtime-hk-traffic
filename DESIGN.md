# Realtime HK Traffic

A live map of public-transport stops in Hong Kong. MTR stations, franchised bus stops, green minibus stops, and taxi stands. Open a stop and see the next arrivals that an official feed is publishing now.

This repository is that idea, and it has no app code yet.

## Stops

A stop is one place a passenger can board. The map uses the coordinates and the id from the feed. The client does not invent a stop.

| Mode | What a stop is |
| --- | --- |
| MTR | A station. The arrivals are the next trains on the lines that serve it. |
| Bus | One stop for KMB, LWB, Citybus, or New Lantao Bus. Several poles on the same pavement stay separate stops when the feeds give them separate ids. |
| Minibus | A green minibus stop. Red minibuses have no official stop list with live arrivals, so they are not drawn. |
| Taxi | A taxi stand. A stand is a place to hire a taxi. It is not a vehicle. |

## What is live

The server polls the official feeds and keeps the latest snapshot. The browser does not call those feeds itself.

- **MTR.** Next train on each line at the station, and the line service status when the feed includes it. Source: the MTR next-train feed on data.gov.hk.
- **Bus.** Estimated minutes until the next buses at that stop, the route number, the destination, and the time the estimate was fetched. Sources: the KMB and LWB feeds, and the Citybus and New Lantao Bus feeds, published for the Transport Department.
- **Green minibus.** The same arrival shape, only for routes an official ETA feed covers. A stop that has a timetable but no ETA shows the timetable and says the arrival is not live. Red minibuses stay off the map.
- **Taxi.** The stand's name and location from the taxi-stand dataset. Hong Kong does not publish a feed of every taxi's position, so the map does not draw moving taxis.

Each arrival stores when it was fetched. The page shows that age. A snapshot past the feed's useful life is marked stale and stays visible until a newer one replaces it.

## Map

One page. OpenStreetMap is the basemap. Stops are points on top of it.

The user can show or hide each mode: MTR, bus, minibus, taxi. Tapping a stop opens its arrivals, soonest first. A stop with no live arrival shows that plainly.

Moving the map asks the server for the stops inside the view. The client does not choose which arrivals are current. It draws what the server last stored.

There is no sign-in. Anyone can pan and open stops.

## What this does not do yet

It does not poll a feed, store a stop, or draw the map. The build is specified in [TECH-STACK.md](TECH-STACK.md). The page is listed in [CHECKLIST.md](CHECKLIST.md). The service is listed in [server/CHECKLIST.md](server/CHECKLIST.md).
