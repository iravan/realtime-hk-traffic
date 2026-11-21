# Realtime HK Traffic

A live map of public-transport stops in Hong Kong. MTR stations, franchised bus stops, green minibus stops, and taxi stands. Open a stop and see the next arrivals that an official feed is publishing now.

## Goal

Show each public-transport vehicle on the map at its live position. A marker is the vehicle itself, and a newer position replaces the last one.

Franchised buses are the first target. Green minibuses, MTR trains, and taxis are the same goal when a position exists for that vehicle.

The current page draws stops and stations from a saved list. It does not draw a moving vehicle.

Official open data, checked in November 2026, publishes the next arrival at a bus stop or green-minibus stop. Coordinates in those feeds are the stop, not the vehicle. Licensed fleet taxis from Joie and Amigo publish latitude, longitude, and operating status for their own vehicles, about every 30 seconds. Ordinary street taxis are outside that feed.

The source and the method are open. This document does not choose them.

## Stops

A stop is one place a passenger can board. The map uses the coordinates and the id from the feed. The client does not invent a stop.

| Mode | What a stop is |
| --- | --- |
| MTR | A station. The arrivals are the next trains on the lines that serve it. |
| Bus | One stop for KMB, LWB, Citybus, or New Lantao Bus. Ids a feed publishes at the same coordinate are one point on the map, and their arrivals are merged. Poles at different coordinates stay separate stops. |
| Minibus | A green minibus stop. Red minibuses have no official stop list with live arrivals, so they are not drawn. |
| Taxi | A taxi stand. A stand is a place to hire a taxi. It is not a vehicle. |

## What is live

The server fetches an official feed when a stop is opened, and keeps that snapshot for 90 seconds. The browser does not call those feeds itself.

- **MTR.** Next train on each line at the station, and the line service status when the feed includes it. Source: the MTR next-train feed on data.gov.hk.
- **Bus.** Estimated minutes until the next buses at that stop, the route number, the destination, and the time the estimate was fetched. Sources: the KMB and LWB feeds, and the Citybus and New Lantao Bus feeds, published for the Transport Department. The destination follows the language of the page. Citybus sends one language at a time, so the server requests English and Traditional Chinese and keeps both.
- **Green minibus.** The same arrival shape, only for routes an official ETA feed covers. The destination is the route direction's end, in the current language. A vehicle that has not left its first stop is marked 始站 未開出 (Origin, not yet departed) beside the wait. A stop the ETA feed does not cover has no arrival rows, and the sheet says there are no arrivals right now. A timetable fallback, labelled not live, is planned (see [server/CHECKLIST.md](server/CHECKLIST.md)). Red minibuses stay off the map.
- **Taxi.** The stand's name and location from the taxi-stand dataset. Hong Kong does not publish a feed of every taxi's position, so the map does not draw moving taxis.

Each arrival stores when it was fetched. The page shows that age. A snapshot past the feed's useful life is marked stale and stays visible until a newer one replaces it.

## Service hours

`web/public/service-hours.json` holds the static service window for each mode, each MTR station, each green-minibus route the catalogue names, and each Star Ferry pier. A stop is drawn as its mode sign only while a window covers the current Hong Kong time. Outside that window it shrinks to a grey dot and does not open its sheet: a grey dot is a location, not a control. A ferry pier stays coloured and clickable outside its window. When the pier is in `web/public/ferry-services.json`, the sheet lists each sailing's destination, first boat, and last boat instead of the single window. A pier whose wiki page has no first and last boat keeps the ferry default. Star Ferry hours are route entries keyed by stop id: Central Pier 7 and Tsim Sha Tsui 06:30–23:30, Wan Chai 07:30–23:00. Other piers use the ferry default, 03:00–01:00. On Sundays and public holidays the first Wan Chai boat is 07:40; the stored window opens at 07:30. A stop with no matching entry keeps its mode default, so a gap in the data never greys a running stop. A window that ends after midnight is written with an end time earlier than its start.

Some bus and minibus routes run overnight. A stop served by one of them carries `night: true` in the stop list, so it stays in its mode colour and clickable for the whole day. `server/scripts/fetch-night-stops.py` derives that flag from the stops of every KMB or Citybus route whose code starts with `N` and every green-minibus route whose timetable covers the small hours. Re-run the script to refresh the flags.

## Map

One page. OpenStreetMap is the basemap. Stops are points on top of it.

The user chooses one mode at a time: MTR, bus, minibus, ferry, taxi. A wait of 60 minutes or more is shown as hours and leftover minutes. A wait under one minute says Due (即將到站). The map asks for the device location when the browser grants it. The stop opened most recently is opened again and the map moves to it. Each tab keeps its own stop, and choosing a tab returns to that stop. A tab with no remembered stop opens the nearest one. A locate button asks the device again, moves the map back to it, and reselects the nearest stop, so a visitor who has panned away does not have to reload the page. The selected stop is ringed on the map. Tapping a stop opens its arrivals, soonest first. One departure appears once, even when a feed lists it under several service types. A stop with no live arrival shows that plainly.

Pins for the open mode come from `web/public/stops-{mode}.json`. The other modes are fetched after the first one is drawn. The browser stores each of those files for 24 hours, and the same window covers service hours, the MTR lines, taxi-stand types, and ferry timetables. A later visit inside that window skips the download. Moving the map does not ask the server for a new stop list.

Below zoom 16 the stops of the open mode are counted groups. A tap on a count zooms in. At zoom 16 and closer, every stop is its own sign. The bus tab, and every bus pin except Citybus, uses the red bus in `web/public/icons/bus.svg`. A Citybus stop, whose id starts with `bus:ctb:`, uses the yellow double-decker in `web/public/icons/citybus.svg` for the map pin and the sign in the details sheet.

A stop can be opened directly. The address is the stop id with slashes instead of colons: `/bus/kmb/{stop}/`, `/mtr/{code}/`, `/minibus/{id}/`, `/taxi/{id}/`. The sheet keeps Share and the external-map icon on the vehicle-type line. Share opens a dialog with that link. The other icon opens a dialog of Google Maps, Apple Maps, Baidu Maps, Amap, and OpenStreetMap. A shared link does not let the automatic location request move the map away.

The client does not choose which arrivals are current. It draws what the server last stored.

There is no sign-in. Anyone can pan and open stops.

## What this does not do yet

It does not poll a feed, store a stop, or draw the map. The build is specified in [TECH-STACK.md](TECH-STACK.md). The page is listed in [CHECKLIST.md](CHECKLIST.md). The service is listed in [server/CHECKLIST.md](server/CHECKLIST.md).
