export type Mode = "mtr" | "bus" | "minibus" | "taxi";

const colors: Record<Mode, string> = {
  mtr: "#c44736",
  bus: "#2f6f4e",
  minibus: "#c4841d",
  taxi: "#3d4c8f",
};

const width = 44;
const height = 64;
const ratio = 2;
const paper = "#fbf7f0";
const ink = "#241f1a";

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
  const cx = width / 2;
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

  const sx = 3;
  const sy = 2;
  const sw = 38;
  const sh = 34;
  roundRect(ctx, sx, sy, sw, sh, 8);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = paper;
  ctx.stroke();

  if (mode === "mtr") drawMtr(ctx, color);
  if (mode === "bus") drawBus(ctx, color);
  if (mode === "minibus") drawMinibus(ctx, color);
  if (mode === "taxi") drawTaxi(ctx, color);
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

function drawBus(ctx: CanvasRenderingContext2D, color: string) {
  ctx.fillStyle = paper;
  roundRect(ctx, 8, 10, 28, 14, 2.5);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(10.5, 12.4, 5.2, 4.4);
  ctx.fillRect(17.2, 12.4, 5.2, 4.4);
  ctx.fillRect(23.8, 12.4, 5.2, 4.4);
  wheels(ctx, 14, 30, 24.6);
}

function drawMinibus(ctx: CanvasRenderingContext2D, color: string) {
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
  wheels(ctx, 16.5, 28, 25.2);
}

function drawTaxi(ctx: CanvasRenderingContext2D, color: string) {
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
  wheels(ctx, 14, 30, 26.2);
}

function wheels(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number) {
  ctx.fillStyle = ink;
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
