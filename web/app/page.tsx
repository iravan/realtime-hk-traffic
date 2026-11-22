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
  ferryBoatIconImage,
  ferryBoatSignHighlight,
  citybusIconImage,
  citybusSignHighlight,
  isCitybus,
  isStarFerry,
  modeColor,
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
import {
  clockAt,
  isScheduleOpen,
  isStopOpen,
  schedulesForStop,
  serviceHoursLabel,
  type ServiceHours,
} from "./service-hours";
import { mtrDestinationColor, mtrStationColor } from "./mtr-station-color";
import { loadCachedJson } from "./catalogue-cache";
import { linkedStopId, readLastStop, writeLastStop, writeStopLink } from "./stop-link";
import { localizeBilingualName, localizeStopName } from "./stop-name";
import lineTerminalsJson from "./mtr-line-terminals.json";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const modes = ["mtr", "bus", "minibus", "ferry", "taxi"] as const;

// The category tabs use their own flat vehicle artwork, served from
// `public/icons`. They are plain files, so they need no canvas at render time.
const categoryIcons: Record<Mode, string> = {
  mtr: `${basePath}/icons/mtr.svg`,
  bus: `${basePath}/icons/bus.svg`,
  minibus: `${basePath}/icons/minibus.svg`,
  ferry: `${basePath}/icons/ferry.svg`,
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
// Counted groups stand in for signs until this zoom. Closer than this, every
// stop in the view is its own pin.
const pinZoom = 16;
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
  ferry: 500,
  taxi: 400,
};

