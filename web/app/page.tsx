"use client";

import { useEffect, useRef, useState } from "react";
import {
  AttributionControl,
  GeoJSONSource,
  Map as MlMap,
  Marker,
  Popup,
  setWorkerUrl,
  type ExpressionSpecification,
  type FilterSpecification,
  type LngLatLike,
  type MapGeoJSONFeature,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { StopSheet } from "./stop-sheet";
import { useI18n } from "./i18n";
import {
  loadTaxiKindImages,
  loadVehicleImages,
  stopDotHighlight,
  stopDotImage,
  stopIconHighlight,
  stopIconImage,
  taxiDotHighlight,
  taxiSignHighlight,
  stopIconPixelRatio,
  taxiDotImage,
  taxiIconImage,
  taxiKinds,
  type Mode,
  type TaxiKind,
} from "./stop-icon";
import { taxiStandInfo, type TaxiLabel } from "./taxi-stand";
import { clockAt, isScheduleOpen, isStopOpen, serviceHoursLabel, type ServiceHours } from "./service-hours";
import { mtrDestinationColor, mtrStationColor } from "./mtr-station-color";
import { localizeBilingualName, localizeStopName } from "./stop-name";
import lineTerminalsJson from "./mtr-line-terminals.json";

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

// Terminal stations for the line tooltip. The GeoJSON groups both directions
// into one feature, so the direction-specific `from`/`to` tags in OSM are not
// suitable. The values are generated from the MTR CSV by
// server/scripts/build-mtr-catalogue.py.
const lineTerminals: Record<string, { from: string; to: string }> = lineTerminalsJson;

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
  ["concat", ["get", "icon"], "-dot"],
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
// MTR station blocks are centred on the station; the other modes hang from a
// pole, so their open signs are anchored at the bottom.
const signAnchor: ExpressionSpecification = [
  "case",
  ["all", ["get", "open"], ["!=", ["get", "mode"], "mtr"]],
  "bottom",
  "center",
];
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
  taxi?: TaxiKind;
  taxiType?: TaxiLabel;
  taxiHours?: TaxiLabel | null;
};

type Fix = { latitude: number; longitude: number };

// `error` is only shown after a manual attempt: the initial automatic request
// stays quiet, so a denied permission does not open on a red button.
type LocateState = "idle" | "locating" | "error";

