"use client";

import { useEffect, useRef, useState } from "react";
import { AttributionControl, GeoJSONSource, Map as MlMap, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const api = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8787";
const modes = ["mtr", "bus", "minibus", "taxi"] as const;
type Mode = (typeof modes)[number];

type Stop = {
  id: string;
  mode: Mode;
  name: string;
  latitude: number;
  longitude: number;
};

type Row = {
  route: string;
  destination: string;
  minutes?: number;
  time?: string;
};

type Arrivals = {
  fetched_at?: string;
  live?: boolean;
  status?: string;
  note?: string;
  rows?: Row[];
  error?: string;
};

const colors: Record<Mode, string> = {
  mtr: "#c44736",
  bus: "#2f6f4e",
  minibus: "#c4841d",
  taxi: "#3d4c8f",
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
  const [stops, setStops] = useState<Stop[]>([]);
  const [selected, setSelected] = useState<Stop | null>(null);
  const [arrivals, setArrivals] = useState<Arrivals | null>(null);
  const [arrivalState, setArrivalState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    const node = container.current;
    if (!node || mapRef.current) return;
    setWorkerUrl("/maplibre-gl-worker.mjs");
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
      map.addSource("stops", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "stops",
        type: "circle",
        source: "stops",
        paint: {
          "circle-radius": 6,
          "circle-color": ["get", "color"],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#f4efe6",
        },
      });
      map.on("click", "stops", (event) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id;
        if (typeof id !== "string") return;
        const match = stopsRef.current.find((stop) => stop.id === id);
        if (match) openStop(match);
      });
      map.getCanvas().style.cursor = "pointer";
      void loadStops(map);
    });
    map.on("moveend", () => {
      void loadStops(map);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const stopsRef = useRef<Stop[]>([]);
  stopsRef.current = stops;

  async function loadStops(map: MlMap) {
    const bounds = map.getBounds();
    const selectedModes = modes.filter((mode) => enabledRef.current[mode]);
    const params = new URLSearchParams({
      south: String(bounds.getSouth()),
      west: String(bounds.getWest()),
      north: String(bounds.getNorth()),
      east: String(bounds.getEast()),
      modes: selectedModes.join(","),
    });
    try {
      const response = await fetch(`${api}/stops?${params}`);
      if (!response.ok) return;
      const body = (await response.json()) as { stops: Stop[] };
      setStops(body.stops);
      const source = map.getSource("stops");
      if (!source || source.type !== "geojson") return;
      (source as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: body.stops.map((stop) => ({
          type: "Feature",
          properties: { id: stop.id, color: colors[stop.mode] ?? "#241f1a" },
          geometry: { type: "Point", coordinates: [stop.longitude, stop.latitude] },
        })),
      });
    } catch {
      setStops([]);
    }
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    void loadStops(map);
  }, [enabled]);

  async function openStop(stop: Stop) {
    setSelected(stop);
    setArrivalState("loading");
    setArrivals(null);
    try {
      const response = await fetch(`${api}/stops/${encodeURIComponent(stop.id)}/arrivals`);
      const body = (await response.json()) as Arrivals;
      if (!response.ok) {
        setArrivals(body);
        setArrivalState("error");
        return;
      }
      setArrivals(body);
      setArrivalState("ready");
    } catch {
      setArrivals({ error: "The list didn't load." });
      setArrivalState("error");
    }
  }

  const age = arrivals?.fetched_at ? formatAge(arrivals.fetched_at) : "";

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
            <div>
              <h2>{selected.name}</h2>
              <p className="mode">{label(selected.mode)}</p>
            </div>
            <button type="button" onClick={() => setSelected(null)}>
              Close
            </button>
          </header>
          <div className="body">
            {arrivalState === "loading" ? <p className="muted">Loading arrivals</p> : null}
            {arrivalState === "error" ? (
              <p className="stale">{arrivals?.error ?? "The snapshot is gone."}</p>
            ) : null}
            {arrivalState === "ready" && arrivals?.note === "no-arrivals" ? (
              <p className="muted">There is no arrival list. This is a place to hire a taxi.</p>
            ) : null}
            {arrivalState === "ready" && arrivals?.note !== "no-arrivals" ? (
              <>
                <p className="muted">
                  {arrivals?.live === false ? "Not live. Timetable." : "Live"}
                  {age ? ` · ${age}` : ""}
                  {arrivals?.status ? ` · ${arrivals.status}` : ""}
                </p>
                {(arrivals?.rows ?? []).length === 0 ? (
                  <p className="muted">No arrivals in this snapshot.</p>
                ) : (
                  <ul>
                    {(arrivals?.rows ?? []).map((row, index) => (
                      <li key={`${row.route}-${row.destination}-${index}`}>
                        <strong>
                          {row.route} {row.destination}
                        </strong>
                        <span>
                          {row.minutes !== undefined ? `${row.minutes} min` : ""}
                          {row.time ? ` ${row.time}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}

function label(mode: Mode) {
  if (mode === "mtr") return "MTR";
  if (mode === "bus") return "Bus";
  if (mode === "minibus") return "Minibus";
  return "Taxi";
}

function formatAge(fetchedAt: string) {
  const then = Date.parse(fetchedAt);
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  return `${minutes}m ago`;
}
