# Data sources

Realtime HK Traffic is built from official Hong Kong transport open data. The
Rust service is the only component that calls these hosts: it polls them, keeps
the latest arrival snapshot in Redis, and serves the page. The browser never
calls the feeds directly.

This page lists the sources this repository uses, the fields it reads, and the
files it keeps in the repository. It is not an index of every dataset on the
portal. Add new sources here when the service starts using them.

## At a glance

| Data | Publisher | Endpoint | Used for |
| --- | --- | --- | --- |
| MTR lines and stations | MTR open data | `https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv` | Station codes, names, line membership and station order |
| MTR next train | data.gov.hk | `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php` | Live train arrivals |
| KMB and LWB stops | data.gov.hk | `https://data.etabus.gov.hk/v1/transport/kmb/stop` | Bus stop catalogue |
| KMB and LWB ETA | data.gov.hk | `https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/{stop_id}` | Live bus arrivals |
| Citybus stops | data.gov.hk | `https://rt.data.gov.hk/v2/transport/citybus/...` | Citybus stop catalogue |
| Citybus ETA | data.gov.hk | `https://rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/{stop_id}` | Live Citybus arrivals |
| Bus route information | Transport Department / data.gov.hk | `https://static.data.gov.hk/td/routes-fares-kml/KML_BUS.zip` | Route names, origins, destinations, fares and stop sequences in TC/SC/EN |
| Green minibus | data.gov.hk | `https://data.etagmb.gov.hk/...` | Stops, routes and live arrivals |
| GMB route information | Transport Department / data.gov.hk | `https://static.data.gov.hk/td/routes-fares-kml/KML_GMB.zip` | Route names, origins, destinations, fares and stop sequences in TC/SC/EN |
| Green minibus route numbers | data.gov.hk | `https://static.data.gov.hk/td/routes-fares-xml/ROUTE_GMB.xml` | Route id to route number labels |
| Taxi stands | data.gov.hk / CSDI | `https://portal.csdi.gov.hk/server/rest/services/...` | Stand names and coordinates |
| MTR line geometry | OpenStreetMap | `https://overpass-api.de/api/interpreter` | The coloured MTR line layer |

The service sends no API key. All feeds are public HTTP GET endpoints.

## MTR lines and stations

The station and line reference is the CSV published by MTR, linked from
data.gov.hk. It covers the heavy-rail network, **not Light Rail**.

```text
https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv
```

Last checked on 20 November 2026: 270 non-empty rows, 97 unique station codes,
and 10 lines. The file ends with one blank row; skip rows with an empty
`Line Code` when parsing.

### Columns

| Column | Example | Meaning |
| --- | --- | --- |
| `Line Code` | `AEL` | Line identifier |
| `Direction` | `DT` | Travel direction along the line |
| `Station Code` | `AWE` | Three-letter station code used by the MTR feed |
| `Station ID` | `56` | MTR's numeric station id |
| `Chinese Name` | `博覽館` | Traditional Chinese station name |
| `English Name` | `AsiaWorld-Expo` | English station name |
| `Sequence` | `1.00` | Order of the station in that line and direction, starting at 1 |

Example rows:

```csv
"Line Code","Direction","Station Code","Station ID","Chinese Name","English Name","Sequence"
"AEL","DT","AWE","56","博覽館","AsiaWorld-Expo",1.00
"AEL","DT","AIR","47","機場","Airport",2.00
"AEL","DT","TSY","46","青衣","Tsing Yi",3.00
"AEL","DT","KOW","45","九龍","Kowloon",4.00
"AEL","DT","HOK","44","香港","Hong Kong",5.00
```

### Lines in the file

| Code | Line | Unique stations |
| --- | --- | ---: |
| `AEL` | Airport Express | 5 |
| `DRL` | Disneyland Resort Line | 2 |
| `EAL` | East Rail Line | 15 |
| `ISL` | Island Line | 17 |
| `KTL` | Kwun Tong Line | 17 |
| `SIL` | South Island Line | 5 |
| `TCL` | Tung Chung Line | 8 |
| `TKL` | Tseung Kwan O Line | 8 |
| `TML` | Tuen Ma Line | 27 |
| `TWL` | Tsuen Wan Line | 16 |

`DT` and `UT` are the normal down and up directions. Branch directions keep
separate sequences: `LMC-DT` and `LMC-UT` for the East Rail Lok Ma Chau branch,
and `TKS-DT` and `TKS-UT` for the Tseung Kwan O LOHAS Park branch.

### What the CSV does not contain

The CSV has no coordinates and no line colours. The repository keeps its own
station lookup in `server/data/mtr.json`, one object per station:

```json
{
  "code": "CEN",
  "name_tc": "中環",
  "name_en": "Central",
  "lat": 22.282,
  "lng": 114.1577,
  "lines": ["TWL", "ISL"]
}
```

That file has 98 stations. It includes `RAC` (馬場 Racecourse), which the CSV
does not list, and adds the latitude, longitude and line membership needed to
draw station pins and query the next-train feed. `catalog::mtr_stops()` reads it
to build `mtr:` stops, and `catalog::mtr_label()` uses the names to label train
destinations.