// A feature's `icon` is its mode sign. Out of service a stop drops to its
// muted dot, so it stays visible as a location but stops inviting a tap.
const signImage: ExpressionSpecification = [
  "case",
  ["get", "open"],
  ["get", "icon"],
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
  name_tc?: string;
  name_en?: string;
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
  const routeMarkerRef = useRef<Marker | null>(null);
  const cataloguesRef = useRef<Partial<Record<Mode, Stop[]>>>({});
  const cataloguePromisesRef = useRef(new Map<Mode, Promise<Stop[]>>());
  const hoursRef = useRef<ServiceHours | null>(null);
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
  const pendingFocusRef = useRef<Stop | null>(null);
  const focusPadRef = useRef(false);
  const focusPendingRef = useRef<(map: MlMap) => void>(() => {});
  const showStopRef = useRef<(stop: Stop, focus?: boolean) => void>(() => {});
  const linkedStopRef = useRef<string | null>(null);
  const holdSharedViewRef = useRef(false);
  const linkSeenRef = useRef(false);
  if (!linkSeenRef.current && typeof window !== "undefined") {
    linkSeenRef.current = true;
    linkedStopRef.current = linkedStopId() ?? readLastStop();
    holdSharedViewRef.current = linkedStopRef.current !== null;
  }
  focusPendingRef.current = (map) => {
    const stop = pendingFocusRef.current;
    // The style reports loaded before the stop icons exist. Flying then draws
    // the sign mid-zoom, and MapLibre keeps the clipped image.
    if (!stop || !map.getLayer("stops")) return;
    pendingFocusRef.current = null;
    focusPadRef.current = true;
    map.easeTo({
      center: [stop.longitude, stop.latitude],
      zoom: Math.max(map.getZoom(), 16),
      padding: focusPadding(),
    });
  };
  showStopRef.current = (stop, focus = false) => {
    const open = isStopOpen(stop, hoursRef.current, new Date());
    // The map reads these refs while drawing. State updates land on the next
    // render, so a tab change would otherwise highlight the previous mode.
    selectedRef.current = open ? stop : null;
    boardRef.current = stop;
    setBoard(stop);
    setSelected(open ? stop : null);
    const drawn = mapRef.current;
    if (drawn?.isStyleLoaded()) refreshSelection(drawn);
    writeLastStop(stop.id);
    writeStopLink(stop.id);
    if (!focus) return;
    pendingFocusRef.current = stop;
    const map = mapRef.current;
    if (map) focusPendingRef.current(map);
  };
  const clearFocusPadding = () => {
    if (!focusPadRef.current) return;
    focusPadRef.current = false;
    const map = mapRef.current;
    if (!map?.getLayer("stops")) return;
    map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 0 });
  };

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
        glyphs: "https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf",
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
      map.addImage("ferry-boat", ferryBoatIconImage(), { pixelRatio: stopIconPixelRatio });
      map.addImage("ferry-boat-dot", stopDotImage("ferry", false, "#0c6e8a"), {
        pixelRatio: stopIconPixelRatio,
      });
      map.addImage("citybus", citybusIconImage(), { pixelRatio: stopIconPixelRatio });
      map.addImage("citybus-dot", stopDotImage("bus", false, "#FACC15"), {
        pixelRatio: stopIconPixelRatio,
      });
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
        cluster: true,
        clusterRadius: 56,
        clusterMaxZoom: pinZoom - 1,
      });
      map.addLayer({
        id: "clusters",
        type: "circle",
        source: "stops",
        filter: ["has", "point_count"],
        maxzoom: pinZoom,
        paint: {
          "circle-color": modeColor.bus,
          "circle-radius": ["step", ["get", "point_count"], 18, 10, 22, 50, 28, 200, 34],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fbf7f0",
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "stops",
        filter: ["has", "point_count"],
        maxzoom: pinZoom,
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 13,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#fbf7f0" },
      });
      // A stop that sits alone is still a count of one until the pin zoom.
      map.addLayer({
        id: "stop-singles",
        type: "circle",
        source: "stops",
        filter: ["!", ["has", "point_count"]],
        maxzoom: pinZoom,
        paint: {
          "circle-color": modeColor.bus,
          "circle-radius": 16,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#fbf7f0",
        },
      });
      map.addLayer({
        id: "stop-single-count",
        type: "symbol",
        source: "stops",
        filter: ["!", ["has", "point_count"]],
        maxzoom: pinZoom,
        layout: {
          "text-field": "1",
          "text-font": ["Noto Sans Regular"],
          "text-size": 13,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#fbf7f0" },
      });
      map.addLayer({
        id: "stops",
        type: "symbol",
        source: "stops",
        filter: ["!", ["has", "point_count"]],
        minzoom: pinZoom,
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
        minzoom: pinZoom,
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
        minzoom: pinZoom,
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
        node.textContent = localizeStopName(
          stop.name,
          stop.mode,
          localeRef.current,
          stop.name_tc,
          stop.name_en,
        );
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
          : localizeStopName(
              stop.name,
              stop.mode,
              localeRef.current,
              stop.name_tc,
              stop.name_en,
            );
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
        const open = feature.properties?.open === true;
        const source = map.getSource("stops-hover");
        if (source && source.type === "geojson") {
          const hover: GeoJSON.Feature<GeoJSON.Point> = {
            type: "Feature",
            properties: {
              image: selectionImage(map, stop, !open),
            },
            geometry: {
              type: "Point",
              coordinates: [stop.longitude, stop.latitude],
            },
          };
          (source as GeoJSONSource).setData({
            type: "FeatureCollection",
            features: [hover],
          });
        }
        map.setLayoutProperty(
          "stops-hover",
          "icon-size",
          open ? selectedSignSize : selectedDotSize,
        );
        showStopName(stop);
      };

      const overStops = (point: { x: number; y: number }) =>
        map.queryRenderedFeatures([point.x, point.y], {
          layers: ["stops", "clusters", "cluster-count", "stop-singles", "stop-single-count"],
        }).length > 0;

      const lineAt = (point: { x: number; y: number }) => {
        // A station block sits above the lines: if the pointer is on the
        // block, the station wins over a line passing underneath.
        if (overStops(point)) {
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
        if (overStops(event.point)) {
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
        if (!overStops(event.point)) {
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
        showStopRef.current(match);
      });
      map.on("mouseenter", "stops", (event) => {
        map.getCanvas().style.cursor = event.features?.length ? "pointer" : "";
      });
      map.on("mouseleave", "stops", () => {
        map.getCanvas().style.cursor = "";
      });
      const zoomToCluster = (event: { features?: MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0];
        const clusterId = Number(feature?.properties?.cluster_id);
        const source = map.getSource("stops");
        if (
          !Number.isFinite(clusterId) ||
          !feature ||
          feature.geometry.type !== "Point" ||
          !source ||
          source.type !== "geojson"
        ) {
          return;
        }
        const center = feature.geometry.coordinates as [number, number];
        void (source as GeoJSONSource).getClusterExpansionZoom(clusterId).then((zoom: number) => {
          map.easeTo({ center, zoom: Math.max(zoom, map.getZoom() + 1) });
        });
      };
      const zoomToPin = (event: { features?: MapGeoJSONFeature[] }) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;
        map.easeTo({
          center: feature.geometry.coordinates as [number, number],
          zoom: pinZoom,
        });
      };
      map.on("click", "clusters", zoomToCluster);
      map.on("click", "cluster-count", zoomToCluster);
      map.on("click", "stop-singles", zoomToPin);
      map.on("click", "stop-single-count", zoomToPin);
      for (const layer of ["clusters", "cluster-count", "stop-singles", "stop-single-count"]) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }
      // Stations must paint above the line layers, so their square hit areas
      // win over a line passing underneath.
      map.moveLayer("clusters");
      map.moveLayer("cluster-count");
      map.moveLayer("stop-singles");
      map.moveLayer("stop-single-count");
      map.moveLayer("stops");
      map.moveLayer("stops-hover");
      map.moveLayer("selection");
      drawStops(map);
      focusPendingRef.current(map);
    });
    map.on("moveend", () => {
      const mode = activeRef.current;
      const catalogue = cataloguesRef.current[mode];
      if (!catalogue) return;
      setStops(stopsInView(map, catalogue, mode));
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
    routeMarkerRef.current?.remove();
    routeMarkerRef.current = null;
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
    routeMarkerRef.current = marker;
    return () => {
      marker.remove();
      if (routeMarkerRef.current === marker) routeMarkerRef.current = null;
    };
  }, [board]);

  function loadCatalogue(mode: Mode): Promise<Stop[]> {
    const cached = cataloguesRef.current[mode];
    if (cached) return Promise.resolve(cached);
    const pending = cataloguePromisesRef.current.get(mode);
    if (pending) return pending;
    // Minibus names gained their English half after the first cache, and bus
    // names gained separate Chinese and English fields. A new key makes those
    // copies load instead of the older one saved for 24 hours.
    const catalogueKey =
      mode === "minibus"
        ? "stops-minibus-bilingual"
        : mode === "bus"
          ? "stops-bus-bilingual"
          : `stops-${mode}`;
    const promise = loadCachedJson<{ stops: Stop[] }>(catalogueKey, async () => {
      const response = await fetch(`${basePath}/stops-${mode}.json`);
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
    if (!fix || holdSharedViewRef.current) return;
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
    if (nearest) showStopRef.current(nearest, true);
  }

  function ensureMtrLines(map: MlMap) {
    if (mtrLinesLoadedRef.current || mtrLinesLoadingRef.current) return;
    mtrLinesLoadingRef.current = true;
    loadCachedJson<GeoJSON.FeatureCollection>("mtr-lines", async () => {
      const response = await fetch(`${basePath}/mtr-lines.geojson`);
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
      const source = map.getSource("stops");
      if (source && source.type === "geojson") {
        (source as GeoJSONSource).setData({ type: "FeatureCollection", features: [] });
      }
      refreshSelection(map);
      return;
    }
    const hours = hoursRef.current;
    const now = new Date();
    setStops(stopsInView(map, catalogue, mode));
    const source = map.getSource("stops");
    if (!source || source.type !== "geojson") return;
    // The whole mode is clustered, not just the current view, so a count at
    // the edge does not split when the map moves.
    (source as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: uniqueStops(catalogue, mode).map((stop) => ({
        type: "Feature",
        properties: {
          id: stop.id,
          mode: stop.mode,
          icon:
            stop.mode === "taxi"
              ? `taxi-${stop.taxi ?? "urban"}`
              : stop.mode === "ferry" && !isStarFerry(stop.id)
                ? "ferry-boat"
                : stop.mode === "bus" && isCitybus(stop.id)
                  ? "citybus"
                  : stop.mode,
          open: isStopOpen(stop, hours, now),
        },
        geometry: { type: "Point", coordinates: [stop.longitude, stop.latitude] },
      })),
    });
    for (const layer of ["clusters", "stop-singles"]) {
      if (map.getLayer(layer)) map.setPaintProperty(layer, "circle-color", modeColor[mode]);
    }
    refreshSelection(map);
  }

  // MapLibre reports the style as not loaded while a GeoJSON update or a tile
  // is in flight, which is common right after a tab change. A draw skipped then
  // would leave the previous mode's pins on the map, so wait for idle instead.
  function drawWhenReady(map: MlMap) {
    if (map.isStyleLoaded()) drawStops(map);
    else map.once("idle", () => drawStops(map));
  }

  function refreshSelection(map: MlMap) {
    if (!map.getLayer("selection")) return;
    const focus = selectedRef.current ?? boardRef.current;
    // A greyed stop is drawn as a dot, so its highlight is the ringed dot.
    const dot = focus !== null && !isStopOpen(focus, hoursRef.current, new Date());
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
    loadCachedJson<ServiceHours>("service-hours", async () => {
      const response = await fetch(`${basePath}/service-hours.json`);
      if (!response.ok) throw new Error("service-hours");
      return response.json() as Promise<ServiceHours>;
    })
      .then((body) => {
        if (cancelled) return;
        hoursRef.current = body;
        setHours(body);
        const map = mapRef.current;
        if (map) drawWhenReady(map);
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
      if (map) drawWhenReady(map);
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
    if (manual) holdSharedViewRef.current = false;
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
        // isStyleLoaded() is false while any tile downloads, which silently
        // dropped fixes after a pan. placeMe checks for its source, and the load
        // handler places a fix that arrives before the `me` source exists.
        const map = mapRef.current;
        if (!inHongKong(fix)) {
          if (map) map.easeTo({ center: hkCenter, zoom: hkZoom });
          return;
        }
        fixRef.current = fix;
        if (map) placeMe(map, fix);
        // A shared link or a remembered stop owns the camera until the user asks
        // for a fix. With neither, the nearest stop of this mode opens.
        if (!manual && holdSharedViewRef.current) return;
        if (map) {
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
    const linked = linkedStopRef.current;
    const mode = linked ? modeFromStopId(linked) : null;
    if (mode && mode !== activeRef.current) setActive(mode);
  }, []);

  useEffect(() => {
    locate(false);
  }, []);

  useEffect(() => {
    clearLineRef.current();
    hideStopNameRef.current();
    // Drop the previous mode's highlight before the catalogue for this tab
    // arrives. The refs have to change now; state alone waits for a render.
    selectedRef.current = null;
    boardRef.current = null;
    routeMarkerRef.current?.remove();
    routeMarkerRef.current = null;
    setSelected(null);
    setBoard(null);
    const map = mapRef.current;
    if (map?.isStyleLoaded()) refreshSelection(map);
    if (map) drawWhenReady(map);
    // Each tab keeps its own stop. A shared link or the most recent stop can
    // still be waiting on a mode change, so this pass leaves that id alone.

    let cancelled = false;
    void loadCatalogue(active).then((stops) => {
      if (cancelled) return;
      const pending = linkedStopRef.current;
      const waitingForMode = pending !== null && modeFromStopId(pending) !== active;
      if (!waitingForMode) {
        linkedStopRef.current = null;
        const linked = pending ?? readLastStop(active);
        const stop =
          linked && modeFromStopId(linked) === active
            ? stops.find((item) => item.id === linked)
            : undefined;
        if (stop) showStopRef.current(stop, true);
        else {
          holdSharedViewRef.current = false;
          selectNearest(fixRef.current);
        }
      }
      const current = mapRef.current;
      if (current) drawWhenReady(current);
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
  const ferrySchedule = hours?.modes?.ferry ?? [];
  const clock = now != null ? clockAt(now, hours?.timezone) : null;
  const mtrClosed =
    active === "mtr" && clock != null && mtrSchedule.length > 0 && !isScheduleOpen(mtrSchedule, clock);
  const ferryClosed =
    active === "ferry" &&
    clock != null &&
    ferrySchedule.length > 0 &&
    !isScheduleOpen(ferrySchedule, clock);

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
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18" />
                <path d="M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z" />
              </svg>
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
                  if (mode === active) return;
                  const remembered = readLastStop(mode);
                  linkedStopRef.current = remembered;
                  holdSharedViewRef.current = remembered !== null;
                  clearFocusPadding();
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
              <span>{t.closedHours(serviceHoursLabel(mtrSchedule, t.clock, t.nextDayHours))}</span>
            </div>
          ) : null}
          {ferryClosed ? (
            <div className="notice ferry" role="status">
              <strong>{t.ferryClosedTitle}</strong>
              <span>{t.closedHours(serviceHoursLabel(ferrySchedule, t.clock, t.nextDayHours))}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="map-actions">
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
        <a
          className="report"
          href="https://github.com/iravan/realtime-hk-traffic/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t.report}
          title={t.report}
        >
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 21V4" />
            <path d="M5 4h11.5l-2.2 4 2.2 4H5" />
          </svg>
        </a>
      </div>
      {selected ? (
        <StopSheet
          key={selected.id}
          id={selected.id}
          mode={selected.mode}
          name={selected.name}
          nameTc={selected.name_tc}
          nameEn={selected.name_en}
          latitude={selected.latitude}
          longitude={selected.longitude}
          taxi={selected.taxi}
          taxiType={selected.taxiType}
          taxiHours={selected.taxiHours}
          serviceHours={
            selected.mode === "ferry" && hours
              ? schedulesForStop(selected, hours)
                  .map((schedule) => serviceHoursLabel(schedule, t.clock, t.nextDayHours))
                  .join(", ") || null
              : null
          }
          onClose={() => {
            setSelected(null);
            setBoard(null);
            clearStopParam();
            clearFocusPadding();
          }}
        />
      ) : null}
    </div>
  );
}

function modeFromStopId(id: string): Mode | null {
  const mode = id.split(":")[0];
  return modes.includes(mode as Mode) ? (mode as Mode) : null;
}

// Keep the stop in the part of the map the details sheet does not cover, so
// the whole sign stays on screen. The padding lasts until the sheet closes.
function focusPadding(): { top: number; bottom: number; left: number; right: number } {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const narrow = window.matchMedia("(max-width: 767px)").matches;
  if (narrow) {
    return {
      top: 96,
      bottom: Math.round(window.innerHeight * 0.52) + 16,
      left: 16,
      right: 16,
    };
  }
  return { top: 96, bottom: 24, left: 24, right: Math.round(22 * root + 12) + 24 };
}

function clearStopParam() {
  if (!linkedStopId()) return;
  writeStopLink(null);
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
  taxiKindsLoaded = loadCachedJson<{
    features?: {
      properties?: { OBJECTID?: number; Status_EN?: string; Status_TC?: string };
    }[];
  }>("taxi-stands", async () => {
    const response = await fetch(`${basePath}/taxi-stands.geojson`);
    if (!response.ok) throw new Error("taxi-stands");
    return response.json();
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

// Several feeds can publish one coordinate. The first stop owns the pin and
// the server merges the arrivals.
function uniqueStops(catalogue: Stop[], mode: Mode): Stop[] {
  const seen = new Set<string>();
  const stops: Stop[] = [];
  for (const stop of catalogue) {
    if (stop.mode !== mode) continue;
    const key = `${stop.latitude.toFixed(6)}:${stop.longitude.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stops.push(stop);
  }
  return stops;
}

function stopsInView(map: MlMap, catalogue: Stop[], mode: Mode): Stop[] {
  const bounds = map.getBounds();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const west = bounds.getWest();
  const east = bounds.getEast();
  return uniqueStops(catalogue, mode).filter(
    (stop) =>
      stop.latitude >= south &&
      stop.latitude <= north &&
      stop.longitude >= west &&
      stop.longitude <= east,
  );
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
// board, or the ringed dot used when the stop is closed. Built on first use,
// then reused from the style.
function selectionImage(map: MlMap, stop: Stop, dots: boolean): string {
  const boat = stop.mode === "ferry" && !isStarFerry(stop.id);
  const citybus = stop.mode === "bus" && isCitybus(stop.id);
  if (dots) {
    const image = boat
      ? "ferry-boat-dot-sel"
      : citybus
        ? "citybus-dot-sel"
        : stop.mode === "taxi"
          ? `taxi-${stop.taxi ?? "urban"}-dot-sel`
          : `${stop.mode}-dot-sel`;
    if (!map.hasImage(image)) {
      map.addImage(
        image,
        boat
          ? stopDotHighlight("ferry", "#0c6e8a")
          : citybus
            ? stopDotHighlight("bus", "#FACC15")
            : stop.mode === "taxi"
              ? taxiDotHighlight(stop.taxi ?? "urban")
              : stopDotHighlight(stop.mode),
        { pixelRatio: stopIconPixelRatio },
      );
    }
    return image;
  }
  const image = boat
    ? "ferry-boat-sel"
    : citybus
      ? "citybus-sel"
      : stop.mode === "taxi"
        ? `taxi-${stop.taxi ?? "urban"}-sel`
        : `${stop.mode}-sel`;
  if (!map.hasImage(image)) {
    map.addImage(
      image,
      boat
        ? ferryBoatSignHighlight()
        : citybus
          ? citybusSignHighlight()
          : stop.mode === "taxi"
            ? taxiSignHighlight(stop.taxi ?? "urban")
            : stopIconHighlight(stop.mode),
      { pixelRatio: stopIconPixelRatio },
    );
  }
  return image;
}
