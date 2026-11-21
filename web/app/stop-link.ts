const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const modes = ["mtr", "bus", "minibus", "ferry", "taxi"];

// A share link is the stop id with slashes instead of colons:
// bus:kmb:001234 becomes /bus/kmb/001234/
export function stopPath(id: string): string {
  const parts = id.split(":").map((part) => encodeURIComponent(part));
  return `${basePath}/${parts.join("/")}/`;
}

export function stopIdFromPath(pathname: string): string | null {
  let path = pathname;
  if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
    path = path.slice(basePath.length);
  }
  const parts = path.split("/").filter(Boolean).map(decodePart);
  const mode = parts[0];
  if (!mode || !modes.includes(mode) || parts.length < 2) return null;
  return parts.join(":");
}

const lastStopKey = "hk-traffic.last-stop";
const lastStopsKey = "hk-traffic.last-stops";

function stopMode(id: string): string | null {
  const mode = id.split(":")[0];
  if (!mode || !modes.includes(mode) || id.split(":").length < 2) return null;
  return mode;
}

function readStops(): Record<string, string> {
  try {
    const raw = localStorage.getItem(lastStopsKey);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (parsed && typeof parsed === "object") {
      const saved: Record<string, string> = {};
      for (const [mode, id] of Object.entries(parsed)) {
        if (typeof id === "string" && stopMode(id) === mode) saved[mode] = id;
      }
      if (Object.keys(saved).length > 0) return saved;
    }
  } catch {
    // A broken store falls through to the older single key.
  }
  try {
    const id = localStorage.getItem(lastStopKey);
    const mode = id ? stopMode(id) : null;
    if (id && mode) return { [mode]: id };
  } catch {
    return {};
  }
  return {};
}

// No mode means the stop opened most recently. A mode means that tab's stop.
export function readLastStop(mode?: string): string | null {
  try {
    if (!mode) {
      const id = localStorage.getItem(lastStopKey);
      if (id && stopMode(id)) return id;
    }
  } catch {
    return null;
  }
  const saved = readStops();
  if (mode) return saved[mode] ?? null;
  return Object.values(saved)[0] ?? null;
}

export function writeLastStop(id: string) {
  const mode = stopMode(id);
  if (!mode) return;
  try {
    const saved = readStops();
    saved[mode] = id;
    localStorage.setItem(lastStopsKey, JSON.stringify(saved));
    localStorage.setItem(lastStopKey, id);
  } catch {
    // Private mode can refuse the write. The address still records this visit.
  }
}

export function linkedStopId(): string | null {
  const query = new URLSearchParams(window.location.search).get("stop");
  if (query) return query;
  return stopIdFromPath(window.location.pathname);
}

export function writeStopLink(id: string | null) {
  const url = new URL(window.location.href);
  url.searchParams.delete("stop");
  url.pathname = id ? stopPath(id) : `${basePath}/`;
  history.replaceState(null, "", url);
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}
