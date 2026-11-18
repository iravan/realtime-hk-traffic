export type Mode = "mtr" | "bus" | "minibus" | "taxi";

const colors: Record<Mode, string> = {
  mtr: "#11254a",
  bus: "#e52029",
  minibus: "#2f7d4f",
  taxi: "#c8102e",
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

// The same SVG artwork the category tabs use, so a stop on the map shows the
// same vehicle as its tab. Loaded once before the first pin is drawn.
export async function loadVehicleImages(basePath: string): Promise<void> {
  const all: Mode[] = ["mtr", "bus", "minibus", "taxi"];
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
}

export function stopIconImage(mode: Mode): ImageData {
  const canvas = drawStopIcon(mode);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function stopIconUrl(mode: Mode): string {
  return drawStopIcon(mode).toDataURL();
}

export const stopIconPixelRatio = ratio;

// A dot stands in for the full sign when a view holds more stops than it can
// legibly show, and every out-of-hours stop is a dot even in a sparse view. The
// muted fill keeps the stop's place on the map without inviting a tap.
export function stopDotImage(mode: Mode, muted = false): ImageData {
  const size = 20;
  const canvas = document.createElement("canvas");
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 6, 0, Math.PI * 2);
  ctx.fillStyle = muted ? mutedFill : colors[mode];
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
export function stopIconHighlight(mode: Mode): ImageData {
  const pad = 5;
  const base = drawStopIcon(mode);
  const canvas = document.createElement("canvas");
  canvas.width = (width + pad * 2) * ratio;
  canvas.height = (height + pad) * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  // Paper first, then ink: the sign's own edge gains a dark rim and a light
  // gap that lifts it off the basemap.
  stampOutline(ctx, base, paper, pad, 4.2);
  stampOutline(ctx, base, ink, pad, 2.6);
  ctx.drawImage(base, pad, pad, width, height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// With dots standing in for signs there is nothing to outline, so the selected
// dot becomes a target: a paper halo, an ink ring and the mode colour inside.
export function stopDotHighlight(mode: Mode): ImageData {
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
  ctx.fillStyle = colors[mode];
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = paper;
  ctx.stroke();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function modeLabel(mode: Mode): string {
  if (mode === "mtr") return "MTR";
  if (mode === "bus") return "Bus";
  if (mode === "minibus") return "Minibus";
  return "Taxi";
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
  const steps = 20;
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    ctx.drawImage(
      stamp,
      pad + Math.cos(angle) * radius,
      pad + Math.sin(angle) * radius,
      width,
      height,
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

function drawStopIcon(mode: Mode): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  ctx.scale(ratio, ratio);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const color = colors[mode];
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

  const vehicle = vehicleImages[mode];
  if (vehicle) {
    ctx.drawImage(vehicle, 5, 2, 34, 34);
  } else if (mode === "mtr") {
    drawMtr(ctx, color);
  } else if (mode === "bus") {
    drawBus(ctx, color, line);
  } else if (mode === "minibus") {
    drawMinibus(ctx, color, line);
  } else {
    drawTaxi(ctx, color, line);
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

function drawTaxi(ctx: CanvasRenderingContext2D, color: string, line: string) {
  ctx.fillStyle = paper;
  roundRect(ctx, 16, 7.4, 12, 4.2, 1);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(18.2, 8.6, 7.6, 1.8);
  ctx.fillStyle = paper;
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
  ctx.fillStyle = color;
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
