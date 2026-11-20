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
