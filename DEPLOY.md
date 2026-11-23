# Deploying to Vercel

`vercel.json` declares two services in one project:

- `web/` — static Next.js export (`output: "export"`)
- `server/` — container built from `server/Dockerfile`

Routing: `/api/*` goes to the server and every other path goes to the web app.
Requests reach the server with the `/api` prefix intact, so the router mounts
its routes both at `/stops` and under `/api`. A shared stop path
(`/mtr/…`, `/bus/…`, `/minibus/…`, `/ferry/…`, `/taxi/…`) is rewritten to the web app at
`/` and the browser address stays the stop path.

## Required environment variables

- `REDIS_URL` — **required**. The process refuses to start without a reachable
  Redis, and Vercel then reports that the server never listened on `PORT`.
  Both `redis://` and `rediss://` (TLS, what managed providers hand out) work.
  Fastest path: add **Upstash Redis** from the Vercel Marketplace (Storage →
  Marketplace), then copy its TLS connection string into a `REDIS_URL`
  environment variable for Production. The integration may name its own
  variables (`KV_URL`, `UPSTASH_REDIS_URL`, …); point `REDIS_URL` at that value.
- `CORS_ORIGINS` — optional. Public traffic is same-origin through the rewrite,
  so this only matters for `bun run dev` or the GitHub Pages build reaching the
  API cross-origin. Comma-separated origins.
- `LIVE_CATALOGUES` — optional. Set to `1` to refresh the bus, minibus and taxi
  catalogues from upstream at startup. Leave it unset to serve the bundled
  catalogue only; that is faster and avoids thousands of upstream requests.
- `PORT` — injected by Vercel (`80` for container services). The image defaults
  to `3000` for local runs.

If Redis is missing or unreachable the container now exits within 5s and prints
`redis is unreachable, refusing to start` or `redis did not answer within 5s` to
stderr, instead of hanging until the platform's startup timeout.

## Calling the API from the web app

The sheet calls `GET {apiBase}/stops/{id}/arrivals` and listens to
`GET {apiBase}/stops/{id}/events` for live pushes. `apiBase` is
`NEXT_PUBLIC_API_BASE` when set, otherwise `/api` on a Vercel build and empty on
a static host with a base path — an empty value leaves the sheet showing only
the stop name and mode.

- On Vercel nothing needs setting: the web app and the API share an origin, so
  `/api` resolves through the rewrite above.
- On GitHub Pages there is no API. Set the repository variable `API_BASE` to
  `https://<your-vercel-deployment>/api` (Settings → Secrets and variables →
  Actions → Variables); `pages.yml` passes it as `NEXT_PUBLIC_API_BASE`. Then set
  `CORS_ORIGINS=https://iravan.github.io` on the Vercel project, because the
  browser now reaches the API cross-origin.

## Stop catalogue

`server/data/stops.json` is compiled into the binary and seeded at boot, so
every stop is addressable immediately. Live KMB, Citybus and taxi lists are
still fetched and override the seed by id; a stop seen twice is refreshed, not
listed twice.

The green-minibus crawl is the reason the seed exists: it takes thousands of
requests to data.etagmb.gov.hk and cannot finish inside a function that is
frozen between requests, so without the seed the catalogue had no minibus
stops at all and every minibus id answered `{"error":"unknown stop"}`. The
crawl still runs in the background on a best-effort basis, to pick up stops
that changed after the seed was generated.

`server/data/gmb-routes.json` is also compiled into the binary. The ETA feed
names a route only by an internal `route_id`, and the live crawl that resolves
those ids throttles easily, so arrivals were labelled with the numeric id
(`2004033` instead of `49S`). The bundled map names every known route id; the
live crawl may extend it. Regenerate it with:

```bash
python3 scripts/fetch-minibus-routes.py --routes-only
```

A full run of that script, without `--routes-only`, also refreshes the stop
lists' `routes` arrays.

Regenerate the canonical seed (`server/data/stops.json`) from a running server
when the catalogue changes. The web copy is generated during the web build; the
runbook is in [README.md](README.md#updating-catalogues).

## Why the server is a container

Vercel's Rust framework builder cross-compiles to `x86_64-unknown-linux-gnu`
with `cargo zigbuild`. Builds of this project failed before compiling anything
with `error: no such command: zigbuild`, because `cargo-zigbuild` was missing
from the build environment. `server/Dockerfile` builds the binary in a plain
Rust image and runs it on `debian:bookworm-slim`, which does not depend on that
toolchain. It also suits this server better: the SSE `/events` stream is a
long-lived connection, which is a poor fit for serverless functions.

## Fallbacks if container services are unavailable

### A. Keep Vercel's Rust builder and install the missing toolchain

```json
{
  "services": {
    "server": {
      "root": "server",
      "framework": "rust",
      "buildCommand": "cargo install cargo-zigbuild --locked && python3 -m pip install ziglang && cargo zigbuild --release --target x86_64-unknown-linux-gnu --bin server"
    }
  }
}
```

Unverified. Overriding `buildCommand` may also bypass the Rust builder's
packaging step, in which case the build succeeds but produces nothing runnable.

### B. Host the API outside Vercel (preferred fallback)

Keep the static site on Vercel, run `server/` on any container host, and point
`/api` at that origin — rewrites accept external URLs and proxy the request, so
the browser still sees a same-origin API:

```json
{
  "services": {
    "web": {
      "root": "web",
      "framework": "nextjs"
    }
  },
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://api.example.com/:path*"
    },
    {
      "source": "/(.*)",
      "destination": {
        "service": "web"
      }
    }
  ]
}
```
