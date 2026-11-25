// Build a destination -> pier link table from the bundled ferry stops.
//
// Each ferry stop lists the destinations it serves ("長洲 Cheung Chau"), but
// not the stop id of the pier those sailings arrive at. The pier names carry
// that information ("...長洲渡輪碼頭..."), so we match the destination label
// against every other pier name. When several piers match (Central has eight),
// a reciprocal match -- the candidate also lists this pier as a destination --
// breaks the tie. Ambiguous destinations are left out rather than guessed.
//
// Run after refreshing public/stops-ferry.json:
//   node scripts/build-ferry-links.mjs

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const stopsPath = fileURLToPath(new URL("public/stops-ferry.json", root));
const linksPath = fileURLToPath(new URL("app/ferry-links.json", root));

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
    const target =
      reciprocal.length === 1 ? reciprocal[0] : candidates.length === 1 ? candidates[0] : null;
    if (target) links[`${stop.id}|${destination}`] = target.id;
  }
}

const sorted = Object.fromEntries(
  Object.entries(links).sort(([a], [b]) => a.localeCompare(b)),
);
await writeFile(linksPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`wrote ${Object.keys(sorted).length} links to app/ferry-links.json`);
