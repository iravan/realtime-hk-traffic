// Headless Chrome checks for the map's locate button (web/app/page.tsx, `locate`).
// Run with PLAYWRIGHT_CORE_PATH pointing at playwright-core's index.mjs.
// Usage: node locate-check.mjs [scenario ...]   (no arguments runs all scenarios)

import { pathToFileURL } from "node:url";

const playwrightPath = process.env.PLAYWRIGHT_CORE_PATH;
if (!playwrightPath) {
  console.error("Set PLAYWRIGHT_CORE_PATH to node_modules/playwright-core/index.mjs");
  process.exit(2);
}
const { chromium } = await import(pathToFileURL(playwrightPath).href);

const url = process.env.LOCATE_URL ?? "http://localhost:3000/";
const chromePath =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const HK = { latitude: 22.31, longitude: 114.2 };
const OTHER_HK = { latitude: 22.285, longitude: 114.155 };
const OUTSIDE_HK = { latitude: 23.13, longitude: 113.26 };

// The map centre in a 1280x800 viewport. The "me" marker is #3d4c8f.
const CENTER = { x: 640, y: 400 };
const TOLERANCE_PX = 30;
const MARKER = { r: 61, g: 76, b: 143 };
const MARKER_MIN_PIXELS = 30;

// Counts marker-coloured pixels in a screenshot and returns their centroid.
async function measureMarker(page) {
  const shot = await page.screenshot({ type: "png" });
  return page.evaluate(
    async ({ b64, marker }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (
          Math.abs(data[i] - marker.r) < 10 &&
          Math.abs(data[i + 1] - marker.g) < 10 &&
          Math.abs(data[i + 2] - marker.b) < 10
        ) {
          const p = i / 4;
          n++;
          sx += p % canvas.width;
          sy += Math.floor(p / canvas.width);
        }
      }
      return { n, x: n ? Math.round(sx / n) : null, y: n ? Math.round(sy / n) : null };
    },
    { b64: shot.toString("base64"), marker: MARKER },
  );
}

function isCentered(m) {
  return (
    m.n >= MARKER_MIN_PIXELS &&
    Math.abs(m.x - CENTER.x) <= TOLERANCE_PX &&
    Math.abs(m.y - CENTER.y) <= TOLERANCE_PX
  );
}

async function openPage(browser, { geolocation, grant, slowTiles }) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: grant ? ["geolocation"] : [],
    geolocation: grant ? geolocation : undefined,
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (slowTiles) {
    // Tiles arrive late, so the map is still downloading when the button is tapped.
    await page.route("**/tile.openstreetmap.org/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 4000));
      await route.abort();
    });
  }
  await page.goto(url, { waitUntil: "load" });
  return { context, page, errors };
}

const scenarios = {
  // Tapping the button with an in-HK fix centres the map and draws the marker.
  "hk-fix": async (browser) => {
    const { context, page, errors } = await openPage(browser, { geolocation: HK, grant: true });
    await page.waitForTimeout(6000);
    const before = await measureMarker(page);
    await page.click(".locate");
    await page.waitForTimeout(2500);
    const after = await measureMarker(page);
    const state = await page.getAttribute(".locate", "data-state");
    await context.close();
    return {
      ok: isCentered(after) && state === "idle",
      detail: { before, after, state, errors },
    };
  },

  // Regression for the dropped fix: pan the map, then tap while tiles load.
  // The marker must move to the centre. Before the isStyleLoaded fix it stayed put.
  "pan-then-locate": async (browser) => {
    const { context, page, errors } = await openPage(browser, { geolocation: HK, grant: true });
    await page.waitForTimeout(6000);
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await context.setGeolocation(OTHER_HK);
    await page.click(".locate");
    await page.waitForTimeout(2500);
    const after = await measureMarker(page);
    const state = await page.getAttribute(".locate", "data-state");
    await context.close();
    return { ok: isCentered(after) && state === "idle", detail: { after, state, errors } };
  },

  // Same as pan-then-locate, with every tile request held for 4 seconds.
  "pan-then-locate-slow-tiles": async (browser) => {
    const { context, page, errors } = await openPage(browser, {
      geolocation: HK,
      grant: true,
      slowTiles: true,
    });
    await page.waitForTimeout(9000);
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await context.setGeolocation(OTHER_HK);
    await page.click(".locate");
    await page.waitForTimeout(2500);
    const after = await measureMarker(page);
    const state = await page.getAttribute(".locate", "data-state");
    await context.close();
    return { ok: isCentered(after) && state === "idle", detail: { after, state, errors } };
  },

  // A fix outside the Hong Kong box must not draw a dot; the map returns to HK.
  "outside-hk": async (browser) => {
    const { context, page, errors } = await openPage(browser, {
      geolocation: OUTSIDE_HK,
      grant: true,
    });
    await page.waitForTimeout(6000);
    await page.click(".locate");
    await page.waitForTimeout(2500);
    const after = await measureMarker(page);
    const state = await page.getAttribute(".locate", "data-state");
    await context.close();
    return { ok: after.n === 0 && state === "idle", detail: { after, state, errors } };
  },

  // With no permission, the button must show the error state after a manual tap.
  denied: async (browser) => {
    const { context, page, errors } = await openPage(browser, { grant: false });
    await page.waitForTimeout(3000);
    await page.click(".locate");
    await page.waitForTimeout(2000);
    const state = await page.getAttribute(".locate", "data-state");
    await context.close();
    return { ok: state === "error", detail: { state, errors } };
  },
};

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(scenarios);
const unknown = names.filter((name) => !(name in scenarios));
if (unknown.length) {
  console.error(`Unknown scenario(s): ${unknown.join(", ")}`);
  console.error(`Available: ${Object.keys(scenarios).join(", ")}`);
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
let failed = 0;
try {
  for (const name of names) {
    const result = await scenarios[name](browser);
    if (!result.ok) failed++;
    console.log(`${result.ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(result.detail)}`);
  }
} finally {
  await browser.close();
}
console.log(failed ? `${failed} of ${names.length} failed` : `all ${names.length} passed`);
process.exit(failed ? 1 : 0);
