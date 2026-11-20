import type { TaxiKind } from "./stop-icon";

export type TaxiLabel = { en: string; tc: string };

export type TaxiStandInfo = {
  kind: TaxiKind;
  type: TaxiLabel;
  hours: TaxiLabel | null;
};

// The first line of `Status_*` is the taxi type. Hours are either the following
// lines, or a parenthetical on that same line. No hours text means the stand
// has no restriction.
export function taxiStandInfo(statusEn: string, statusTc: string): TaxiStandInfo {
  const en = splitStatus(statusEn);
  const tc = splitStatus(statusTc);
  const typeEn = en.type;
  const typeTc = tc.type || typeEn;
  const hoursEn = en.hours;
  const hoursTc = tc.hours;
  return {
    kind: taxiKind(typeEn),
    type: { en: typeEn, tc: typeTc },
    hours: hoursEn || hoursTc ? { en: hoursEn || hoursTc, tc: hoursTc || hoursEn } : null,
  };
}

function splitStatus(status: string): { type: string; hours: string } {
  const parts = lines(status);
  let type = parts[0] ?? "";
  const extra = parts.slice(1);
  const cut = type.search(/[（(]/);
  let inline = "";
  if (cut > 0) {
    inline = type.slice(cut).trim();
    type = type.slice(0, cut).trim();
  }
  return { type, hours: [inline, ...extra].filter(Boolean).join("") };
}

function lines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function taxiKind(line: string): TaxiKind {
  if (line.startsWith("Both of Urban and NT") || line.startsWith("Urban and NT")) {
    return "urban-nt";
  }
  if (line.startsWith("Urban and Cross")) return "urban-cross";
  if (line.startsWith("Lantau")) return "lantau";
  if (line.startsWith("NT ")) return "nt";
  if (line.startsWith("Cross Harbour")) return "cross";
  return "urban";
}
