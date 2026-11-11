# Realtime HK Traffic

A live map of Hong Kong public-transport stops. No sign-in.

## Demo

In one terminal, from `server/`:

```bash
cargo run
```

The API listens on http://127.0.0.1:8787. Redis is `127.0.0.1:6379`. KMB stops, MTR stations, and taxi stands load first. Citybus and green minibus stops follow in the background.

In another terminal, from `web/`:

```bash
bun install
bun run dev
```

Open the URL Bun prints. The map starts at Mong Kok. Turn modes on and off, then tap a stop for arrivals.

The lists of remaining work are [CHECKLIST.md](CHECKLIST.md) and [server/CHECKLIST.md](server/CHECKLIST.md).
