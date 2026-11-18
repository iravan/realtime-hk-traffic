"use client";

import { useEffect, useRef, useState } from "react";
import {
  AttributionControl,
  GeoJSONSource,
  Map as MlMap,
  Marker,
  setWorkerUrl,
  type ExpressionSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { StopSheet } from "./stop-sheet";
import {
  loadVehicleImages,
  modeLabel,
  stopDotHighlight,
  stopDotImage,
  stopIconHighlight,
  stopIconImage,
  stopIconPixelRatio,
  type Mode,
} from "./stop-icon";
import { clockAt, isScheduleOpen, isStopOpen, serviceHoursLabel, type ServiceHours } from "./service-hours";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const modes = ["mtr", "bus", "minibus", "taxi"] as const;

// The four category tabs use their own flat vehicle artwork, served from
// `public/icons`. They are plain files, so they need no canvas at render time.
const categoryIcons: Record<Mode, string> = {
  mtr: `${basePath}/icons/mtr.svg`,
  bus: `${basePath}/icons/bus.svg`,
  minibus: `${basePath}/icons/minibus.svg`,
  taxi: `${basePath}/icons/taxi.svg`,
};

// The home view. A fix from outside Hong Kong must not drag the map away from
// it, so the same centre and zoom open the app and reset it.
const hkCenter: [number, number] = [114.1694, 22.3193];
const hkZoom = 14;
// Generous box around the territory, islands included; geolocation accuracy is
// tens of metres, so the exact edge does not matter.
const hkBounds = { south: 22.1, north: 22.6, west: 113.8, east: 114.5 };

// Locating only auto-selects a stop it is actually near. A station point sits in
// the middle of a large paid area, so it gets a wider radius; street stops are
// dense enough that anything beyond a short walk is a different place.
const autoselectRadiusMeters: Record<Mode, number> = {
  mtr: 600,
  bus: 300,
  minibus: 300,
  taxi: 400,
};

// A view holding more signs than this switches to dots. Full signs are 44×64,
// so a few hundred of them cover the map and hide the streets underneath.
const dotThreshold = 120;

// A feature's `icon` is its mode sign, or a route-number sign for minibuses; a
// dot is always keyed by mode. Out of service a stop drops to its muted dot, so
// it stays visible as a location but stops inviting a tap.
const signImage: ExpressionSpecification = [
  "case",
  ["get", "open"],
  ["get", "icon"],
  ["concat", ["get", "mode"], "-dot-off"],
];
const dotImage: ExpressionSpecification = [
  "case",
  ["get", "open"],
  ["concat", ["get", "mode"], "-dot"],
  ["concat", ["get", "mode"], "-dot-off"],
];
const signSize: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  13,
  0.7,
  15,
  1,
  17,
  1.2,
];
const dotSize: ExpressionSpecification = ["interpolate", ["linear"], ["zoom"], 12, 0.8, 16, 1.1];
// A sign hangs from its pole while a dot is centred on the stop, so a view of
// signs can still hold grey dots without them floating above their point.
const signAnchor: ExpressionSpecification = ["case", ["get", "open"], "bottom", "center"];
// `icon-size` is a layout property, so MapLibre accepts only one zoom-based
// `step`/`interpolate` in it. Signs and dots therefore keep separate single
// curves and `drawStops` swaps between them when the view crosses the dot
// threshold, rather than branching on `open` inside the expression.
// The selected sign is drawn a touch larger than its neighbours; the outline
// that makes it read as selected is part of the image itself.
const selectedSignSize: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  13,
  0.84,
  15,
  1.18,
  17,
  1.4,
];
const selectedDotSize: ExpressionSpecification = [
  "interpolate",
  ["linear"],
  ["zoom"],
  12,
  1,
  16,
  1.35,
];

type Stop = {
  id: string;
  mode: Mode;
  name: string;
  latitude: number;
  longitude: number;
  routes?: string[];
  night?: boolean;
};

type Fix = { latitude: number; longitude: number };

// `error` is only shown after a manual attempt: the initial automatic request
// stays quiet, so a denied permission does not open on a red button.
type LocateState = "idle" | "locating" | "error";

