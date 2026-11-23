import { TAXI_COLORS } from "./taxi-colors";

export type Mode = "mtr" | "bus" | "minibus" | "ferry" | "taxi";

export const modeColor: Record<Mode, string> = {
  mtr: "#11254a",
  bus: "#e52029",
  minibus: "#2f7d4f",
  ferry: "#047857",
  taxi: TAXI_COLORS.urban.primary,
};

// Out-of-hours stops are drawn as a muted dot: the map still shows where the
// stop is without inviting a tap.
const mutedFill = "#b3aea4";

const width = 44;
const height = 64;
const ratio = 2;
const paper = "#fbf7f0";
const ink = "#241f1a";

const vehicleImages: Partial<Record<Mode, HTMLImageElement>> = {};
let ferryBoatImage: HTMLImageElement | undefined;
let citybusImage: HTMLImageElement | undefined;
let lightRailCanvas: HTMLCanvasElement | undefined;

// Star Ferry piers keep the green mark. Every other pier uses the plain boat.
const starFerryIds = new Set(["ferry:101119", "ferry:101339", "ferry:101118"]);

export function isStarFerry(id: string): boolean {
  return starFerryIds.has(id);
}

// Citybus stops use the yellow double-decker. KMB and the other franchises
// keep the red bus.
export function isCitybus(id: string): boolean {
  return id.startsWith("bus:ctb:");
}

export function isLightRail(id: string): boolean {
  return id.startsWith("mtr:LRT:");
}

export type TaxiKind = "urban" | "nt" | "lantau" | "cross" | "urban-nt" | "urban-cross";

export const taxiKindColor: Record<TaxiKind, string> = {
  urban: TAXI_COLORS.urban.primary,
  nt: TAXI_COLORS.nt.primary,
  lantau: TAXI_COLORS.lantau.primary,
  cross: TAXI_COLORS.crossHarbour.primary,
  "urban-nt": TAXI_COLORS.urban.primary,
  "urban-cross": TAXI_COLORS.crossHarbour.primary,
};

export const taxiKinds = Object.keys(taxiKindColor) as TaxiKind[];

const taxiBitmaps: Partial<Record<TaxiKind, HTMLCanvasElement>> = {};

// The category tabs and the map signs share this artwork, except the ferry
// tab, which keeps the Star Ferry mark while other piers use the plain boat,
// and Citybus stops, which use the yellow double-decker.
// Loaded once before the first pin is drawn.
let vehicleLoad: Promise<void> | null = null;

export function loadVehicleImages(basePath: string): Promise<void> {
  vehicleLoad ??= loadVehicleImagesOnce(basePath);
  return vehicleLoad;
}

async function loadVehicleImagesOnce(basePath: string): Promise<void> {
  const all: Mode[] = ["mtr", "bus", "minibus", "ferry", "taxi"];
  await Promise.all(
    all.map(async (mode) => {
      try {
        const image = new Image();
        image.decoding = "async";
        image.src = `${basePath}/icons/${mode}.svg`;
        await image.decode();
        vehicleImages[mode] = image;
      } catch {
        // Missing SVG: drawStopIcon falls back to the canvas vehicle.
      }
    }),
  );
  try {
    const boat = new Image();
    boat.decoding = "async";
    boat.src = `${basePath}/icons/ferry-boat.svg`;
    await boat.decode();
    ferryBoatImage = boat;
  } catch {
    // The canvas ferry stands in for a missing boat file.
  }
  try {
    const citybus = new Image();
    citybus.decoding = "async";
    citybus.src = `${basePath}/icons/citybus.svg`;
    await citybus.decode();
    citybusImage = citybus;
  } catch {
    // The canvas bus stands in for a missing Citybus file.
  }
  try {
    const response = await fetch(`${basePath}/icons/light-rail.svg`);
    if (response.ok) {
      lightRailCanvas = await rasterizeSvg(await response.text(), 68);
    }
  } catch {
    // Light Rail falls back to the MTR block.
  }
}

// Each kind is its own SVG. Rasterise it larger than the sign so the map
// scales the artwork down. Painting over a 24px bitmap is what made it soft.
const taxiFiles: TaxiKind[] = ["urban", "nt", "lantau", "cross"];

