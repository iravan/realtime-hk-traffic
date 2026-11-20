import stationColors from "../public/mtr-station-colors.json";
import mtrStops from "../public/stops-mtr.json";

export type StationColor = { color: string; font: string; badge?: string };

const byCode = stationColors as Record<string, StationColor>;
const byName = new Map<string, StationColor>();
for (const stop of mtrStops.stops) {
  const code = stop.id.startsWith("mtr:") ? stop.id.slice(4) : "";
  const color = byCode[code];
  if (color) byName.set(stop.name, color);
}
const choiHung = byCode.CHH;
if (choiHung) choiHung.badge = "station-badge-chh";

export function mtrStationColor(stopId: string): StationColor | null {
  const code = stopId.startsWith("mtr:") ? stopId.slice(4) : "";
  return byCode[code] ?? null;
}

export function mtrDestinationColor(label: string): StationColor | null {
  return byName.get(label) ?? byCode[label] ?? null;
}
