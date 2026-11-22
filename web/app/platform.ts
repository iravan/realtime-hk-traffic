export type Platform = "ios" | "android" | "unknown";

export function detectPlatform(userAgent: string, touchPoints: number): Platform {
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  // iPadOS 13+ reports itself as a Macintosh; a real Mac has no touch screen.
  if (/Macintosh/.test(userAgent) && touchPoints > 1) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "unknown";
}

export function currentPlatform(): Platform {
  if (typeof navigator === "undefined") return "unknown";
  return detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
}
