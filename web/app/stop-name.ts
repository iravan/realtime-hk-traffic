import type { Locale } from "./i18n";
import type { Mode } from "./stop-icon";

// Stop names are stored as one bilingual string: "金鐘 Admiralty". MTR station
// names are always Chinese followed by English, so the requested locale can
// pick one half without needing a second field in the catalogue.
const bilingual = /^(.+?[\u3400-\u9fff][^\u3400-\u9fff]*?)\s+([A-Za-z].*)$/;

// A line endpoint can name two terminals, e.g. "羅湖 Lo Wu / 落馬洲 Lok Ma Chau".
export function localizeBilingualName(name: string, locale: Locale): string {
  return name
    .split(" / ")
    .map((part) => {
      const trimmed = part.trim();
      const match = bilingual.exec(trimmed);
      if (!match) return trimmed;
      return (locale === "en" ? match[2] : match[1]).trim();
    })
    .join(" / ");
}

export function localizeStopName(name: string, mode: Mode, locale: Locale): string {
  // MTR and ferry catalogues store Chinese and English in one string. Other
  // modes' feeds do not always include a usable English half, so they stay as
  // published.
  return mode === "mtr" || mode === "ferry" ? localizeBilingualName(name, locale) : name;
}
