const bookmarksKey = "hk-traffic.bookmarks";

// Stop ids the visitor has saved, across every mode. The browser keeps them;
// nothing is sent to the server.
export function readBookmarks(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(bookmarksKey) ?? "[]");
    if (!Array.isArray(saved)) return new Set();
    return new Set(saved.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function writeBookmarks(ids: Set<string>) {
  try {
    localStorage.setItem(bookmarksKey, JSON.stringify([...ids]));
  } catch {
    // A full disk or private mode keeps the bookmarks for this visit only.
  }
}