const taxiPairs: Partial<Record<TaxiKind, [TaxiKind, TaxiKind]>> = {
  "urban-nt": ["urban", "nt"],
  "urban-cross": ["urban", "cross"],
};

let taxiKindLoad: Promise<void> | null = null;

export function loadTaxiKindImages(basePath: string): Promise<void> {
  taxiKindLoad ??= loadTaxiKindImagesOnce(basePath);
  return taxiKindLoad;
}

async function loadTaxiKindImagesOnce(basePath: string): Promise<void> {
  await Promise.all(
    taxiFiles.map(async (kind) => {
      try {
        const response = await fetch(`${basePath}/icons/taxi-${kind}.svg`);
        if (!response.ok) return;
        taxiBitmaps[kind] = await rasterizeSvg(await response.text(), 192);
      } catch {
        // taxiIconImage falls back to the canvas taxi in that kind's colour.
      }
    }),
  );
}

function rasterizeSvg(svg: string, size: number): Promise<HTMLCanvasElement> {
  const sized = svg
    .replace(/width="\d+"/, `width="${size}"`)
    .replace(/height="\d+"/, `height="${size}"`);
  const image = new Image();
  const ready = new Promise<HTMLCanvasElement>((resolve, reject) => {
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas"));
        return;
      }
      ctx.drawImage(image, 0, 0, size, size);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("svg"));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  return ready;
}

function taxiSign(kind: TaxiKind): HTMLCanvasElement {
  const pair = taxiPairs[kind];
  if (pair) return drawTaxiPair(pair[0], pair[1]);
  const bitmap = taxiBitmaps[kind];
  return bitmap
    ? drawStopIcon("taxi", bitmap)
    : drawStopIcon("taxi", undefined, taxiKindColor[kind]);
}

export function taxiIconImage(kind: TaxiKind): ImageData {
  return imageData(taxiSign(kind));
}

export function taxiSignHighlight(kind: TaxiKind): ImageData {
  return outlineImage(taxiSign(kind), false);
}

function drawTaxiPair(left: TaxiKind, right: TaxiKind): HTMLCanvasElement {
  const boxWidth = 58;
  const canvas = document.createElement("canvas");
  canvas.width = boxWidth * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const cx = boxWidth / 2;
  ctx.beginPath();
  ctx.moveTo(cx, 38);
  ctx.lineTo(cx, height - 2);
  ctx.strokeStyle = paper;
  ctx.lineWidth = 4.4;
  ctx.stroke();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.ellipse(cx, height - 1.8, 3.6, 1.4, 0, 0, Math.PI * 2);
  ctx.fill();
  roundRect(ctx, 2, 2, boxWidth - 4, 34, 8);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ink;
  ctx.stroke();
  const icon = 22;
  const gap = 2;
  const x = (boxWidth - icon * 2 - gap) / 2;
  drawTaxiBitmap(ctx, left, x, 7, icon);
  drawTaxiBitmap(ctx, right, x + icon + gap, 7, icon);
  return canvas;
}

function drawTaxiBitmap(
  ctx: CanvasRenderingContext2D,
  kind: TaxiKind,
  x: number,
  y: number,
  size: number,
) {
  const bitmap = taxiBitmaps[kind];
  if (!bitmap) return;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, x, y, size, size);
}

export function taxiDotImage(kind: TaxiKind): ImageData {
  const pair = taxiPairs[kind];
  if (pair) return imageData(drawTaxiPairDot(pair[0], pair[1]));
  const size = 20;
  const canvas = document.createElement("canvas");
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  const centre = size / 2;
  const radius = 6;
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.fillStyle = taxiKindColor[kind];
  ctx.fill();
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = paper;
  ctx.stroke();
  return imageData(canvas);
}

function drawTaxiPairDot(left: TaxiKind, right: TaxiKind): HTMLCanvasElement {
  const size = 28;
  const canvas = document.createElement("canvas");
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  roundRect(ctx, 1, 5, size - 2, 18, 4);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = ink;
  ctx.stroke();
  drawTaxiBitmap(ctx, left, 2, 6, 12);
  drawTaxiBitmap(ctx, right, 14, 6, 12);
  return canvas;
}

