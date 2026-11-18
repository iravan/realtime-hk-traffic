# Realtime HK Traffic

A map of Hong Kong public-transport stops. No sign-in.

## Demo

The page loads `web/public/stops.json` when it starts. That file is a saved copy of every MTR station, bus stop, green minibus stop, and taxi stand. It also loads `web/public/service-hours.json`, which holds the static service windows for each mode, MTR station, and candidate route. Stops outside their window are grey and cannot be opened, except stops marked `night: true` because an overnight bus or minibus route serves them. The map does not need the API.

```bash
cd web
bun install
bun run dev
```

Open the URL Bun prints. The map asks the browser for your location and opens the nearest stop of the chosen mode. Choose a mode, then tap a stop.

The published demo is https://iravan.github.io/realtime-hk-traffic/

Vercel deployment notes are in [DEPLOY.md](DEPLOY.md).

The lists of remaining work are [CHECKLIST.md](CHECKLIST.md) and [server/CHECKLIST.md](server/CHECKLIST.md).
