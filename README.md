# Realtime HK Traffic

A map of Hong Kong public-transport stops. No sign-in.

## Demo

The page loads `web/public/stops.json` when it starts. That file is a saved copy of every MTR station, bus stop, green minibus stop, and taxi stand. The map does not need the API.

```bash
cd web
bun install
bun run dev
```

Open the URL Bun prints. The map starts at Mong Kok. Turn modes on and off, then tap a stop.

The published demo is https://iravan.github.io/realtime-hk-traffic/

The lists of remaining work are [CHECKLIST.md](CHECKLIST.md) and [server/CHECKLIST.md](server/CHECKLIST.md).