export function stopIconImage(mode: Mode): ImageData {
  return imageData(drawStopIcon(mode));
}

function imageData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function stopIconUrl(mode: Mode): string {
  return drawStopIcon(mode).toDataURL();
}

const ferryBoatFill = "#0c6e8a";

export function ferryBoatIconImage(): ImageData {
  return imageData(drawStopIcon("ferry", ferryBoatImage, ferryBoatFill));
}

export function ferryBoatIconUrl(): string {
  return drawStopIcon("ferry", ferryBoatImage, ferryBoatFill).toDataURL();
}

const citybusFill = "#FACC15";

export function citybusIconImage(): ImageData {
  return imageData(drawStopIcon("bus", citybusImage, citybusFill));
}

export function citybusIconUrl(): string {
  return drawStopIcon("bus", citybusImage, citybusFill).toDataURL();
}

export function lightRailIconImage(): ImageData {
  if (lightRailCanvas) return imageData(lightRailCanvas);
  return stopIconImage("mtr");
}

export function lightRailIconUrl(): string {
  if (lightRailCanvas) return lightRailCanvas.toDataURL();
  return stopIconUrl("mtr");
}

export function citybusSignHighlight(): ImageData {
  return stopIconHighlight("bus", citybusImage, citybusFill);
}

export function ferryBoatSignHighlight(): ImageData {
  return stopIconHighlight("ferry", ferryBoatImage, ferryBoatFill);
}

export const stopIconPixelRatio = ratio;

// A dot stands in for the full sign when a view holds more stops than it can
// legibly show, and every out-of-hours stop is a dot even in a sparse view. The
// muted fill keeps the stop's place on the map without inviting a tap.
export function stopDotImage(mode: Mode, muted = false, fill?: string): ImageData {
  const size = 20;
  const canvas = document.createElement("canvas");
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 6, 0, Math.PI * 2);
  ctx.fillStyle = muted ? mutedFill : (fill ?? modeColor[mode]);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = paper;
  ctx.stroke();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// A selected sign keeps the whole icon readable: the same artwork, stamped
