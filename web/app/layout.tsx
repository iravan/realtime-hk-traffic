import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Realtime HK Traffic",
  description: "Live arrivals at Hong Kong public transport stops.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
