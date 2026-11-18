# Deploying to Vercel

`vercel.json` declares two services in one project:

- `web/` — static Next.js export (`output: "export"`)
- `server/` — container built from `server/Dockerfile`

Routing: `/api/*` goes to the server with the `/api` prefix stripped by a
`request.path` transform, and every other path goes to the web app.

## Required environment variables

- `REDIS_URL` — the server exits at startup without it.
- `CORS_ORIGINS` — optional. Public traffic is same-origin through the rewrite,
  so this only matters for `bun run dev` against a separately hosted API.
- `PORT` — set by Vercel for containers; the image defaults to `3000`.

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

## Why the server is a container

Vercel's Rust framework builder cross-compiles to `x86_64-unknown-linux-gnu`
with `cargo zigbuild`. Builds of this project failed before compiling anything
with `error: no such command: zigbuild`, because `cargo-zigbuild` was missing
from the build environment. `server/Dockerfile` builds the binary in a plain
Rust image and runs it on `debian:bookworm-slim`, which does not depend on that
toolchain. It also suits this server better: the background poll loop and the
SSE `/events` stream are a poor fit for serverless functions.

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
