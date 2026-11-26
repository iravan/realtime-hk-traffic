import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { I18nProvider } from "./i18n";
import "./globals.css";

const description =
  "Live Hong Kong public transport map. Next MTR train, KMB, LWB, Citybus and New Lantao Bus arrivals, green minibus, ferry departures, and taxi stands. 香港交通實時到站：港鐵下班車、九巴、龍運、城巴、新大嶼山巴士、綠色小巴、渡輪、的士站。";

const title = "Realtime HK Traffic 香港交通";
const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "https://realtime-hk-traffic.vercel.app";
const site = `${origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}`;
const imageAlt =
  "Realtime HK Traffic, a live map of Hong Kong MTR, buses, minibuses, ferries, and taxi stands. 香港交通實時到站地圖。";
const image = {
  url: `${site}/og.png`,
  secureUrl: `${site}/og.png`,
  type: "image/png",
  width: 1200,
  height: 630,
  alt: imageAlt,
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title: "Realtime HK Traffic",
  description,
  applicationName: "Realtime HK Traffic",
  alternates: { canonical: site },
  keywords: [
    "Hong Kong traffic",
    "Hong Kong public transport",
    "Hong Kong transport map",
    "realtime Hong Kong bus",
    "Hong Kong bus ETA",
    "bus arrival time",
    "MTR",
    "MTR next train",
    "next train Hong Kong",
    "KMB",
    "Kowloon Motor Bus",
    "LWB",
    "Long Win Bus",
    "Citybus",
    "New Lantao Bus",
    "NLB",
    "green minibus",
    "Hong Kong minibus",
    "Hong Kong ferry",
    "ferry timetable",
    "ferry departure",
    "Star Ferry",
    "Hong Kong taxi stand",
    "香港交通",
    "香港公共交通",
    "香港交通地圖",
    "實時交通",
    "實時巴士",
    "巴士到站時間",
    "巴士預計到達",
    "港鐵",
    "港鐵下班車",
    "九巴",
    "九巴到站",
    "龍運",
    "龍運巴士",
    "城巴",
    "城巴到站",
    "新大嶼山巴士",
    "綠色小巴",
    "專線小巴",
    "小巴到站",
    "渡輪",
    "渡輪時間表",
    "渡輪班次",
    "天星小輪",
    "的士站",
  ],
  openGraph: {
    title,
    description,
    locale: "zh_HK",
    alternateLocale: ["en_HK"],
    type: "website",
    siteName: "Realtime HK Traffic",
    url: site,
    images: [image],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [image],
  },
  appleWebApp: {
    capable: true,
    title: "香港交通",
    statusBarStyle: "black-translucent",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Realtime HK Traffic",
  alternateName: ["香港交通", "Realtime HK Traffic"],
  description,
  url: site,
  image: image.url,
  applicationCategory: "TravelApplication",
  operatingSystem: "Web",
  inLanguage: ["zh-Hant", "en"],
  offers: { "@type": "Offer", price: "0", priceCurrency: "HKD" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>
        <Analytics />
        <SpeedInsights />
        <meta itemProp="name" content={title} />
        <meta itemProp="description" content={description} />
        <meta itemProp="image" content={image.url} />
        <link rel="image_src" href={image.url} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
