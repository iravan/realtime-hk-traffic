import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const source = require.resolve("maplibre-gl/dist/maplibre-gl-worker.mjs");
const target = path.join(process.cwd(), "public/maplibre-gl-worker.mjs");

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
