import { readFile, writeFile } from "node:fs/promises";

const modes = ["mtr", "bus", "minibus", "taxi"];
const source = JSON.parse(
  await readFile(new URL("../public/stops.json", import.meta.url), "utf8"),
);

for (const mode of modes) {
  const stops = source.stops.filter((stop) => stop.mode === mode);
  await writeFile(
    new URL(`../public/stops-${mode}.json`, import.meta.url),
    JSON.stringify({ stops }) + "\n",
  );
  console.log(`stops-${mode}.json: ${stops.length}`);
}
