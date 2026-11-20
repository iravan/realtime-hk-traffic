import type { TaxiKind } from "./stop-icon";

export type TaxiLabel = { en: string; tc: string };

export type TaxiStandInfo = {
  kind: TaxiKind;
  type: TaxiLabel;
  hours: TaxiLabel | null;
};

// The first line of `Status_*` is the taxi type. Any further lines are the
// hours that stand is open. No further lines means the stand has no restriction.
export function taxiStandInfo(statusEn: string, statusTc: string): TaxiStandInfo {
  const en = lines(statusEn);
  const tc = lines(statusTc);
  const typeEn = en[0] ?? "";
  const typeTc = tc[0] ?? typeEn;
  const hoursEn = en.slice(1).join(" ");
  const hoursTc = tc.slice(1).join(" ");
  return {
    kind: taxiKind(typeEn),
    type: { en: typeEn, tc: typeTc },
    hours: hoursEn || hoursTc ? { en: hoursEn || hoursTc, tc: hoursTc || hoursEn } : null,
  };
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