Line colours and the human-readable station lists are in [MTR.md](MTR.md).

## MTR next train

Real-time MTR train information. The feed is the MTR Next Train dataset on
data.gov.hk:

<https://data.gov.hk/en-data/dataset/mtr-data2-nexttrain-data/resource/103472ed-01be-4dda-92c6-30530dee022f>

```text
https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line={line}&sta={station}
```

Example: `line=TWL&sta=ADM`.

Fields the service reads:

| Field | Use |
| --- | --- |
| `data` | Object keyed by `{line}-{station}`, e.g. `TWL-ADM` |
| `data.*.UP`, `data.*.DOWN` | Train arrays for the two directions |
| `valid` | `N` trains are skipped |
| `dest` | Destination station code, resolved through `catalog::mtr_label()` |
| `ttnt` | Minutes until the train |
| `time` | Scheduled clock time; the page shows the time portion |
| `isdelay` | `Y` marks the whole station snapshot as delayed |

The service calls this for watched MTR stations every 15 seconds, and for every
MTR station once a minute.

## Bus stops and arrivals

### KMB and LWB

Stop catalogue:

```text
https://data.etabus.gov.hk/v1/transport/kmb/stop
```

Each item in `data` is read as:

| Field | Use |
| --- | --- |
| `stop` | Stop id, stored as `bus:kmb:{stop}` |
| `name_tc`, `name_en` | Stop name in both languages |
| `lat`, `long` | WGS84 coordinates, parsed from strings |

Live arrivals:

```text
https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/{stop_id}
```

Each item in `data` is read as:

| Field | Use |
| --- | --- |
| `route` | Route number |
| `dest_tc` (or `dest`) | Destination |
| `eta` | ISO timestamp used to calculate minutes remaining |

### Citybus

Citybus is loaded in three catalogue steps:

```text
https://rt.data.gov.hk/v2/transport/citybus/route/CTB
https://rt.data.gov.hk/v2/transport/citybus/route-stop/CTB/{route}/{direction}
https://rt.data.gov.hk/v2/transport/citybus/stop/{stop_id}
```

`direction` is `outbound` or `inbound`. The service reads `data[].route` from the
route list, `data[].stop` from route-stop, and `data.stop`, `data.name_tc`,
`data.name_en`, `data.lat` and `data.long` from the stop document.

Live arrivals:

```text
https://rt.data.gov.hk/v1/transport/batch/stop-eta/CTB/{stop_id}
```

The arrival fields are the same ones the KMB feed uses: `route`, `dest_tc` (or
`dest`), and `eta`.

### Bus route information archive

The Transport Department publishes bus route metadata and stop sequences as a
ZIP of KML documents. Every route variant has a document with names in
Traditional Chinese, Simplified Chinese and English.

```text
https://static.data.gov.hk/td/routes-fares-kml/KML_BUS.zip
```

Last checked on 20 November 2026: 1,622 `.kml` files, 4.96 MB zipped and about
51.6 MB uncompressed. There are 1,020 unique Traditional Chinese route names
across the files. Company codes in the checked copy:

| `companyCode` | Files |
| --- | ---: |
| `KMB` | 795 |
| `CTB` | 479 |
| `KMB+CTB` | 126 |
| `LWB` | 89 |
| `NLB` | 61 |
| `LRTFeeder` | 32 |
| `XB` | 16 |
| `DB` | 12 |
| `PI` | 9 |
| `LWB+CTB` | 3 |

Each KML document has route-level `ExtendedData`:

| Field | Meaning |
| --- | --- |
| `routeId` | Route variant id; also the file name and Document id |
| `companyCode` | Operator code, such as `KMB`, `CTB`, `LWB` or `NLB` |
| `routeNameC`, `routeNameS`, `routeNameE` | Route number or name in TC, SC and English |
| `routeType` | Route type code |
| `serviceMode` | Service mode code; the checked copy contains `T`, `R`, `NT` and `N` |
| `specialType` | Special route flag |
| `journeyTime` | Journey time in minutes |
| `locStartNameC`, `locStartNameS`, `locStartNameE` | Origin name in TC, SC and English |
| `locEndNameC`, `locEndNameS`, `locEndNameE` | Destination name in TC, SC and English |
| `hyperlinkC`, `hyperlinkS`, `hyperlinkE` | Operator page for the route in each language |
| `fullFare` | Full fare |
| `routeRemarkC`, `routeRemarkS`, `routeRemarkE` | Route remarks in TC, SC and English |
| `lastUpdateDate` | Publisher's last update timestamp |

Each stop is a KML `Placemark` with:

| Field | Meaning |
| --- | --- |
| `routeSeq` | Direction or route variant sequence |
| `stopSeq` | Stop order on that sequence, starting at 1 |
| `stopId` | Stop id |
| `stopPickDrop` | Pick-up and drop-off indicator |
| `stopNameC`, `stopNameS`, `stopNameE` | Stop name in TC, SC and English |
| `Point/coordinates` | Longitude, latitude |

