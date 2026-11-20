import { readFile, writeFile } from "node:fs/promises";

const modes = ["mtr", "bus", "minibus", "ferry", "taxi"];
const sourceUrl = new URL("../../server/data/stops.json", import.meta.url);
const sourceText = await readFile(sourceUrl, "utf8");
const source = JSON.parse(sourceText);

// Keep a generated copy in public for static hosts and for code that still
// expects the full catalogue. The canonical file is the server one.
await writeFile(
  new URL("../public/stops.json", import.meta.url),
  sourceText,
);

for (const mode of modes) {
  const stops = source.stops.filter((stop) => stop.mode === mode);
  await writeFile(
    new URL(`../public/stops-${mode}.json`, import.meta.url),
    JSON.stringify({ stops }) + "\n",
  );
  console.log(`stops-${mode}.json: ${stops.length}`);
}