export default function Page() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [active, setActive] = useState<Mode>("bus");
  const activeRef = useRef(active);
  activeRef.current = active;
  const fixRef = useRef<Fix | null>(null);
  const selectedRef = useRef<Stop | null>(null);
  const boardRef = useRef<Stop | null>(null);
  const catalogueRef = useRef<Stop[] | null>(null);
  const hoursRef = useRef<ServiceHours | null>(null);
  const dotsRef = useRef(false);
  const [stops, setStops] = useState<Stop[]>([]);
  const [selected, setSelected] = useState<Stop | null>(null);
  const [board, setBoard] = useState<Stop | null>(null);
  const [locateState, setLocateState] = useState<LocateState>("idle");
  const [hours, setHours] = useState<ServiceHours | null>(null);
  // Null until mount so the static prerender and the first client render agree
  // on what time it is.
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const node = container.current;
    if (!node || mapRef.current) return;
    setWorkerUrl(`${basePath}/maplibre-gl-worker.mjs`);
    const map = new MlMap({
      container: node,
      center: hkCenter,
      zoom: hkZoom,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    map.addControl(new AttributionControl({ compact: false }), "bottom-left");
    map.on("load", async () => {
      await loadVehicleImages(basePath);
      for (const mode of modes) {
        map.addImage(mode, stopIconImage(mode), { pixelRatio: stopIconPixelRatio });
        map.addImage(`${mode}-dot`, stopDotImage(mode), { pixelRatio: stopIconPixelRatio });
        map.addImage(`${mode}-dot-off`, stopDotImage(mode, true), {
          pixelRatio: stopIconPixelRatio,
        });
      }
      map.addSource("me", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "me",
        type: "circle",
        source: "me",
        paint: {
          "circle-radius": 7,
          "circle-color": "#3d4c8f",
          "circle-stroke-width": 2.5,
          "circle-stroke-color": "#fbf7f0",
        },
      });
      if (fixRef.current) {
        placeMe(map, fixRef.current);
        map.easeTo({
          center: [fixRef.current.longitude, fixRef.current.latitude],
          zoom: Math.max(map.getZoom(), 16),
        });
      }
      map.addSource("stops", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "stops",
        type: "symbol",
        source: "stops",
        layout: {
          "icon-image": signImage,
          "icon-anchor": signAnchor,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": signSize,
        },
      });
      // Added after every other layer so the selection paints on top: the
      // picked sign is never hidden behind a neighbour or the location dot.
      map.addSource("selection", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "selection",
        type: "symbol",
        source: "selection",
        layout: {
          "icon-image": ["get", "image"],
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": selectedSignSize,
        },
      });
      map.on("click", "stops", (event) => {
        // An open stop opens the details sheet; a closed (grey) stop only shows
        // its route board. Prefer an open stop when pins overlap.
        const open = event.features?.find((item) => item.properties?.open === true);
        const closed = event.features?.find((item) => item.properties?.open === false);
        const feature = open ?? closed;
        const id = feature?.properties?.id;
        if (typeof id !== "string") return;
        const match = stopsRef.current.find((stop) => stop.id === id);
        if (!match) return;
        if (open) {
          setSelected(match);
          setBoard(match);
        } else {
          setSelected(null);
          setBoard(match);
        }
      });
      map.on("mouseenter", "stops", (event) => {
        map.getCanvas().style.cursor = event.features?.length ? "pointer" : "";
      });
      map.on("mouseleave", "stops", () => {
        map.getCanvas().style.cursor = "";
      });
      drawStops(map);
    });
    map.on("moveend", () => {
      drawStops(map);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const stopsRef = useRef<Stop[]>([]);
  stopsRef.current = stops;
  selectedRef.current = selected;
  boardRef.current = board;

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    refreshSelection(map);
  }, [selected, board]);

  useEffect(() => {
    const map = mapRef.current;
    const routes = board?.mode === "minibus" ? board.routes : undefined;
    if (!map || !board || !routes || routes.length === 0) return;
    const node = document.createElement("div");
    node.className = "route-board";
    for (const route of routes) {
      const chip = document.createElement("span");
      chip.className = "route-chip";
      chip.textContent = route;
      node.appendChild(chip);
    }
    const marker = new Marker({ element: node, anchor: "left", offset: [8, 0] })
      .setLngLat([board.longitude, board.latitude])
      .addTo(map);
    return () => {
      marker.remove();
    };
  }, [board]);

  function selectNearest(fix: Fix | null) {
    const catalogue = catalogueRef.current;
    if (!fix || !catalogue) return;
    const nearest = nearestStop(
      catalogue,
      activeRef.current,
      fix.latitude,
      fix.longitude,
      hoursRef.current,
      new Date(),
    );
    if (nearest) {
      setSelected(nearest);
      setBoard(nearest);
    }
  }

  function drawStops(map: MlMap) {
    const catalogue = catalogueRef.current;
    if (!catalogue) return;
    const hours = hoursRef.current;
    const now = new Date();
    const bounds = map.getBounds();
    const mode = activeRef.current;
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    // Several ids can publish one location; draw the first and let the server
    // merge their arrivals.
    const seen = new Set<string>();
    const visible = catalogue.filter((stop) => {
      if (stop.mode !== mode) return false;
      if (stop.latitude < south || stop.latitude > north) return false;
      if (stop.longitude < west || stop.longitude > east) return false;
      const key = `${stop.latitude.toFixed(6)}:${stop.longitude.toFixed(6)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    setStops(visible);
    // Swap the whole layer rather than styling features one by one: every stop
    // in the view has to agree, and a layout change is one redraw.
    const dots = visible.length > dotThreshold;
    if (dots !== dotsRef.current) {
      dotsRef.current = dots;
      map.setLayoutProperty("stops", "icon-image", dots ? dotImage : signImage);
      map.setLayoutProperty("stops", "icon-anchor", dots ? "center" : signAnchor);
      map.setLayoutProperty("stops", "icon-size", dots ? dotSize : signSize);
    }
    const source = map.getSource("stops");
    if (!source || source.type !== "geojson") return;
    (source as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: visible.map((stop) => ({
        type: "Feature",
        properties: {
          id: stop.id,
          mode: stop.mode,
          icon: stop.mode,
          open: isStopOpen(stop, hours, now),
        },
        geometry: { type: "Point", coordinates: [stop.longitude, stop.latitude] },
      })),
    });
    refreshSelection(map);
  }

  function refreshSelection(map: MlMap) {
    if (!map.getLayer("selection")) return;
    const focus = selectedRef.current ?? boardRef.current;
    // A greyed stop is drawn as a dot, so its highlight is the ringed dot even
    // in a sparse view; the dense-view threshold forces the dot as well.
    const dot =
      dotsRef.current || (focus !== null && !isStopOpen(focus, hoursRef.current, new Date()));
    map.setLayoutProperty("selection", "icon-anchor", dot ? "center" : "bottom");
    map.setLayoutProperty("selection", "icon-size", dot ? selectedDotSize : selectedSignSize);
    highlightSelection(map, focus, dot);
  }


  useEffect(() => {
    let cancelled = false;
    fetch(`${basePath}/service-hours.json`)
      .then((response) => response.json())
      .then((body: ServiceHours) => {
        if (cancelled) return;
        hoursRef.current = body;
        setHours(body);
        const map = mapRef.current;
        if (map?.isStyleLoaded()) drawStops(map);
        const current = selectedRef.current;
        if (current && !isStopOpen(current, body, new Date())) setSelected(null);
      })
      .catch(() => {
        // Without service hours every stop stays open, which matches the map
        // before this data existed.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${basePath}/stops.json`)
      .then((response) => response.json())
      .then((body: { stops: Stop[] }) => {
        if (cancelled) return;
        catalogueRef.current = body.stops;
        selectNearest(fixRef.current);
        const map = mapRef.current;
        if (map?.isStyleLoaded()) drawStops(map);
      })
      .catch(() => {
        if (!cancelled) catalogueRef.current = [];
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Ask the device for a fix and, when it is inside Hong Kong, mark it and move
  // the map there. `manual` controls only whether a refusal is surfaced: the
  // button should say why nothing happened, the first automatic request should
  // not.
  function locate(manual: boolean) {
    if (!navigator.geolocation) {
      if (manual) setLocateState("error");
      return;
    }
    setLocateState("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocateState("idle");
        const fix = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        };
        if (!inHongKong(fix)) {
          const map = mapRef.current;
          if (map?.isStyleLoaded()) map.easeTo({ center: hkCenter, zoom: hkZoom });
          return;
        }
        fixRef.current = fix;
        const map = mapRef.current;
        if (map?.isStyleLoaded()) {
          placeMe(map, fix);
          map.easeTo({
            center: [fix.longitude, fix.latitude],
            zoom: Math.max(map.getZoom(), 16),
          });
        }
        selectNearest(fix);
      },
      () => {
        // No fix: the map stays where it is.
        setLocateState(manual ? "error" : "idle");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }

  useEffect(() => {
    locate(false);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    drawStops(map);
    // Switching tabs cancels the picked stop: close the sheet, hide the route
    // board and clear the highlight.
    setSelected(null);
    setBoard(null);
  }, [active]);

  // First and last services move the open/closed line while the page is open,
  // so re-evaluate the view once a minute and drop a selection that has closed.
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => {
      const tick = new Date();
      setNow(tick);
      const map = mapRef.current;
      if (!map?.isStyleLoaded()) return;
      drawStops(map);
      const current = selectedRef.current;
      if (current && !isStopOpen(current, hoursRef.current, tick)) setSelected(null);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const mtrSchedule = hours?.modes?.mtr ?? [];
  const mtrClosed =
    active === "mtr" &&
    now != null &&
    mtrSchedule.length > 0 &&
    !isScheduleOpen(mtrSchedule, clockAt(now, hours?.timezone));

  return (
    <div className={`visit${selected ? " sheet-open" : ""}`}>
      <div className="map-stage">
        <div ref={container} className="map-canvas" />
      </div>
      <div className="chrome">
        <div className="brand">
          <h1>香港交通</h1>
          <p>{stops.length} stops in view</p>
        </div>
        <div className="channel">
          <div className="filters">
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                data-mode={mode}
                aria-pressed={active === mode}
                className={active === mode ? "on" : ""}
                onClick={() => {
                  setSelected(null);
                  setBoard(null);
                  setActive(mode);
                }}
              >
                <img src={categoryIcons[mode]} alt="" />
                {modeLabel(mode)}
              </button>
            ))}
          </div>
          {mtrClosed ? (
            <div className="notice" role="status">
              <strong>MTR has stopped for the night</strong>
              <span>Service hours {serviceHoursLabel(mtrSchedule)} Hong Kong time</span>
            </div>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="locate"
        data-state={locateState}
        disabled={locateState === "locating"}
        aria-busy={locateState === "locating"}
        aria-label={locateLabel(locateState)}
        title={locateLabel(locateState)}
        onClick={() => locate(true)}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="6.5" />
          <path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {selected ? (
        <StopSheet
          id={selected.id}
          mode={selected.mode}
          name={selected.name}
          onClose={() => {
            setSelected(null);
            setBoard(null);
          }}
        />
      ) : null}
    </div>
  );
}


function locateLabel(state: LocateState): string {
  if (state === "locating") return "Finding your location…";
  if (state === "error") return "Could not get your location. Try again.";
  return "Show my location";
}

function inHongKong(fix: Fix): boolean {
  return (
    fix.latitude >= hkBounds.south &&
    fix.latitude <= hkBounds.north &&
    fix.longitude >= hkBounds.west &&
    fix.longitude <= hkBounds.east
  );
}

function nearestStop(
  stops: Stop[],
  mode: Mode,
  latitude: number,
  longitude: number,
  hours: ServiceHours | null,
  now: Date,
): Stop | null {
  const scale = Math.cos((latitude * Math.PI) / 180);
  const metersPerDegree = 111_320;
  const radius = autoselectRadiusMeters[mode];
  let nearest: Stop | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const stop of stops) {
    if (stop.mode !== mode) continue;
    if (!isStopOpen(stop, hours, now)) continue;
    const dx = (stop.longitude - longitude) * scale * metersPerDegree;
    const dy = (stop.latitude - latitude) * metersPerDegree;
    const distance = Math.hypot(dx, dy);
    if (distance < best) {
      best = distance;
      nearest = stop;
    }
  }
  return best <= radius ? nearest : null;
}

function placeMe(map: MlMap, fix: Fix) {
  const source = map.getSource("me");
  if (!source || source.type !== "geojson") return;
  const feature: GeoJSON.Feature<GeoJSON.Point> = {
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [fix.longitude, fix.latitude] },
  };
  (source as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: [feature],
  });
}

function highlightSelection(map: MlMap, stop: Stop | null, dots: boolean) {
  const source = map.getSource("selection");
  if (!source || source.type !== "geojson") return;
  const features: GeoJSON.Feature<GeoJSON.Point>[] = [];
  if (stop) {
    features.push({
      type: "Feature",
      properties: { image: selectionImage(map, stop, dots) },
      geometry: { type: "Point", coordinates: [stop.longitude, stop.latitude] },
    });
  }
  (source as GeoJSONSource).setData({ type: "FeatureCollection", features });
}

// A selected stop needs its own outline image: the mode sign, a minibus route
// board, or the ringed dot that replaces both when the view is dense. Built on
// first use, then reused from the style.
function selectionImage(map: MlMap, stop: Stop, dots: boolean): string {
  if (dots) {
    const image = `${stop.mode}-dot-sel`;
    if (!map.hasImage(image)) {
      map.addImage(image, stopDotHighlight(stop.mode), { pixelRatio: stopIconPixelRatio });
    }
    return image;
  }
  const image = `${stop.mode}-sel`;
  if (!map.hasImage(image)) {
    map.addImage(image, stopIconHighlight(stop.mode), {
      pixelRatio: stopIconPixelRatio,
    });
  }
  return image;
}