export default function Page() {
  const { locale, t, toggleLocale } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const clearLineRef = useRef<() => void>(() => {});
  const hideStopNameRef = useRef<() => void>(() => {});
  const hoveredLineRef = useRef<string | null>(null);
  const hoveredStopRef = useRef<string | null>(null);
  const [active, setActive] = useState<Mode>("bus");
  const activeRef = useRef(active);
  activeRef.current = active;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const fixRef = useRef<Fix | null>(null);
  const selectedRef = useRef<Stop | null>(null);
  const boardRef = useRef<Stop | null>(null);
  const cataloguesRef = useRef<Partial<Record<Mode, Stop[]>>>({});
  const cataloguePromisesRef = useRef(new Map<Mode, Promise<Stop[]>>());
  const hoursRef = useRef<ServiceHours | null>(null);
  const dotsRef = useRef(false);
  const mtrLinesLoadedRef = useRef(false);
  const mtrLinesLoadingRef = useRef(false);
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
      await loadTaxiKindImages(basePath);
      for (const mode of modes) {
        map.addImage(mode, stopIconImage(mode), { pixelRatio: stopIconPixelRatio });
        map.addImage(`${mode}-dot`, stopDotImage(mode), { pixelRatio: stopIconPixelRatio });
        map.addImage(`${mode}-dot-off`, stopDotImage(mode, true), {
          pixelRatio: stopIconPixelRatio,
        });
      }
      for (const kind of taxiKinds) {
        map.addImage(`taxi-${kind}`, taxiIconImage(kind), { pixelRatio: stopIconPixelRatio });
        map.addImage(`taxi-${kind}-dot`, taxiDotImage(kind), {
          pixelRatio: stopIconPixelRatio,
        });
      }
      // MTR line geometry from OpenStreetMap (ODbL), generated by
      // server/scripts/fetch-mtr-lines.py. The casing separates the lines from
      // the basemap; the lane offsets keep shared corridors readable instead
      // of letting one colour paint over another. The source starts empty and
      // is fetched only when the MTR tab is first opened.
      const lineLane = (): ExpressionSpecification => [
        "match",
        ["get", "ref"],
        "TWL", -3,
        "AEL", 3,
        "TKL", 3,
        "TML", 3,
        "KTL", 0,
        "ISL", 0,
        "TCL", 0,
        "EAL", 0,
        "SIL", 0,
        "DRL", 0,
        0,
      ];
      const lineOffset = (): ExpressionSpecification => [
        "interpolate",
        ["linear"],
        ["zoom"],
        10, ["*", lineLane(), 1.5],
        14, ["*", lineLane(), 2.5],
        17, ["*", lineLane(), 3.5],
      ];

      map.addSource("mtr-lines", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "mtr-lines-casing",
        type: "line",
        source: "mtr-lines",
        filter: ["==", ["get", "kind"], "line"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#fbf7f0",
          "line-opacity": 0.95,
          "line-offset": lineOffset(),
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 7, 17, 10],
        },
      });
      map.addLayer({
        id: "mtr-lines",
        type: "line",
        source: "mtr-lines",
        filter: ["==", ["get", "kind"], "line"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["coalesce", ["get", "colour"], "#11254a"],
          "line-opacity": 1,
          "line-offset": lineOffset(),
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 14, 4.5, 17, 7],
        },
      });
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

      // Hover highlight for an MTR station block. It sits above the line
      // layers and below the selected-station highlight.
      map.addSource("stops-hover", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "stops-hover",
        type: "symbol",
        source: "stops-hover",
        layout: {
          "icon-image": ["get", "image"],
          "icon-anchor": "center",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": selectedSignSize,
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

      // Hover/tap highlight layers. They read the same GeoJSON source as the
      // base lines, and their filter selects one `ref` at a time. Added after
      // the selection layer, so the highlighted route paints above every other
      // line and stop sign.
      map.addLayer({
        id: "mtr-lines-hover-casing",
        type: "line",
        source: "mtr-lines",
        filter: ["==", ["get", "kind"], "line-none"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": "#fbf7f0",
          "line-opacity": 1,
          "line-offset": lineOffset(),
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 7, 14, 12, 17, 16],
        },
      });
      map.addLayer({
        id: "mtr-lines-hover",
        type: "line",
        source: "mtr-lines",
        filter: ["==", ["get", "kind"], "line-none"],
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["coalesce", ["get", "colour"], "#11254a"],
          "line-opacity": 1,
          "line-offset": lineOffset(),
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 14, 8.5, 17, 11.5],
        },
      });
      // Hover on desktop and tap on mobile. The hit box is wider than the
      // painted line so a finger can select it, and a stop under the pointer
      // wins over a line running beneath the station sign.
      const linePopup = new Popup({
        className: "line-popup",
        closeButton: false,
        closeOnClick: false,
        offset: 14,
        maxWidth: "300px",
      });

      // The station name follows the pointer on desktop and a tap on a phone,
      // so a sign can be read without opening its sheet. A tap pins the name
      // until the map moves, the tab changes, or another spot is picked.
      const stopPopup = new Popup({
        className: "stop-popup",
        closeButton: false,
        closeOnClick: false,
        offset: 30,
        maxWidth: "260px",
      });
      let stopNamePinned = false;

      const showStopName = (stop: Stop) => {
        const node = document.createElement("div");
        node.className = "stop-name";
        node.textContent = localizeStopName(stop.name, stop.mode, localeRef.current);
        stopPopup.setDOMContent(node).setLngLat([stop.longitude, stop.latitude]);
        if (!stopPopup.isOpen()) stopPopup.addTo(map);
        const station = mtrStationColor(stop.id);
        const popup = stopPopup.getElement();
        if (!popup) return;
        popup.classList.remove("taxi-type");
        popup.classList.toggle("station-badge-chh", station?.badge === "station-badge-chh");
        if (station && !station.badge) {
          popup.style.setProperty("--stop-bg", station.color);
          popup.style.setProperty("--stop-fg", station.font);
        } else {
          popup.style.removeProperty("--stop-bg");
          popup.style.removeProperty("--stop-fg");
        }
      };

      const hideStopName = () => {
        stopNamePinned = false;
        if (stopPopup.isOpen()) stopPopup.remove();
      };
      hideStopNameRef.current = hideStopName;

      const lineTooltip = (feature: MapGeoJSONFeature) => {
        const properties = feature.properties ?? {};
        const ref = typeof properties.ref === "string" ? properties.ref : "";
        const terminals = lineTerminals[ref];
        const node = document.createElement("div");
        node.className = "line-tooltip";

        const swatch = document.createElement("span");
        swatch.className = "line-swatch";
        swatch.style.backgroundColor =
          typeof properties.colour === "string" ? properties.colour : "#11254a";
        node.appendChild(swatch);

        const text = document.createElement("div");
        const name = document.createElement("div");
        name.className = "line-tooltip-name";
        name.textContent =
          (typeof properties.name === "string" && properties.name) ||
          (typeof properties["name:en"] === "string" && properties["name:en"]) ||
          ref;
        text.appendChild(name);

        if (terminals) {
          const ends = document.createElement("div");
          ends.className = "line-tooltip-terminals";
          const locale = localeRef.current;
          const chip = (label: string) => {
            const node = document.createElement("span");
            const color = mtrDestinationColor(label);
            node.className = color?.badge ? `station-chip ${color.badge}` : "station-chip";
            node.textContent = localizeBilingualName(label, locale);
            if (color && !color.badge) {
              node.style.background = color.color;
              node.style.color = color.font;
            }
            return node;
          };
          const appendEnd = (value: string) => {
            value.split(" / ").forEach((part, index) => {
              if (index > 0) {
                const or = document.createElement("span");
                or.textContent = "/";
                ends.appendChild(or);
              }
              ends.appendChild(chip(part.trim()));
            });
          };
          appendEnd(terminals.from);
          const arrow = document.createElement("span");
          arrow.textContent = "↔";
          ends.appendChild(arrow);
          appendEnd(terminals.to);
          text.appendChild(ends);
        }

        node.appendChild(text);
        return node;
      };

      const clearLine = () => {
        if (hoveredLineRef.current === null && !linePopup.isOpen()) return;
        hoveredLineRef.current = null;
        const hidden: FilterSpecification = [
          "==",
          ["get", "kind"],
          "line-none",
        ];
        for (const id of ["mtr-lines-hover-casing", "mtr-lines-hover"]) {
          if (map.getLayer(id)) map.setFilter(id, hidden);
        }
        linePopup.remove();
      };

      const clearHoveredStop = () => {
        if (hoveredStopRef.current === null) return;
        hoveredStopRef.current = null;
        const source = map.getSource("stops-hover");
        if (source && source.type === "geojson") {
          (source as GeoJSONSource).setData({
            type: "FeatureCollection",
            features: [],
          });
        }
        // A name pinned by a tap outlives the pointer leaving the sign.
        if (!stopNamePinned) hideStopName();
      };

      const clearHoveredLine = () => {
        clearLine();
        clearHoveredStop();
      };
      clearLineRef.current = clearHoveredLine;

      const showHoveredLine = (
        feature: MapGeoJSONFeature,
        lngLat: LngLatLike,
      ) => {
        const ref =
          typeof feature.properties?.ref === "string"
            ? feature.properties.ref
            : null;
        if (!ref) return;
        if (hoveredLineRef.current !== ref) {
          hoveredLineRef.current = ref;
          const hover: FilterSpecification = ["==", ["get", "ref"], ref];
          for (const id of ["mtr-lines-hover-casing", "mtr-lines-hover"]) {
            if (map.getLayer(id)) map.setFilter(id, hover);
          }
          linePopup.setDOMContent(lineTooltip(feature));
        }
        linePopup.setLngLat(lngLat);
        if (!linePopup.isOpen()) linePopup.addTo(map);
      };

      const showTaxiType = (stop: Stop) => {
        const label = stop.taxiType;
        const text = label
          ? localeRef.current === "en"
            ? label.en
            : label.tc
          : localizeStopName(stop.name, stop.mode, localeRef.current);
        const node = document.createElement("div");
        node.className = "stop-name";
        node.textContent = text;
        stopPopup.setDOMContent(node).setLngLat([stop.longitude, stop.latitude]);
        if (!stopPopup.isOpen()) stopPopup.addTo(map);
        const popup = stopPopup.getElement();
        if (!popup) return;
        popup.classList.remove("station-badge-chh");
        popup.classList.add("taxi-type");
        popup.style.removeProperty("--stop-bg");
        popup.style.removeProperty("--stop-fg");
      };

      const showHoveredStop = (feature: MapGeoJSONFeature) => {
        const id = feature.properties?.id;
        if (typeof id !== "string") return;
        const stop = stopsRef.current.find((item) => item.id === id);
        if (!stop) return;
        if (stop.mode === "taxi") {
          if (hoveredStopRef.current === stop.id) return;
          hoveredStopRef.current = stop.id;
          showTaxiType(stop);
          return;
        }
        if (stop.mode !== "mtr") return;
        if (hoveredStopRef.current === stop.id) return;
        hoveredStopRef.current = stop.id;
        const source = map.getSource("stops-hover");
        if (source && source.type === "geojson") {
          const feature: GeoJSON.Feature<GeoJSON.Point> = {
            type: "Feature",
            properties: {
              image: selectionImage(map, stop, dotsRef.current),
            },
            geometry: {
              type: "Point",
              coordinates: [stop.longitude, stop.latitude],
            },
          };
          (source as GeoJSONSource).setData({
            type: "FeatureCollection",
            features: [feature],
          });
        }
        map.setLayoutProperty(
          "stops-hover",
          "icon-size",
          dotsRef.current ? selectedDotSize : selectedSignSize,
        );
        showStopName(stop);
      };

      const lineAt = (point: { x: number; y: number }) => {
        // A station block sits above the lines: if the pointer is on the
        // block, the station wins over a line passing underneath.
        if (
          map.queryRenderedFeatures([point.x, point.y], { layers: ["stops"] })
            .length > 0
        ) {
          return null;
        }
        // Wider than the painted line, so a finger hits it and so a lane
        // shifted by `lineOffset` stays inside the query box.
        const box: [[number, number], [number, number]] = [
          [point.x - 12, point.y - 12],
          [point.x + 12, point.y + 12],
        ];
        return map.queryRenderedFeatures(box, { layers: ["mtr-lines"] })[0] ?? null;
      };

      map.on("mousemove", (event) => {
        if (
          map.queryRenderedFeatures(event.point, { layers: ["stops"] }).length > 0
        ) {
          clearLine();
          return;
        }
        const feature = lineAt(event.point);
        if (!feature) {
          clearLine();
          return;
        }
        map.getCanvas().style.cursor = "pointer";
        showHoveredLine(feature, event.lngLat);
      });
      map.on("click", (event) => {
        // A tap on the open map drops a pinned station name.
        if (
          map.queryRenderedFeatures(event.point, { layers: ["stops"] }).length === 0
        ) {
          hideStopName();
        }
        const feature = lineAt(event.point);
        if (feature) {
          showHoveredLine(feature, event.lngLat);
        } else {
          clearHoveredLine();
        }
      });
      map.on("mouseout", clearHoveredLine);
      map.on("movestart", () => {
        hideStopName();
        clearHoveredLine();
      });

      map.on("mousemove", "stops", (event) => {
        const feature = event.features?.[0];
        if (feature) showHoveredStop(feature);
      });
      map.on("mouseleave", "stops", clearHoveredStop);

      map.on("click", "stops", (event) => {
        clearLineRef.current();
        // An open stop opens the details sheet; a closed (grey) stop only shows
        // its route board. Prefer an open stop when pins overlap.
        const open = event.features?.find((item) => item.properties?.open === true);
        const closed = event.features?.find((item) => item.properties?.open === false);
        const feature = open ?? closed;
        const id = feature?.properties?.id;
        if (typeof id !== "string") return;
        const match = stopsRef.current.find((stop) => stop.id === id);
        if (!match) return;
        if (match.mode === "mtr") {
          stopNamePinned = true;
          showStopName(match);
        } else {
          hideStopName();
        }
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
      // Stations must paint above the line layers, so their square hit areas
      // win over a line passing underneath.
      map.moveLayer("stops");
      map.moveLayer("stops-hover");
      map.moveLayer("selection");
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

  function loadCatalogue(mode: Mode): Promise<Stop[]> {
    const cached = cataloguesRef.current[mode];
    if (cached) return Promise.resolve(cached);
    const pending = cataloguePromisesRef.current.get(mode);
    if (pending) return pending;
    const promise = fetch(`${basePath}/stops-${mode}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`stops-${mode}`);
        return response.json() as Promise<{ stops: Stop[] }>;
      })
      .then(async (body) => {
        const stops = mode === "taxi" ? await withTaxiKinds(body.stops) : body.stops;
        cataloguesRef.current[mode] = stops;
        return stops;
      })
      .catch(() => {
        // Cache the empty result so a failed mode does not loop on every draw.
        cataloguesRef.current[mode] = [];
        return [];
      })
      .finally(() => {
        cataloguePromisesRef.current.delete(mode);
      });
    cataloguePromisesRef.current.set(mode, promise);
    return promise;
  }

  function prefetchOtherModes(current: Mode) {
    // Let the active mode become interactive first, then fill the cache for the
    // other tabs. The map does not wait for this.
    setTimeout(() => {
      for (const mode of modes) {
        if (mode !== current) void loadCatalogue(mode);
      }
    }, 2000);
  }

  function selectNearest(fix: Fix | null) {
    if (!fix) return;
    const mode = activeRef.current;
    const catalogue = cataloguesRef.current[mode];
    if (!catalogue) {
      void loadCatalogue(mode).then(() => {
        if (activeRef.current === mode) selectNearest(fix);
      });
      return;
    }
    const nearest = nearestStop(
      catalogue,
      mode,
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

  function ensureMtrLines(map: MlMap) {
    if (mtrLinesLoadedRef.current || mtrLinesLoadingRef.current) return;
    mtrLinesLoadingRef.current = true;
    fetch(`${basePath}/mtr-lines.geojson`)
      .then((response) => {
        if (!response.ok) throw new Error("mtr-lines");
        return response.json() as Promise<GeoJSON.FeatureCollection>;
      })
      .then((body) => {
        const source = map.getSource("mtr-lines");
        if (!source || source.type !== "geojson") return;
        (source as GeoJSONSource).setData(body);
        mtrLinesLoadedRef.current = true;
      })
      .catch(() => {
        // Leave the source empty; the next MTR draw tries again.
      })
      .finally(() => {
        mtrLinesLoadingRef.current = false;
      });
  }

  function drawStops(map: MlMap) {
    const mode = activeRef.current;
    // The rail line is context for the MTR tab only; the other tabs keep the
    // map as uncluttered as it was.
    for (const id of [
      "mtr-lines-casing",
      "mtr-lines",
      "mtr-lines-hover-casing",
      "mtr-lines-hover",
    ]) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(
          id,
          "visibility",
          mode === "mtr" ? "visible" : "none",
        );
      }
    }
    if (mode === "mtr") ensureMtrLines(map);

    const catalogue = cataloguesRef.current[mode];
    if (!catalogue) {
      setStops([]);
      return;
    }
    const hours = hoursRef.current;
    const now = new Date();
    const bounds = map.getBounds();
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
          icon: stop.mode === "taxi" ? `taxi-${stop.taxi ?? "urban"}` : stop.mode,
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
    const square = !dot && focus?.mode === "mtr";
    map.setLayoutProperty(
      "selection",
      "icon-anchor",
      dot || square ? "center" : "bottom",
    );
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
    void loadCatalogue(activeRef.current).then(() => {
      if (cancelled) return;
      selectNearest(fixRef.current);
      const map = mapRef.current;
      if (map?.isStyleLoaded()) drawStops(map);
      prefetchOtherModes(activeRef.current);
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
    clearLineRef.current();
    hideStopNameRef.current();
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    drawStops(map);
    // Switching tabs cancels the picked stop: close the sheet, hide the route
    // board and clear the highlight.
    setSelected(null);
    setBoard(null);

    let cancelled = false;
    void loadCatalogue(active).then(() => {
      if (cancelled) return;
      const current = mapRef.current;
      if (current?.isStyleLoaded()) drawStops(current);
    });
    return () => {
      cancelled = true;
    };
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
          <div className="brand-head">
            <h1>{t.brand}</h1>
            <button
              type="button"
              className="lang-toggle"
              onClick={toggleLocale}
              aria-label={t.switchLanguage}
              title={t.switchLanguage}
            >
              {locale === "en" ? "中文" : "EN"}
            </button>
          </div>
          <p>{t.stopsInView(stops.length)}</p>
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
                {t.mode[mode]}
              </button>
            ))}
          </div>
          {mtrClosed ? (
            <div className="notice" role="status">
              <strong>{t.mtrClosedTitle}</strong>
              <span>{t.mtrClosedHours(serviceHoursLabel(mtrSchedule))}</span>
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
        aria-label={t.locate[locateState]}
        title={t.locate[locateState]}
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
          taxi={selected.taxi}
          taxiType={selected.taxiType}
          taxiHours={selected.taxiHours}
          onClose={() => {
            setSelected(null);
            setBoard(null);
          }}
        />
      ) : null}
    </div>
  );
}

function inHongKong(fix: Fix): boolean {
  return (
    fix.latitude >= hkBounds.south &&
    fix.latitude <= hkBounds.north &&
    fix.longitude >= hkBounds.west &&
    fix.longitude <= hkBounds.east
  );
}

const taxiStandById = new Map<string, ReturnType<typeof taxiStandInfo>>();
let taxiKindsLoaded: Promise<void> | null = null;

function loadTaxiKinds(): Promise<void> {
  if (taxiKindsLoaded) return taxiKindsLoaded;
  taxiKindsLoaded = fetch(`${basePath}/taxi-stands.geojson`)
    .then((response) => {
      if (!response.ok) throw new Error("taxi-stands");
      return response.json() as Promise<{
        features?: {
          properties?: { OBJECTID?: number; Status_EN?: string; Status_TC?: string };
        }[];
      }>;
    })
    .then((body) => {
      for (const feature of body.features ?? []) {
        const id = feature.properties?.OBJECTID;
        const statusEn = feature.properties?.Status_EN;
        if (typeof id !== "number" || typeof statusEn !== "string") continue;
        taxiStandById.set(
          `taxi:${id}`,
          taxiStandInfo(statusEn, feature.properties?.Status_TC ?? ""),
        );
      }
    })
    .catch(() => {
      taxiKindsLoaded = null;
    });
  return taxiKindsLoaded;
}

async function withTaxiKinds(stops: Stop[]): Promise<Stop[]> {
  await loadTaxiKinds();
  if (taxiStandById.size === 0) return stops;
  return stops.map((stop) => {
    const info = taxiStandById.get(stop.id);
    if (!info) return { ...stop, taxi: "urban" as const };
    return { ...stop, taxi: info.kind, taxiType: info.type, taxiHours: info.hours };
  });
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
    const image =
      stop.mode === "taxi" ? `taxi-${stop.taxi ?? "urban"}-dot-sel` : `${stop.mode}-dot-sel`;
    if (!map.hasImage(image)) {
      map.addImage(
        image,
        stop.mode === "taxi"
          ? taxiDotHighlight(stop.taxi ?? "urban")
          : stopDotHighlight(stop.mode),
        { pixelRatio: stopIconPixelRatio },
      );
    }
    return image;
  }
  const image = stop.mode === "taxi" ? `taxi-${stop.taxi ?? "urban"}-sel` : `${stop.mode}-sel`;
  if (!map.hasImage(image)) {
    map.addImage(
      image,
      stop.mode === "taxi"
        ? taxiSignHighlight(stop.taxi ?? "urban")
        : stopIconHighlight(stop.mode),
      { pixelRatio: stopIconPixelRatio },
    );
  }
  return image;
}
