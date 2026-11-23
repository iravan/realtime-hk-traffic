import type { Locale } from "./i18n";
import type { Mode } from "./stop-icon";

// Names are stored as one bilingual string: "金鐘 Admiralty". The English half
// can itself contain " / ", as in "海麗邨／南昌站 Hoi Lai Estate / Nam Cheong
// Station". A " / " starts a second place only when that next piece has
// Chinese of its own, as in "羅湖 Lo Wu / 落馬洲 Lok Ma Chau".
const bilingual = /^(.*[\u3400-\u9fff][^\u3400-\u9fffA-Za-z]*?)\s+([A-Za-z].*)$/;

function bilingualParts(name: string): string[] {
  const parts: string[] = [];
  let rest = name.trim();
  while (rest) {
    const at = rest.indexOf(" / ");
    if (at === -1) {
      parts.push(rest);
      break;
    }
    const next = rest.slice(at + 3);
    if (/[\u3400-\u9fff]/.test(next.split(" / ")[0] ?? "")) {
      parts.push(rest.slice(0, at));
      rest = next.trim();
    } else {
      parts.push(rest);
      break;
    }
  }
  return parts;
}

export function localizeBilingualName(name: string, locale: Locale): string {
  return bilingualParts(name)
    .map((part) => {
      const match = bilingual.exec(part.trim());
      if (!match) return part.trim();
      return (locale === "en" ? match[2] : match[1]).trim();
    })
    .join(" / ");
}

export function localizeStopName(
  name: string,
  mode: Mode,
  locale: Locale,
  nameTc?: string | null,
  nameEn?: string | null,
): string {
  // Feeds that publish the Chinese and English names separately (bus, and the
  // Light Rail stops) use them directly, so a name with Latin letters in its
  // Chinese half ("太古廣場 (A1)") still splits cleanly.
  if (nameTc || nameEn) {
    return (locale === "en" ? nameEn : nameTc) || nameTc || nameEn || name;
  }
  // MTR, ferry and green-minibus catalogues store Chinese and English in one
  // string. Older bus catalogues do too, so they fall back to the same split.
  return mode === "mtr" || mode === "ferry" || mode === "minibus" || mode === "bus"
    ? localizeBilingualName(name, locale)
    : name;
}