The checked archive contains `Point` placemarks only. It does not include
`LineString` route geometry. The service does not poll this archive yet; it is a
reference for route labels, fares, stop sequences and multilingual stop names.

## Green minibus

The green-minibus API is `https://data.etagmb.gov.hk`. The service uses five
resources:

| Endpoint | Fields read |
| --- | --- |
| `/route` | `data.routes.{region}[]` route codes |
| `/route/{region}/{route}` | `data[].route_id` and `data[].directions[].route_seq` |
| `/route-stop/{route_id}/{route_seq}` | `data.route_stops[].stop_id`, `.name_tc` |
| `/stop/{stop_id}` | `data.coordinates.wgs84.latitude`, `.longitude` |
| `/eta/stop/{stop_id}` | `data[].route_id`, `data[].eta[].diff`, `.remarks_tc` |

The catalogue crawl is expensive and is throttled by the publisher. The
bundled stop list in `server/data/stops.json` and `web/public/stops.json` is the
baseline; the live crawl can refresh the stop catalogue and extend the
route-number map at runtime.

Route numbers are not the internal `route_id`. The complete static reference is
the Transport Department file:

```text
https://static.data.gov.hk/td/routes-fares-xml/ROUTE_GMB.xml
```

It is bundled as `server/data/gmb-routes.json`, mapping numeric route ids to the
route numbers printed on the minibus.

### GMB route information archive

The same Transport Department collection also publishes green-minibus route
metadata as KML documents:

```text
https://static.data.gov.hk/td/routes-fares-kml/KML_GMB.zip
```

Last checked on 20 November 2026: 779 `.kml` files, 1.68 MB zipped and about
13.7 MB uncompressed. The archive has 480 unique Traditional Chinese route
names, and every file has `companyCode` `GMB`. Service mode values are `R`
(407 files), `T` (335), `N` (23) and `NT` (14).

The route-level and stop-level fields are the same as the bus archive above:
`routeNameC/S/E`, `locStartNameC/S/E`, `locEndNameC/S/E`, `fullFare`,
`stopSeq`, `stopNameC/S/E` and point coordinates. The checked archive also
contains no `LineString` route geometry.

The file name and `routeId` match the green-minibus API `route_id`. The checked
archive has 779 route ids, the same count as the keys in
`server/data/gmb-routes.json`, so it can be used as a static multilingual route
lookup. The service does not read it yet.

## Taxi stands

Taxi stands come from the CSDI feature service linked from data.gov.hk:

```text
https://portal.csdi.gov.hk/server/rest/services/common/td_rcd_1697081907714_17556/FeatureServer/0/query
```

The service pages through the layer 200 records at a time and asks for GeoJSON.
It reads:

| Field | Use |
| --- | --- |
| `properties.OBJECTID` | Stand id, stored as `taxi:{OBJECTID}` |
| `properties.Location_TC`, `Location_EN` | Stand name in both languages |
| `geometry.coordinates` | Longitude and latitude |

Hong Kong publishes stand locations, not vehicle positions, so a taxi stand has
no arrival rows.

## Checked-in files derived from these sources

| File | Contents |
| --- | --- |
| `server/data/mtr.json` | MTR station codes, names, coordinates, line membership |
| `server/data/stops.json` | Bundled stop catalogue used by the Rust service |
| `web/public/stops.json` | The same stop catalogue served to the page |
| `server/data/gmb-routes.json` | Green-minibus route id to route number map |
| `web/public/service-hours.json` | Per-mode, per-station and per-route service windows |
| `web/public/mtr-lines.geojson` | MTR line geometry from OpenStreetMap |

Generation scripts:

| Script | Source |
| --- | --- |
| `server/scripts/fetch-minibus-routes.py` | Green-minibus route, route-stop and stop API |
| `server/scripts/fetch-night-stops.py` | KMB and Citybus route and route-stop endpoints, used to set `night: true` |
| `server/scripts/fetch-mtr-lines.py` | OpenStreetMap Overpass API, not data.gov.hk |

## Caching and polling

- The service polls watched stops every 15 seconds. All MTR stations are
  refreshed once a minute.
- Each snapshot is written to Redis as `arrivals:{stop_id}` with a 90-second
  expiry.
- The web page reads `/stops/{id}/arrivals` and listens to
  `/stops/{id}/events`; it does not contact the publishers.

See [REDIS.md](REDIS.md) for the snapshot keys and expiry details.

## Not from data.gov.hk

- **Map tiles:** OpenStreetMap, credited on the map.
- **MTR line geometry:** OpenStreetMap, ODbL, extracted by
  `server/scripts/fetch-mtr-lines.py`.
- **Service hours:** checked-in schedule data in
  `web/public/service-hours.json`.

## Official portals

- data.gov.hk: <https://data.gov.hk/>
- MTR open data: <https://opendata.mtr.com.hk/>
- CSDI: <https://portal.csdi.gov.hk/>
- OpenStreetMap copyright: <https://www.openstreetmap.org/copyright>