// around with a paper and ink outline so the sign itself stands out instead of
// a separate marker sitting under it. The canvas is padded on the top and sides
// only, so the point of the pole still lands on the stop when anchored bottom.
export function stopIconHighlight(mode: Mode, vehicle?: CanvasImageSource, fill?: string): ImageData {
  const pad = 5;
  const base = drawStopIcon(mode, vehicle, fill);
  const baseWidth = base.width / ratio;
  const baseHeight = base.height / ratio;
  // A square MTR block is centred on the station, so it needs padding on all
  // four sides. The other modes keep the pole tip on the station point.
  const bottomPad = mode === "mtr" ? pad : 0;
  const canvas = document.createElement("canvas");
  canvas.width = (baseWidth + pad * 2) * ratio;
  canvas.height = (baseHeight + pad + bottomPad) * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  // Paper first, then ink: the sign's own edge gains a dark rim and a light
  // gap that lifts it off the basemap.
  stampOutline(ctx, base, paper, pad, 4.2);
  stampOutline(ctx, base, ink, pad, 2.6);
  ctx.drawImage(base, pad, pad, baseWidth, baseHeight);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// With dots standing in for signs there is nothing to outline, so the selected
// dot becomes a target: a paper halo, an ink ring and the mode colour inside.
export function stopDotHighlight(mode: Mode, fill?: string): ImageData {
  const size = 28;
  const canvas = document.createElement("canvas");
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  const centre = size / 2;
  for (const [radius, colour] of [
    [11.5, paper],
    [9, ink],
    [7.4, paper],
  ] as const) {
    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(centre, centre, 6, 0, Math.PI * 2);
  ctx.fillStyle = fill ?? modeColor[mode];
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = paper;
  ctx.stroke();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function taxiDotHighlight(kind: TaxiKind): ImageData {
  const pair = taxiPairs[kind];
  if (pair) return outlineImage(drawTaxiPairDot(pair[0], pair[1]), true);
  const size = 28;
  const canvas = document.createElement("canvas");
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  const centre = size / 2;
  for (const [radius, colour] of [
    [11.5, paper],
    [9, ink],
    [7.4, paper],
  ] as const) {
    ctx.beginPath();
    ctx.arc(centre, centre, radius, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(centre, centre, 6, 0, Math.PI * 2);
  ctx.fillStyle = taxiKindColor[kind];
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = paper;
  ctx.stroke();
  return imageData(canvas);
}

function outlineImage(base: HTMLCanvasElement, padBottom: boolean): ImageData {
  const pad = 5;
  const bottom = padBottom ? pad : 0;
  const baseWidth = base.width / ratio;
  const baseHeight = base.height / ratio;
  const canvas = document.createElement("canvas");
  canvas.width = (baseWidth + pad * 2) * ratio;
  canvas.height = (baseHeight + pad + bottom) * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  stampOutline(ctx, base, paper, pad, 4.2);
  stampOutline(ctx, base, ink, pad, 2.6);
  ctx.drawImage(base, pad, pad, baseWidth, baseHeight);
  return imageData(canvas);
}


// Stamping a flat fill of the icon's alpha around it builds a crisp outline
// that follows every part of the artwork, including the pole and the vehicle.
function stampOutline(
  ctx: CanvasRenderingContext2D,
  base: HTMLCanvasElement,
  color: string,
  pad: number,
  radius: number,
) {
  const stamp = silhouette(base, color);
  const stampWidth = base.width / ratio;
  const stampHeight = base.height / ratio;
  const steps = 20;
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    ctx.drawImage(
      stamp,
      pad + Math.cos(angle) * radius,
      pad + Math.sin(angle) * radius,
      stampWidth,
      stampHeight,
    );
  }
}

function silhouette(source: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

function drawStopIcon(
  mode: Mode,
  vehicle?: CanvasImageSource,
  taxiColor?: string,
): HTMLCanvasElement {
  if (mode === "mtr") return drawMtrBlock();

  const canvas = document.createElement("canvas");
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const color = taxiColor ?? modeColor[mode];
  const line = ink;
  const cx = width / 2;
  ctx.beginPath();
  ctx.moveTo(cx, 38);
  ctx.lineTo(cx, height - 2);
  ctx.strokeStyle = paper;
  ctx.lineWidth = 4.4;
  ctx.stroke();
  ctx.strokeStyle = line;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.fillStyle = line;
  ctx.beginPath();
  ctx.ellipse(cx, height - 1.8, 3.6, 1.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const sx = 3;
  const sy = 2;
  const sw = 38;
  const sh = 34;
  // A neutral card behind the full-colour SVG, so the map vehicle reads
  // exactly like the tab icon instead of a second hand-drawn glyph.
  roundRect(ctx, sx, sy, sw, sh, 8);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = line;
  ctx.stroke();

  const artwork = vehicle ?? (taxiColor ? undefined : vehicleImages[mode]);
  if (artwork) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(artwork, 5, 2, 34, 34);
  } else if (mode === "bus") {
    drawBus(ctx, color, line);
  } else if (mode === "minibus") {
    drawMinibus(ctx, color, line);
  } else if (mode === "ferry") {
    drawFerry(ctx, color, line);
  } else {
    drawTaxi(ctx, color, line);
  }
  return canvas;
}

// MTR stations are square blocks rather than hanging signs: the block is the
// station, and a square hit area is much easier to tap than a tall pole.
function drawMtrBlock(): HTMLCanvasElement {
  const size = width;
  const canvas = document.createElement("canvas");
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  roundRect(ctx, 2, 2, size - 4, size - 4, 3);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = ink;
  ctx.stroke();

  // A navy band makes the block read as MTR at a glance, while the vehicle
  // artwork stays the same as the tab icon.
  ctx.save();
  roundRect(ctx, 2, 2, size - 4, size - 4, 3);
  ctx.clip();
  ctx.fillStyle = modeColor.mtr;
  ctx.fillRect(2, 2, size - 4, 10);
  ctx.restore();

  const vehicle = vehicleImages.mtr;
  if (vehicle) {
    ctx.drawImage(vehicle, 7, 12, 30, 30);
  } else {
    drawMtr(ctx, modeColor.mtr);
  }
  return canvas;
}

function drawMtr(ctx: CanvasRenderingContext2D, color: string) {
  ctx.fillStyle = paper;
  roundRect(ctx, 8, 8, 28, 12, 2.5);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(11, 10.2, 5, 4.2);
  ctx.fillRect(17.5, 10.2, 5, 4.2);
  ctx.fillRect(24, 10.2, 5, 4.2);
  ctx.strokeStyle = paper;
  ctx.lineCap = "butt";
  ctx.lineWidth = 1.7;
  ctx.beginPath();
  for (const x of [11, 17, 23, 29, 35]) {
    ctx.moveTo(x, 23.2);
    ctx.lineTo(x, 30.4);
  }
  ctx.stroke();
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(8, 25);
  ctx.lineTo(36, 25);
  ctx.moveTo(8, 28.6);
  ctx.lineTo(36, 28.6);
  ctx.stroke();
}

function drawBus(ctx: CanvasRenderingContext2D, color: string, line: string) {
  ctx.fillStyle = paper;
  roundRect(ctx, 8, 10, 28, 14, 2.5);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(10.5, 12.4, 5.2, 4.4);
  ctx.fillRect(17.2, 12.4, 5.2, 4.4);
  ctx.fillRect(23.8, 12.4, 5.2, 4.4);
  wheels(ctx, 14, 30, 24.6, line);
}

function drawMinibus(ctx: CanvasRenderingContext2D, color: string, line: string) {
  ctx.fillStyle = paper;
  ctx.beginPath();
  ctx.moveTo(11, 25);
  ctx.lineTo(11, 14);
  ctx.lineTo(14, 9);
  ctx.lineTo(24, 9);
  ctx.lineTo(33, 16);
  ctx.lineTo(33, 25);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, 14.2, 12.2, 7.2, 5.2, 1);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(23.2, 12);
  ctx.lineTo(29.4, 16.6);
  ctx.lineTo(23.2, 16.6);
  ctx.closePath();
  ctx.fill();
  wheels(ctx, 16.5, 28, 25.2, line);
}

function drawFerry(ctx: CanvasRenderingContext2D, color: string, line: string) {
  ctx.fillStyle = paper;
  roundRect(ctx, 10, 12, 22, 10, 1.5);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(12.2, 14, 4, 3.2);
  ctx.fillRect(17.4, 14, 4, 3.2);
  ctx.fillRect(22.6, 14, 4, 3.2);
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(8, 24);
  ctx.lineTo(36, 24);
  ctx.lineTo(32, 29);
  ctx.lineTo(12, 29);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.stroke();
}

function drawTaxi(ctx: CanvasRenderingContext2D, color: string, line: string) {
  ctx.fillStyle = paper;
  roundRect(ctx, 16, 7.4, 12, 4.2, 1);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(18.2, 8.6, 7.6, 1.8);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(8, 26);
  ctx.lineTo(8, 19);
  ctx.lineTo(14, 19);
  ctx.lineTo(17, 13);
  ctx.lineTo(27, 13);
  ctx.lineTo(30, 19);
  ctx.lineTo(36, 19);
  ctx.lineTo(36, 26);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = line;
  ctx.beginPath();
  ctx.moveTo(17.4, 14.2);
  ctx.lineTo(15.4, 18.2);
  ctx.lineTo(21.6, 18.2);
  ctx.lineTo(21.6, 14.2);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(22.6, 14.2);
  ctx.lineTo(22.6, 18.2);
  ctx.lineTo(28.6, 18.2);
  ctx.lineTo(26.4, 14.2);
  ctx.closePath();
  ctx.fill();
  wheels(ctx, 14, 30, 26.2, line);
}

function wheels(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, line: string) {
  ctx.fillStyle = line;
  ctx.beginPath();
  ctx.arc(x1, y, 2.05, 0, Math.PI * 2);
  ctx.arc(x2, y, 2.05, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
