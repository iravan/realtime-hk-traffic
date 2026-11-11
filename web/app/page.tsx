"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AttributionControl, GeoJSONSource, Map as MlMap, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { stopIconImage, stopIconPixelRatio, stopIconUrl, type Mode } from "./stop-icon";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const modes = ["mtr", "bus", "minibus", "taxi"] as const;

type Stop = {
  id: string;
  mode: Mode;
  name: string;
  latitude: number;
  longitude: number;
};

export default function Page() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [enabled, setEnabled] = useState<Record<Mode, boolean>>({
    mtr: true,
    bus: true,
    minibus: true,
    taxi: true,
  });
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const catalogueRef = useRef<Stop[] | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [selected, setSelected] = useState<Stop | null>(null);

  useEffect(() => {
    const node = container.current;
    if (!node || mapRef.current) return;
    setWorkerUrl(`${basePath}/maplibre-gl-worker.mjs`);
    const map = new MlMap({
      container: node,
      center: [114.1694, 22.3193],
      zoom: 14,
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
    map.on("load", () => {
      for (const mode of modes) {
        map.addImage(mode, stopIconImage(mode), { pixelRatio: stopIconPixelRatio });
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
          "icon-image": ["get", "mode"],
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.7, 15, 1, 17, 1.2],
        },
      });
      map.on("click", "stops", (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;
        if (typeof id !== "string") return;
        const match = stopsRef.current.find((stop) => stop.id === id);
        if (match) setSelected(match);
      });
      map.on("mouseenter", "stops", () => {
        map.getCanvas().style.cursor = "pointer";
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

  function drawStops(map: MlMap) {
    const catalogue = catalogueRef.current;
    if (!catalogue) return;
    const bounds = map.getBounds();
    const selectedModes = modes.filter((mode) => enabledRef.current[mode]);
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    const visible = catalogue.filter(
      (stop) =>
        selectedModes.includes(stop.mode) &&
        stop.latitude >= south &&
        stop.latitude <= north &&
        stop.longitude >= west &&
        stop.longitude <= east,
    );
    setStops(visible);
    const source = map.getSource("stops");
    if (!source || source.type !== "geojson") return;
    (source as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: visible.map((stop) => ({
        type: "Feature",
        properties: { id: stop.id, mode: stop.mode },
        geometry: { type: "Point", coordinates: [stop.longitude, stop.latitude] },
      })),
    });
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`${basePath}/stops.json`)
      .then((response) => response.json())
      .then((body: { stops: Stop[] }) => {
        if (cancelled) return;
        catalogueRef.current = body.stops;
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

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    drawStops(map);
  }, [enabled]);

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
        <div className="filters">
          {modes.map((mode) => (
            <button
              key={mode}
              type="button"
              data-mode={mode}
              className={enabled[mode] ? "on" : ""}
              onClick={() =>
                setEnabled((current) => ({ ...current, [mode]: !current[mode] }))
              }
            >
              {label(mode)}
            </button>
          ))}
        </div>
      </div>
      {selected ? (
        <aside className="sheet">
          <header>
            <div className="stop-title">
              <StopSign mode={selected.mode} />
              <div>
                <h2>{selected.name}</h2>
                <p className="mode">{label(selected.mode)}</p>
              </div>
            </div>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </header>
        </aside>
      ) : null}
    </div>
  );
}

function StopSign({ mode }: { mode: Mode }) {
  const src = useMemo(() => stopIconUrl(mode), [mode]);
  return <img className="stop-sign" src={src} alt="" />;
}

function label(mode: Mode) {
  if (mode === "mtr") return "MTR";
  if (mode === "bus") return "Bus";
  if (mode === "minibus") return "Minibus";
  return "Taxi";
}

