const dbName = "hk-traffic";
const storeName = "catalogues";
const ttlMs = 24 * 60 * 60 * 1000;

type Entry = { savedAt: number; value: unknown };

let opening: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("indexedDB"));
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

function resultOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readEntry(key: string): Promise<Entry | null> {
  try {
    const db = await database();
    const tx = db.transaction(storeName, "readonly");
    const entry = await resultOf(tx.objectStore(storeName).get(key));
    if (!entry || typeof entry !== "object" || !("savedAt" in entry)) return null;
    return entry as Entry;
  } catch {
    return null;
  }
}

async function writeEntry(key: string, value: unknown): Promise<void> {
  const db = await database();
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put({ savedAt: Date.now(), value } satisfies Entry, key);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Stop catalogues change with a deploy, not minute by minute. A copy newer
// than a day is used as-is. An older copy is replaced, and kept only when the
// network request fails.
export async function loadCachedJson<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = await readEntry(key);
  if (hit && Date.now() - hit.savedAt < ttlMs) return hit.value as T;
  try {
    const value = await load();
    try {
      await writeEntry(key, value);
    } catch {
      // A full disk or private mode still leaves this visit with the download.
    }
    return value;
  } catch (error) {
    if (hit) return hit.value as T;
    throw error;
  }
}
