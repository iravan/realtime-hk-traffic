// Build a destination -> pier link table from the bundled ferry stops.
//
// Each ferry stop lists the destinations it serves ("長洲 Cheung Chau"), but
// not the stop id of the pier those sailings arrive at. The pier names carry
// that information ("...長洲渡輪碼頭..."), so we match the destination label
// against every other pier name. When several piers match (Central has eight),
// a reciprocal match -- the candidate also lists this pier as a destination --
// breaks the tie, preferring the main ferry pier over landing steps. Destinations
// that are still ambiguous are left out rather than guessed.
//
// Run after refreshing public/stops-ferry.json:
//   node scripts/build-ferry-links.mjs

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const stopsPath = fileURLToPath(new URL("public/stops-ferry.json", root));
const appLinksPath = fileURLToPath(new URL("app/ferry-links.json", root));
const publicLinksPath = fileURLToPath(new URL("public/ferry-links.json", root));

const stops = JSON.parse(await readFile(stopsPath, "utf8")).stops ?? [];

function labelParts(label) {
  const match = label.match(/^([^\sA-Za-z].*?)\s+([A-Za-z].*)$/);
  if (!match) return [label, label];
  return [match[1].trim(), match[2].trim()];
}

function matchesName(name, label) {
  const [tc, en] = labelParts(label);
  return (tc.length > 0 && name.includes(tc)) || (en.length > 0 && name.toLowerCase().includes(en.toLowerCase()));
}

const links = {};
for (const stop of stops) {
  for (const destination of stop.destinations ?? []) {
    const candidates = stops.filter(
      (other) => other.id !== stop.id && matchesName(other.name, destination),
    );
    const reciprocal = candidates.filter((other) =>
      (other.destinations ?? []).some((label) => matchesName(stop.name, label)),
    );
    // When several piers serve the route, prefer the main ferry pier over
    // landing steps and public piers, then keep the catalogue order so the
    // result is stable.
    reciprocal.sort((a, b) => pierRank(b) - pierRank(a));
    const target =
      reciprocal.length > 0 ? reciprocal[0] : candidates.length === 1 ? candidates[0] : null;
    if (target) links[`${stop.id}|${destination}`] = target.id;
  }
}

function pierRank(stop) {
  if (stop.name.includes("渡輪碼頭")) return 2;
  if (stop.name.includes("碼頭")) return 1;
  return 0;
}

const sorted = Object.fromEntries(
  Object.entries(links).sort(([a], [b]) => a.localeCompare(b)),
);
await writeFile(appLinksPath, `${JSON.stringify(sorted, null, 2)}\n`);
await writeFile(publicLinksPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`wrote ${Object.keys(sorted).length} links to app/ferry-links.json and public/ferry-links.json`);
