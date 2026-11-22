import destinationColors from "../public/ferry-destination-colors.json";
import type { StationColor } from "./mtr-station-color";

const byName = destinationColors as Record<string, StationColor>;

export function ferryDestinationColor(label: string): StationColor | null {
  const trimmed = label.trim();
  if (byName[trimmed]) return byName[trimmed];
  // Timetable destinations may be English-only; match against the English half.
  const lower = trimmed.toLowerCase();
  for (const [key, value] of Object.entries(byName)) {
    if (key.toLowerCase().endsWith(lower) || key.toLowerCase().includes(` ${lower}`)) {
      return value;
    }
  }
  return null;
}
