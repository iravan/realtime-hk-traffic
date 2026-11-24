import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Realtime HK Traffic",
    short_name: "HK Traffic",
    description: "Live Hong Kong public transport map.",
    start_url: "/",
    display: "standalone",
    background_color: "#11254a",
    theme_color: "#11254a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}