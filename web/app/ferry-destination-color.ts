import destinationColors from "../public/ferry-destination-colors.json";
import type { StationColor } from "./mtr-station-color";

const byName = destinationColors as Record<string, StationColor>;

export function ferryDestinationColor(label: string): StationColor | null {
  return byName[label.trim()] ?? null;
}
