---
name: locate-button-test
description: Run headless Chrome checks for the realtime-hk-traffic map locate button (web/app/page.tsx locate()). Use when the user says the GPS or locate button does not find their position, after editing locate, placeMe, or the map load path, or to verify a locate fix.
---

# Locate Button Test

Checks that the map's locate button (`.locate`) puts the "me" dot on the map and recentres it. It drives headless Chrome with mocked geolocation against the running dev server, and detects the dot by its colour (`#3d4c8f`) in a screenshot.

The script is `.agents/skills/locate-button-test/scripts/locate-check.mjs`, relative to the repo root.

## Prerequisites

1. The app is running at `http://localhost:3000/`. If it is not, ask the user to start it with `bun run dev` in `web/`. Do not kill a server you did not start.
2. Google Chrome is installed. The default path is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Override it with `CHROME_PATH`.
3. `playwright-core` is installed outside the repo. Install it once with the terminal tool:

   ```
   npm --prefix /tmp/locate-button-test install playwright-core --no-audit --no-fund
   ```

   Do not add it to the project's `package.json`, and do not create files in the repo for this test.

## Run

Run from the repo root (`realtime-hk-traffic`):

```
PLAYWRIGHT_CORE_PATH=/tmp/locate-button-test/node_modules/playwright-core/index.mjs node .agents/skills/locate-button-test/scripts/locate-check.mjs
```

Pass scenario names to run a subset, for example `... locate-check.mjs pan-then-locate`. Set `LOCATE_URL` to test another origin. The exit code is 0 when everything passes and 1 when something fails.

Each run takes roughly 40 seconds. Use a `timeout_ms` of at least 280000.

## Scenarios

| Scenario | What it checks | Passes when |
|---|---|---|
| `hk-fix` | Auto-locate and a tap with an in-HK fix | The dot is at the map centre and the button is `idle` |
| `pan-then-locate` | Regression: pan the map, then tap | The dot moves to the centre after the tap |
| `pan-then-locate-slow-tiles` | Same, with tile requests held for 4 s | The dot moves to the centre while tiles are still loading |
| `outside-hk` | A fix outside the Hong Kong box | No dot is drawn |
| `denied` | No location permission, then a manual tap | The button shows the `error` state |

`pan-then-locate` and `pan-then-locate-slow-tiles` are the important ones. They reproduce the bug fixed in `web/app/page.tsx`. The `locate` callback used to skip `placeMe` and `easeTo` when `map.isStyleLoaded()` was false. That is true while any tile is downloading, so a fix that arrived after a pan was silently dropped.

## Reading results

Each line is `PASS` or `FAIL`, followed by JSON detail: `n` is the marker pixel count, `x`/`y` the centroid, `state` the button `data-state`, and `errors` any page errors. A centroid within 30 px of (640, 400) counts as centred. At least 30 marker pixels are needed to count as a dot.

When a scenario fails, report the failing line to the user. Check whether `isStyleLoaded()` gating, the `me` source, or the `load` handler is involved before changing code.

## Limits

- Detection is by colour on a 1280x800 viewport. If the marker colour in `locate` or the `me` layer changes, update `MARKER` in the script.
- The `outside-hk` and `denied` scenarios assert the current designed behaviour. Update them if the UX for those states changes.
- If a page never reaches `load` (for example, tiles never arrive), no dot is drawn at all. This is a separate, pre-existing limitation, and the test does not cover it.
- Headless Chrome cannot show a real permission prompt or real GPS. Confirm on a device when the failure looks device-specific.
