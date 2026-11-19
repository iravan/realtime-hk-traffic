# Redis keys

One key family is used at runtime; a second was removed.

## `arrivals:{stop_id}` — string, TTL 90s

- Value: `{ "fetched_at", "live", "status"?, "note"?, "rows": [ ... ] }`
- Written by `refresh()` in `server/src/main.rs` whenever it fetches a feed for a stop:
  - a stop's sheet opens (the `/stops/{id}/events` SSE stream registers a watcher)
  - a cold `GET /stops/{id}/arrivals` misses the cache
  - the poll loop refreshes watched stops every 15s, and all 98 MTR stations every 4th tick (~60s)
- Read by `read_snapshot()` (`GET arrivals:{id}`) in the `arrivals` handler.
- Expiry: `EX 90` (`ETA_TTL_SECS`).
- On write failure the snapshot is simply not cached; the next poll retries.

## `stop:{id}` — removed

Previously written at cold start for every catalogue stop, with **no TTL** and **never read**.
The stop index is kept in memory (`by_id` / `stops`), so this key was dead weight that
accumulated on every deploy and could exhaust the store. Removed; Redis now only holds
the ephemeral `arrivals:{id}` snapshots.

## Operational notes

- Redis is required to start: the process fails fast (5s) if it cannot connect.
- URL source, in order: `REDIS_URL`, `KV_URL`, `UPSTASH_REDIS_URL`. `rediss://` (TLS) works.
- After upgrading from a build that wrote `stop:*`, clear the leftovers once with
  `FLUSHDB` (or `DEL stop:*`).
