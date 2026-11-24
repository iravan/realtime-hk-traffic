"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n, type Locale, type Messages } from "./i18n";
import { mtrDestinationColor, mtrStationColor, type StationColor } from "./mtr-station-color";
import { ferryDestinationColor } from "./ferry-destination-color";
import { loadTaxiKindImages, loadVehicleImages, citybusIconUrl, ferryBoatIconUrl, isCitybus, isLantauBus, isLightRail, isStarFerry, lantauBusIconUrl, lightRailIconUrl, stopIconUrl, type Mode, type TaxiKind } from "./stop-icon";
import { loadCachedJson } from "./catalogue-cache";
import { stopPath } from "./stop-link";
import { localizeBilingualName, localizeStopName } from "./stop-name";
import type { TaxiLabel } from "./taxi-stand";
// public holidays loaded in FerryTimetable via fetch

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
// On Vercel the API is same-origin behind the /api rewrite. A static host such
// as GitHub Pages has no API, so it must name one, or the sheet stays name-only.
// `next dev` has no rewrite either, so a local run talks to the Rust server
// directly unless NEXT_PUBLIC_API_BASE names another host.
const apiBase =
  process.env.NEXT_PUBLIC_API_BASE ||
  (basePath
    ? ""
    : process.env.NODE_ENV === "development"
      ? "http://127.0.0.1:8787"
      : "/api");
const goneAfterMs = 12000;

const MTR_LINE_COLOR: Record<string, string> = {
  AEL: "#00888a",
  DRL: "#f173ac",
  EAL: "#53b7e8",
  ISL: "#007dc5",
  KTL: "#00ab4e",
  SIL: "#B6BD00",
  TCL: "#f7943e",
  TKL: "#7d499d",
  TML: "#923011",
  TWL: "#ed1d24",
  "505": "#e2231a",
  "507": "#00ab4e",
  "610": "#007dc5",
  "614": "#f7943e",
  "614P": "#f7943e",
  "705": "#7d499d",
  "706": "#923011",
  "751": "#00888a",
  "761P": "#B6BD00",
};

const MTR_LINE_NAME: Record<string, { zh: string; en: string }> = {
  AEL: { zh: "機場快綫", en: "Airport Express" },
  DRL: { zh: "迪士尼綫", en: "Disneyland Resort Line" },
  EAL: { zh: "東鐵綫", en: "East Rail Line" },
  ISL: { zh: "港島綫", en: "Island Line" },
  KTL: { zh: "觀塘綫", en: "Kwun Tong Line" },
  SIL: { zh: "南港島綫", en: "South Island Line" },
  TCL: { zh: "東涌綫", en: "Tung Chung Line" },
  TKL: { zh: "將軍澳綫", en: "Tseung Kwan O Line" },
  TML: { zh: "屯馬綫", en: "Tuen Ma Line" },
  TWL: { zh: "荃灣綫", en: "Tsuen Wan Line" },
};

type Row = {
  route: string;
  destination: string;
  minutes?: number;
  time?: string;
  not_departed?: boolean;
  operator?: string;
};

type Snapshot = {
  fetched_at: string;
  live: boolean;
  status?: string;
  note?: string;
  rows: Row[];
};

type State = "loading" | "waiting" | "gone" | "error";

type TimetableSession = { time: string; remark: string; operator: string };

type TimetableBand = { from: string; to: string; frequency: string; operator: string };

type TimetableDay = { day: string; sessions: TimetableSession[]; bands: TimetableBand[] };

export type TimetableDestination = { destination: string; days: TimetableDay[] };

// The day groups server/scripts/ferry_timetables.py files every sailing under.
const FERRY_WEEKDAYS = "Mondays to Fridays except public holidays";
const FERRY_SATURDAY = "Saturdays except public holidays";
const FERRY_SUNDAY = "Sundays and public holidays";
const FERRY_DAILY = "Daily";
const FERRY_SCHOOL_DAYS = "Mondays to Fridays (school days only)";

type Layout = {
  pdf_url: string;
  pdf_url_zh: string;
};

type StationToilet = {
  location: string;
  location_zh: string;
  paid_area: boolean;
};

type WaterDispenser = {
  lines: string[];
  location: string;
  location_zh: string;
  paid_area: boolean;
};

type Babycare = {
  location: string;
  location_zh: string;
  paid_area: boolean;
};

type Facility = {
  station_code: string;
  station_name: string;
  station_name_zh: string;
  layout?: Layout;
  toilet?: StationToilet;
  water_dispenser?: WaterDispenser;
  babycare?: Babycare;
};

export function StopSheet({
  id,
  mode,
  name,
  nameTc,
  nameEn,
  routes,
  latitude,
  longitude,
  taxi,
  taxiType,
  taxiHours,
  destinations,
  timetable: ferryTimetable,
  serviceHours,
  bookmarked,
  onToggleBookmark,
  onClose,
}: {
  id: string;
  mode: Mode;
  name: string;
  nameTc?: string;
  nameEn?: string;
  routes?: string[];
  latitude: number;
  longitude: number;
  taxi?: TaxiKind;
  taxiType?: TaxiLabel;
  taxiHours?: TaxiLabel | null;
  destinations?: string[];
  timetable?: TimetableDestination[];
  serviceHours?: string | null;
  bookmarked: boolean;
  onToggleBookmark: () => void;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [sign, setSign] = useState<string | null>(null);
  const [facility, setFacility] = useState<Facility | null>(null);
  useEffect(() => {
    if (mode !== "mtr") {
      setFacility(null);
      return;
    }
    let cancelled = false;
    setFacility(null);
    const code = id.startsWith("mtr:") ? id.slice(4) : "";
    loadCachedJson<Facility[]>("facilities-v3", async () => {
      const response = await fetch(`${basePath}/facilities.json`);
      if (!response.ok) throw new Error("facilities");
      return response.json() as Promise<Facility[]>;
    })
      .then((body) => {
        if (!cancelled) setFacility(body.find((entry) => entry.station_code === code) ?? null);
      })
      .catch(() => {
        // A missing catalogue only hides the facility icons.
      });
    return () => {
      cancelled = true;
    };
  }, [id, mode]);
  const layout = facility?.layout ?? null;
  const toilet = facility?.toilet ?? null;
  const water = facility?.water_dispenser ?? null;
  const babycare = facility?.babycare ?? null;
  useEffect(() => {
    if (mode === "taxi" && taxi) return;
    let cancelled = false;
    // A deep link opens the sheet before the SVG artwork has loaded. Drawing
    // then keeps the plain fallback instead of the full sign.
    void Promise.all([loadVehicleImages(basePath), loadTaxiKindImages(basePath)]).then(() => {
      if (!cancelled) {
        setSign(
          mode === "mtr" && isLightRail(id)
             ? lightRailIconUrl()
             : mode === "ferry" && !isStarFerry(id)
               ? ferryBoatIconUrl()
               : mode === "bus" && isCitybus(id)
                 ? citybusIconUrl()
                 : mode === "bus" && isLantauBus(id)
                   ? lantauBusIconUrl()
                   : stopIconUrl(mode),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, mode, taxi]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  snapshotRef.current = snapshot;
  const [state, setState] = useState<State>("loading");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!apiBase || mode === "taxi") return;
    let cancelled = false;
    setSnapshot(null);
    setState("loading");
    const loadSnapshot = () => {
      if (cancelled) return;
      fetch(`${apiBase}/stops/${encodeURIComponent(id)}/arrivals`)
        .then((response) => {
          if (cancelled) return null;
          if (response.status === 202 || response.status === 404) {
            // Server is preparing the snapshot; retry shortly.
            setState("waiting");
            setTimeout(loadSnapshot, 2000);
            return null;
          }
          if (!response.ok) {
            setState("error");
            return null;
          }
          return response.json() as Promise<Snapshot>;
        })
        .then((body) => {
          if (!cancelled && body) {
            setSnapshot(body);
            setState("loading");
          }
        })
        .catch(() => {
          if (!cancelled) setState("error");
        });
    };
    loadSnapshot();
    return () => {
      cancelled = true;
    };
  }, [id, mode]);

  useEffect(() => {
    if (!apiBase || mode === "taxi") return;
    const poll = () => {
      fetch(`${apiBase}/stops/${encodeURIComponent(id)}/arrivals`)
        .then((response) => {
          if (response.status === 202 || response.status === 404) {
            setTimeout(poll, 2000);
            return null;
          }
          return response.ok ? response.json() : null;
        })
        .then((body) => {
          if (body) setSnapshot(body as Snapshot);
        })
        .catch(() => {});
    };
    const timer = setInterval(poll, 60000);
    return () => clearInterval(timer);
  }, [id, mode]);

  useEffect(() => {
    if (state !== "waiting") return;
    const timer = setTimeout(() => {
      if (!snapshotRef.current) setState("gone");
    }, goneAfterMs);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  const rows = snapshot ? soonestFirst(snapshot.rows) : [];
  const sortedRows =
    mode === "mtr" || mode === "bus" || mode === "minibus"
      ? [...rows].sort(
          (a, b) =>
            (a.route || "").localeCompare(b.route || "") ||
            (a.minutes ?? 0) - (b.minutes ?? 0),
        )
      : rows;
  const age = snapshot ? ageOf(snapshot.fetched_at, now, t) : "";
  const timetable = snapshot ? !snapshot.live && snapshot.note !== "no-arrivals" : false;
  const station = mode === "mtr" ? mtrStationColor(id) : null;
  const description =
    mode === "taxi" ? (
      <>
        {taxiType ? <p className="muted">{locale === "en" ? taxiType.en : taxiType.tc}</p> : null}
        <p className="muted">{t.sheet.hours}</p>
        <p>{taxiHours ? (locale === "en" ? taxiHours.en : taxiHours.tc) : t.sheet.taxiAllDay}</p>
      </>
    ) : mode === "ferry" ? (
      <FerryTimetable destinations={destinations ?? []} timetable={ferryTimetable ?? []} locale={locale} t={t} />
    ) : apiBase && serviceHours ? (
      <>
        <p className="muted">{t.sheet.hours}</p>
        <p>{serviceHours}</p>
      </>
    ) : null;

  return (
    <aside className="sheet">
      <header
        className={station ? ["station", station.badge].filter(Boolean).join(" ") : undefined}
        style={
          station && !station.badge
            ? { background: station.color, color: station.font }
            : undefined
        }
      >
        <div className="stop-title">
          {mode === "taxi" && taxi ? (
            taxiIconFiles(taxi).map((file) => (
              <img
                key={file}
                className="stop-sign taxi-sign"
                src={`${basePath}/icons/${file}`}
                alt=""
              />
            ))
          ) : sign ? (
            <img className="stop-sign" src={sign} alt="" />
          ) : (
            <span className="stop-sign" />
          )}
          <div className="stop-name">
            <div className="stop-heading">
              <div className="stop-copy">
                <h2>{localizeStopName(name, mode, locale, nameTc, nameEn)}</h2>
              </div>
              <div className="sheet-actions">

                <button
                  type="button"
                  className="sheet-icon"
                  aria-label={bookmarked ? (locale === "en" ? "Remove bookmark" : "取消收藏") : locale === "en" ? "Bookmark" : "收藏"}
                  aria-pressed={bookmarked}
                  onClick={onToggleBookmark}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" fill={bookmarked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                    <path d="M6 3h12v18l-6-4.5L6 21z" />
                  </svg>
                </button>
                <ShareStop
                  id={id}
                  label={t.sheet.share}
                  copyLabel={t.sheet.copy}
                  copiedLabel={t.sheet.copied}
                  closeLabel={t.sheet.close}
                />
                <MapMenu
                  latitude={latitude}
                  longitude={longitude}
                  name={localizeStopName(name, mode, locale, nameTc, nameEn)}
                  label={t.sheet.otherMaps}
                  closeLabel={t.sheet.close}
                  maps={[
                    ["google", t.sheet.googleMaps],
                    ["apple", t.sheet.appleMaps],
                    ["baidu", t.sheet.baiduMaps],
                    ["amap", t.sheet.amap],
                    ["osm", t.sheet.openStreetMap],
                  ]}
                />
                <button type="button" onClick={onClose}>
                  {t.sheet.close}
                </button>
              </div>
            </div>
            {(mode === "bus" || mode === "minibus") && ((routes && routes.length > 0) || rows.length > 0) ? (
              <div style={{ width: "100%", marginTop: "0.25rem", display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                {[...new Set((routes && routes.length ? routes : rows.map((r) => r.route)).filter(Boolean))].map((route) => (
                  <span
                    key={route}
                    className="station-chip"
                    style={{ background: mode === "minibus" ? "#2f7d4f" : "#e52029", color: "#fff", fontWeight: 600 }}
                  >
                    {route}
                  </span>
                ))}
              </div>
            ) : null}
            {description || toilet || water || babycare || mode === "mtr" ? (
              <section className={description ? "description" : "description icon-only"}>
                {description}
                <div className="icon-row">
                  {toilet ? (
                    <ToiletMenu
                      toilet={toilet}
                      layout={layout}
                      locale={locale}
                      station={station}
                      label={t.sheet.toilet}
                      closeLabel={t.sheet.close}
                      pdfLabel={t.sheet.toiletLayout}
                    />
                  ) : null}
                  {water ? (
                    <WaterMenu
                      water={water}
                      layout={layout}
                      locale={locale}
                      station={station}
                      label={locale === "en" ? "Water dispenser" : "飲水機"}
                      closeLabel={t.sheet.close}
                      pdfLabel={t.sheet.toiletLayout}
                    />
                  ) : null}
                  {babycare ? (
                    <BabycareMenu
                      babycare={babycare}
                      layout={layout}
                      locale={locale}
                      station={station}
                      label={locale === "en" ? "Babycare room" : "育嬰室"}
                      closeLabel={t.sheet.close}
                      pdfLabel={t.sheet.toiletLayout}
                    />
                  ) : null}
                  {mode === "mtr" && !isLightRail(id) ? (
                    <WifiMenu
                      locale={locale}
                      station={station}
                      label="Wi-Fi"
                      closeLabel={t.sheet.close}
                    />
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </header>
      <div className="body">
        {mode !== "taxi" && apiBase ? (
          <>
          {snapshot?.note === "no-arrivals" ? (
            <p className="muted">{t.sheet.taxiNote}</p>
          ) : snapshot ? (
            <>
              {snapshot.status === "delayed" ? <p className="stale">{t.sheet.delayed}</p> : null}
              {timetable ? <p className="muted">{t.sheet.timetable}</p> : null}
              {rows.length === 0 ? (
                <p className="muted">{t.sheet.noArrivals}</p>
              ) : (
                <ul>
                  {sortedRows.map((row, index) => (
                    <>
                    {(mode === "mtr" || mode === "bus" || mode === "minibus") && (index === 0 || row.route !== sortedRows[index - 1]?.route) ? (
                      <li
                        key={`header-${row.route}`}
                        className="mtr-line-header"
                        style={{ listStyle: "none", fontWeight: 700, marginTop: "0.5rem" }}
                      >
                        <span
                          style={{
                            backgroundColor: mode === "bus" ? "#e52029" : mode === "minibus" ? "#2f7d4f" : MTR_LINE_COLOR[row.route] ?? "#11254a",
                            display: "inline-block",
                            width: "0.8em",
                            height: "0.8em",
                            borderRadius: "999px",
                            marginRight: "0.4em",
                            verticalAlign: "middle",
                          }}
                          aria-hidden="true"
                        />
                        {mode === "bus" || mode === "minibus" ? row.route : locale === "en"
                          ? MTR_LINE_NAME[row.route]?.en ?? row.route
                          : MTR_LINE_NAME[row.route]?.zh ?? row.route}
                      </li>
                    ) : null}
                    <li key={`${row.route}-${index}`}>
                      {mode === "ferry" ? (
                        <div className="ferry-arrival-head">
                          {row.operator ? (
                            <img
                              src={operatorIcon(row.operator)}
                              alt=""
                              className="ferry-op-icon"
                            />
                          ) : null}
                          {row.route ? (
                            <strong>{localizeBilingualName(row.route, locale)}</strong>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          {row.route && mode !== "mtr" && mode !== "bus" && mode !== "minibus" ? (
                            <strong>{row.route}</strong>
                          ) : null}
                        </>
                      )}
                      {mode === "mtr" ? (
                        <StationChip name={row.destination} locale={locale} />
                      ) : row.destination ? (
                        mode === "ferry" ? (
                          <FerryDestination name={row.destination} locale={locale} />
                        ) : (
                          <span>
                            {mode === "bus" || mode === "minibus"
                              ? localizeBilingualName(row.destination, locale)
                              : row.destination}
                          </span>
                        )
                      ) : null}
                      {row.not_departed ? (
                        <span>
                          {" "}
                          · {t.sheet.origin} {t.sheet.notDeparted}
                        </span>
                      ) : null}
                      {mode === "ferry" && row.time ? <span> · {t.clock(row.time)}</span> : null}
                      <span> · {row.minutes !== undefined ? t.sheet.minutes(row.minutes) : row.time}</span>
                    </li>
                    </>
                  ))}
                </ul>
              )}
              {age ? <p className="muted">{t.sheet.updated(age)}</p> : null}
            </>
          ) : (
            <p className={state === "error" || state === "gone" ? "stale" : "muted"}>
              {copy(state, t)}
            </p>
          )}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function FerryDestination({ name, locale }: { name: string; locale: Locale }) {
  return (
    <>
      {name.split(" / ").map((part, index) => {
        const color = ferryDestinationColor(part);
        return (
          <span
            key={`${part}-${index}`}
            className="station-chip ferry-chip"
            style={color ? { background: color.color, color: color.font } : undefined}
          >
            {localizeBilingualName(part, locale)}
          </span>
        );
      })}
    </>
  );
}

function ShareStop({
  id,
  label,
  copyLabel,
  copiedLabel,
  closeLabel,
}: {
  id: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const link = open ? shareLink(id) : "";
  return (
    <>
      <button
        type="button"
        className="sheet-icon"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setCopied(false);
          setOpen(true);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 15V4" />
          <path d="M8 7l4-4 4 4" />
          <path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
        </svg>
      </button>
      {open ? (
        <Modal title={label} closeLabel={closeLabel} onClose={() => setOpen(false)}>
          <input className="modal-link" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
          <button
            type="button"
            className="modal-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(() => setCopied(true));
            }}
          >
            {copied ? copiedLabel : copyLabel}
          </button>
        </Modal>
      ) : null}
    </>
  );
}

function shareLink(id: string): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("stop");
  url.pathname = stopPath(id);
  return url.toString();
}

function operatorName(operator: string, locale: Locale): string {
  switch (operator) {
    case "hkkf":
      return locale === "en" ? "Hong Kong & Kowloon Ferry" : "港九小輪";
    case "sun":
      return locale === "en" ? "Sun Ferry" : "新渡輪";
    case "star":
      return locale === "en" ? "Star Ferry" : "天星小輪";
    case "tsuiwah":
      return locale === "en" ? "Tsui Wah Ferry" : "翠華船務";
    case "chuenkee":
      return locale === "en" ? "Chuen Kee Ferry" : "全記渡輪";
    case "dbtsl":
      return locale === "en" ? "Discovery Bay Transportation" : "愉景灣航運";
    case "pitcl":
      return locale === "en" ? "Park Island Transport" : "珀麗灣客運";
    case "fortune":
      return locale === "en" ? "Fortune Ferry" : "富裕小輪";
    case "coralsea":
      return locale === "en" ? "Coral Sea Ferry" : "珊瑚海船務";
    case "pckaito":
      return locale === "en" ? "Peng Chau Kaito" : "坪洲街渡";
    default:
      return operator;
  }
}

function sessionMinutes(time: string): number {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

// Hong Kong public holidays (YYYY-MM-DD). Update yearly.
const HK_PUBLIC_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-01-29", "2025-01-30", "2025-01-31",
  "2025-04-04", "2025-04-05", "2025-04-06", "2025-04-18",
  "2025-04-19", "2025-04-21", "2025-05-01", "2025-05-05",
  "2025-05-31", "2025-07-01", "2025-10-01", "2025-10-07",
  "2025-10-29", "2025-12-25", "2025-12-26",
  // 2026
  "2026-01-01", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06",
  "2026-05-01", "2026-05-24", "2026-05-25", "2026-07-01",
  "2026-09-26", "2026-10-01", "2026-10-19", "2026-10-26",
  "2026-12-25", "2026-12-26",
  // 2027
  "2027-01-01", "2027-02-06", "2027-02-07", "2027-02-08",
  "2027-03-26", "2027-03-27", "2027-03-29", "2027-04-05",
  "2027-04-06", "2027-05-01", "2027-05-13", "2027-05-14",
  "2027-07-01", "2027-09-16", "2027-10-01", "2027-10-08",
  "2027-10-20", "2027-12-25", "2027-12-27",
]);

function isHongKongPublicHoliday(date: Date): boolean {
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return HK_PUBLIC_HOLIDAYS.has(key);
}

function isCurrentDayGroup(day: string, holidaySet: Set<string> | null): boolean {
  const now = new Date();
  const dow = now.getDay(); // 0=Sun, 6=Sat
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const isHoliday = holidaySet ? holidaySet.has(key) : isHongKongPublicHoliday(now);
  switch (day) {
    case FERRY_DAILY:
      return true;
    case FERRY_SUNDAY:
      return dow === 0 || isHoliday;
    case FERRY_SATURDAY:
      return dow === 6 && !isHoliday;
    case FERRY_WEEKDAYS:
    case FERRY_SCHOOL_DAYS:
      return dow >= 1 && dow <= 5 && !isHoliday;
    default:
      return false;
  }
}

function operatorIcon(operator: string): string {
  return operator === "sun" ? `${basePath}/icons/ferry-boat.svg` : `${basePath}/icons/ferry.svg`;
}

function FerryTimetable({
  destinations,
  timetable,
  locale,
  t,
}: {
  destinations: string[];
  timetable: TimetableDestination[];
  locale: Locale;
  t: Messages;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [holidays, setHolidays] = useState<Set<string> | null>(null);
  useEffect(() => {
    // Without an API the bundled holiday list decides the day group.
    if (!apiBase) return;
    loadCachedJson<string[]>("hk-public-holidays", async () => {
      const response = await fetch(`${apiBase}/holidays`);
      if (!response.ok) throw new Error("holidays");
      const data = await response.json();
      return (data.dates ?? []) as string[];
    }, 365 * 24 * 60 * 60 * 1000)
      .then((dates) => setHolidays(new Set(dates)))
      .catch(() => setHolidays(null));
  }, []);
  const current = timetable[active];
  return (
    <>
      {destinations.length > 0 ? (
        <div className="ferry-destinations">
          {destinations.map((destination, index) => (
            <FerryDestination key={`${destination}-${index}`} name={destination} locale={locale} />
          ))}
        </div>
      ) : null}
      {timetable.length === 0 ? <p className="muted">{t.sheet.noTimetable}</p> : (
        <button
          type="button"
          className="ferry-timetable-btn"
          aria-label={t.sheet.ferryTimetable}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <img
            src={`${basePath}/icons/ferry-timetable.svg`}
            alt=""
            className="ferry-timetable-icon"
          />
        </button>
      )}
      {open ? (
        <Modal title={t.sheet.ferryTimetable} closeLabel={t.sheet.close} onClose={() => setOpen(false)}>
          {current ? (
            <>
              <div className="ferry-tabs" role="tablist">
                {timetable.map((item, index) => {
                  const color = ferryDestinationColor(item.destination);
                  const selected = index === active;
                  return (
                    <button
                      key={`${item.destination}-${index}`}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      className="ferry-tab"
                      style={
                        selected
                          ? { background: color?.color ?? "var(--ink)", color: color?.font ?? "var(--paper)", borderColor: color?.color ?? "var(--ink)" }
                          : undefined
                      }
                      onClick={() => setActive(index)}
                    >
                      {localizeBilingualName(item.destination, locale)}
                    </button>
                  );
                })}
              </div>
              {current.days.some((day) => day.sessions.some((session) => session.operator === "sun" && (session.remark === "1" || session.remark === "4"))) ? (
                <p className="ferry-timetable-legend muted">{t.sheet.ferryTimetableLegend}</p>
              ) : null}
              <div role="tabpanel">
                {[...current.days]
                  .sort((a, b) => {
                    const aCurrent = isCurrentDayGroup(a.day, holidays) ? 0 : 1;
                    const bCurrent = isCurrentDayGroup(b.day, holidays) ? 0 : 1;
                    return aCurrent - bCurrent;
                  })
                  .map((day) => {
                    const isCurrent = isCurrentDayGroup(day.day, holidays);
                    return (
                  <section key={day.day} className={`ferry-day ${isCurrent ? "" : "ferry-day-past"}`.trim()}>
                    <h3 className={isCurrent ? "ferry-day-title-current" : ""}>{t.sheet.ferryDay(day.day)}</h3>
                    {(() => {
                      const operators = [...new Set(day.bands.map((band) => band.operator))];
                      const sessionOps = [...new Set(day.sessions.map((session) => session.operator))];
                      const allOps = [...new Set([...operators, ...sessionOps])];
                      return allOps.map((op) => {
                        const opBands = day.bands.filter((band) => band.operator === op);
                        const opSessions = day.sessions.filter((session) => session.operator === op);
                        if (opBands.length === 0 && opSessions.length === 0) return null;
                        // `^` marks the last sailing of the day within this operator.
                        const markedSession = opSessions.find((s) => s.remark.includes("^"));
                        return (
                          <div key={op} className="ferry-operator">
                            <h4 className="ferry-operator-name">
                              <img src={operatorIcon(op)} alt="" className="ferry-op-icon" />
                              {operatorName(op, locale)}
                            </h4>
                            {opBands.length > 0 ? (
                              <ul className="ferry-bands">
                                {opBands.map((band, index) => (
                                  <li key={`${band.from}-${index}`}>
                                    {t.clock(band.from)}–{t.clock(band.to)} · {t.sheet.everyMinutes(band.frequency)}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {opSessions.length > 0 ? (
                              <ol className="ferry-sessions">
                                {[...opSessions]
                                  .sort((a, b) => {
                                    const am = sessionMinutes(a.time);
                                    const bm = sessionMinutes(b.time);
                                    const aKey = am < 240 ? am + 1440 : am;
                                    const bKey = bm < 240 ? bm + 1440 : bm;
                                    return aKey - bKey;
                                  })
                                  .map((session, index, sorted) => {
                                  const minutes = sessionMinutes(session.time);
                                  const hasEarlierValid = sorted
                                    .slice(0, index)
                                    .some((s) => sessionMinutes(s.time) >= 240);
                                  const isFirst = minutes >= 240 && !hasEarlierValid;
                                  const lastIdx = markedSession
                                    ? sorted.findIndex((s) => s === markedSession)
                                    : sorted.length - 1;
                                  const highlight = [isFirst ? "first" : "", index === lastIdx ? "last" : ""]
                                    .filter(Boolean)
                                    .join(" ");
                                  return (
                                    <li key={`${session.time}-${index}`} className={[highlight, (session.operator === "sun" && (session.remark === "1" || session.remark === "4")) ? "ferry-session-bold" : ""].filter(Boolean).join(" ")}>
                                      {t.clock(session.time)}
                                    </li>
                                  );
                                })}
                              </ol>
                            ) : null}
                          </div>
                        );
                      });
                    })()}
                  </section>
                  );
                })}
              </div>
            </>
          ) : null}
        </Modal>
      ) : null}
    </>
  );
}

function MapMenu({
  latitude,
  longitude,
  name,
  label,
  closeLabel,
  maps,
}: {
  latitude: number;
  longitude: number;
  name: string;
  label: string;
  closeLabel: string;
  maps: [MapChoice, string][];
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [latitude, longitude]);
  return (
    <>
      <button
        type="button"
        className="sheet-icon"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 5h5v5" />
          <path d="M13 11l6-6" />
          <path d="M19 13v6a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6" />
        </svg>
      </button>
      {open ? (
        <Modal title={label} closeLabel={closeLabel} onClose={() => setOpen(false)}>
          <ul className="modal-maps">
            {maps.map(([choice, text]) => (
              <li key={choice}>
                <a
                  href={mapUrl(choice, latitude, longitude, name)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => setOpen(false)}
                >
                  {text}
                </a>
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </>
  );
}

// MTR Free Wi-Fi QR code (WIFI:T:nopass;S:MTR Free Wi-Fi;;), transparent background.
const wifiQrSrc = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAAGQCAYAAACAvzbMAAAG50lEQVR42u3csY7bQBBEwR5D///L48SxYRxkLme2KnFknERSelgFnQDAD9Sff9uleMV9eLN+8H21e/21a1JLr6PvrBc8y79cAwB+QkAAEBAABAQAAQFAQABAQAAQEAAEBAABAUBAAEBAAPiCT3YPAGbxwNvmcb3NI4wT7lsvHhP1vfXF++0EAoCAACAgAAgIAAICAAICgIAAICAACAgAAgIAAgKAgAAgIADkljXeLF5MLa8x1mDftarbnv/csrQ95r45gQAgIAAICAACAoCAAICAACAgAAgIAAICgIAAgIAAICAACAgAscZLrIMmmbMYvPla9oBn0vqvEwgAAgIAAgKAgAAgIAAICAACAgACAoCAACAgAAgIAAICADGmeIdaPHg3YYSxhww3br5vOIEAICAACAgACAgAAgKAgAAgIAAICAAICAACAoCAACAgAAgIAOTVa7wWO7+jvUbLs//pHviMuiZOIAAICAACAoCAACAgACAgAAgIAAICgIAAICAAICAACAgAAgJArPFm1hos+dqqaL/8b2XIYm0vXoOd8N58bzmBACAgAAgIAAICAAICgIAAICAACAgAAgIAAgKAgAAgIAAICACxzMol2nNpjRecQAAQEAAEBAABAQABAUBAABAQAAQEAAEBAAEBQEAAEBAAsmBMsV2Ko0N5W6+J4cBcNbhZxizvGup0AgFAQAAQEAAEBAABAQABAUBAABAQAAQEAAEBAAEBQEAAEBAAcssa74TF2lq8flqLX6NVY8vGb1sa3rxi/eO/5wQCQPyEBYCAACAgAAgIAAgIAAICgIAAICAACAgACAgAAgKAgACQC5ZBk93roBY771kMnvSZs349b7E2mxebnUAAEBAABAQAAQFAQABAQAAQEAAEBAABAUBAAEBAABAQAHJ42K1dipFDeVsZs3TftlzHzSOk5QQCQPyEBYCAACAgAAgIAAgIAAICgIAAICAACAgACAgAAgKAgAAwySfWcXPZGunmxdQasv7LuTVk7+2Ln1MnEAAEBAABAUBAABAQABAQAAQEAAEBQEAAEBAAEBAABAQAAQEg1mozful2whrs08uz5eNyzYKve332c9ND1qjLCQSA+AkLAAEBQEAAEBAAEBAABAQAAQFAQAAQEAAQEAAEBAABAWCST3avwY5ZtRywBttWZDNxsbZjsfaWpeHHr4kTCAACAoCAACAgAAgIAAgIAAICgIAAICAACAgACAgAAgJADo8pxuDd0b83Ycwyi+/b1jHRLB4BnHL9O04gACAgAAgIAAICgIAAICAAICAACAgAAgKAgAAgIAAgIAAICAAZv8bbAxZapyxhlkfxmuvvXs/8bHd2rno7gQAQP2EBICAACAgACAgAAgKAgAAgIAAICAAICAACAoCAACAgAMQab6yRvnxFsxZf//bRdL9ftlhbi5/lH18TJxAA4icsAAQEAAEBQEAAQEAAEBAABAQAAQFAQABAQAAQEAAEBIBcssY7YeXz6QXNHnAtJ7zGCcun5evj6LW02PyCZ9kJBAABAUBAABAQAAQEAAQEAAEBQEAAEBAABAQABAQAAQEgh0e02uDdOD1gqHDCMzJlzHLCUKHvhMu+S5xAAIifsAAQEAAEBAABAQABAUBAABAQAAQEAAEBAAEBQEAAEBAAYo03b1r6zOKlVYu185aGY9WVLc+WEwgAAgKAgAAgIAAICAAICAACAoCAACAgAAgIAAgIAAICgIAAEKuPxGLt+uerF3/G2/fQ0WtijReA+AkLAAQEAAEBQEAAEBAABAQABAQAAQFAQAAQEAAEBAD+7pNZw3AxaplJo3BG+c6OWebhEcxePCaKEwgAAgKAgAAgIAAICAAICAACAoCAACAgAAgIAAgIAAICgIAAkCVrvLFqmWnrs+W9HX1vT7/GGrKIbHn5ou9JJxAABAQAAQFAQAAQEAAQEAAEBAABAUBAABAQABAQAAQEAAEBILes8WbxOmhZ/r1KDbhv9eD/a89ybloDLycQAOInLAAEBAABAQABAUBAABAQAAQEAAEBAAEBQEAAEBAABASAWOOFnFi5bdfk6DWpAWuwU56RXroG7gQCgIAAICAACAgAAgIAAgKAgAAgIAAICAACAgACAoCAABBjimTAUF4MDuaWocj2HLv+TiAACAgAAgKAgAAgIAAgIAAICAACAoCAACAgACAgAAgIAAICQKzxxormpXrxYm09+Bo9/zOXbsvnxgkEAAEBQEAAEBAABAQABAQAAQFAQAAQEAAEBAAEBAABAUBAAMi9a7zt8vEyE1ZMJ6z49uJ7XZ5/JxAA4icsAAQEAAEBAAEBQEAAEBAABAQAAQEAAQFAQAAQEAAEBAAA4J/9BtgGrEmvV/HsAAAAAElFTkSuQmCC";

function WaterMenu({
  water,
  layout,
  locale,
  station,
  label,
  closeLabel,
  pdfLabel,
}: {
  water: WaterDispenser;
  layout: Layout | null;
  locale: Locale;
  station: StationColor | null;
  label: string;
  closeLabel: string;
  pdfLabel: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [water]);
  const location = locale === "en" ? water.location : water.location_zh;
  const pdfUrl = layout ? (locale === "en" ? layout.pdf_url : layout.pdf_url_zh) : null;
  return (
    <>
      <button
        type="button"
        className="toilet"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
        </svg>
      </button>
      {open ? (
        <Modal title={label} closeLabel={closeLabel} onClose={() => setOpen(false)}>
          <div className="modal-location">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M12 11.5A2.5 2.5 0 0 1 9.5 9A2.5 2.5 0 0 1 12 6.5A2.5 2.5 0 0 1 14.5 9a2.5 2.5 0 0 1-2.5 2.5M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7" />
            </svg>
            <span className="modal-address">{location}</span>
            {pdfUrl ? (
              <a
                className={station?.badge ? "modal-layout station-badge-chh" : "modal-layout"}
                style={station && !station.badge ? { background: station.color, color: station.font } : undefined}
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-9.5 8.5c0 .8-.7 1.5-1.5 1.5H7v2H5.5V9H8c.8 0 1.5.7 1.5 1.5zm5 2c0 .8-.7 1.5-1.5 1.5h-2.5V9H13c.8 0 1.5.7 1.5 1.5zm4-3H17v1h1.5V13H17v2h-1.5V9h3zm-6.5 0h1v3h-1zm-5 0h1v1H7z" />
                </svg>
                {pdfLabel}
              </a>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function BabycareMenu({
  babycare,
  layout,
  locale,
  station,
  label,
  closeLabel,
  pdfLabel,
}: {
  babycare: Babycare;
  layout: Layout | null;
  locale: Locale;
  station: StationColor | null;
  label: string;
  closeLabel: string;
  pdfLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const location = locale === "en" ? babycare.location : babycare.location_zh;
  const pdfUrl = layout ? (locale === "en" ? layout.pdf_url : layout.pdf_url_zh) : null;
  return (
    <>
      <button
        type="button"
        className="toilet"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M10 5V2.8C10 1.8 10.7 1 12 1s2 .8 2 1.8V5z" />
          <rect x="7.5" y="5" width="9" height="3" rx="1" />
          <rect x="6" y="8" width="12" height="14" rx="3" />
        </svg>
      </button>
      {open ? (
        <Modal title={label} closeLabel={closeLabel} onClose={() => setOpen(false)}>
          <div className="modal-location">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M12 11.5A2.5 2.5 0 0 1 9.5 9A2.5 2.5 0 0 1 12 6.5A2.5 2.5 0 0 1 14.5 9a2.5 2.5 0 0 1-2.5 2.5M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7" />
            </svg>
            <span className="modal-address">{location}</span>
            {pdfUrl ? (
              <a
                className={station?.badge ? "modal-layout station-badge-chh" : "modal-layout"}
                style={station && !station.badge ? { background: station.color, color: station.font } : undefined}
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-9.5 8.5c0 .8-.7 1.5-1.5 1.5H7v2H5.5V9H8c.8 0 1.5.7 1.5 1.5zm5 2c0 .8-.7 1.5-1.5 1.5h-2.5V9H13c.8 0 1.5.7 1.5 1.5zm4-3H17v1h1.5V13H17v2h-1.5V9h3zm-6.5 0h1v3h-1zm-5 0h1v1H7z" />
                </svg>
                {pdfLabel}
              </a>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function WifiMenu({
  locale,
  station,
  label,
  closeLabel,
}: {
  locale: Locale;
  station: StationColor | null;
  label: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const url =
    locale === "en"
      ? "https://www.mtr.com.hk/en/customer/services/free_wifi.html"
      : "https://www.mtr.com.hk/ch/customer/services/free_wifi.html";
  return (
    <>
      <button
        type="button"
        className="toilet"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M12 18a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3m-4.24-4.24a6 6 0 0 1 8.48 0l-1.41 1.41a4 4 0 0 0-5.66 0zm-2.83-2.83a10 10 0 0 1 14.14 0l-1.41 1.41a8 8 0 0 0-11.31 0zM1.96 8.17a14 14 0 0 1 20.08 0l-1.41 1.41a12 12 0 0 0-17.25 0z" />
        </svg>
      </button>
      {open ? (
        <Modal title={label} closeLabel={closeLabel} onClose={() => setOpen(false)}>
          <div className="flex items-start gap-4 py-4">
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#6f675e]">{locale === "en" ? "Scan QR code" : "掃描 QR 碼"}</p>
              <img
                src={wifiQrSrc}
                alt="MTR Free Wi-Fi QR code"
                className="h-28 w-28 shrink-0 mix-blend-multiply"
              />
            </div>
            <div className="relative flex items-center self-stretch">
              <div className="h-full w-px bg-[rgb(28_25_21/0.12)]" />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[rgb(244_239_230/0.96)] px-1 text-xs text-[#6f675e]">{locale === "en" ? "Or" : "或"}</span>
            </div>
            <div className="flex-1 text-left">
              <div className="mb-2 flex items-center gap-2">
                <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 text-[#2563eb]" fill="currentColor">
                  <path d="M12 18a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3m-4.24-4.24a6 6 0 0 1 8.48 0l-1.41 1.41a4 4 0 0 0-5.66 0zm-2.83-2.83a10 10 0 0 1 14.14 0l-1.41 1.41a8 8 0 0 0-11.31 0zM1.96 8.17a14 14 0 0 1 20.08 0l-1.41 1.41a12 12 0 0 0-17.25 0z" />
                </svg>
                <p className="text-base font-semibold">MTR Free Wi-Fi</p>
              </div>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-[#4b453f]">
                <li>{locale === "en" ? "Open your device Wi-Fi settings." : "開啟裝置的 Wi-Fi 設定。"}</li>
                <li>{locale === "en" ? 'Select "MTR Free Wi-Fi".' : '選擇「MTR Free Wi-Fi」。'}</li>
                <li>{locale === "en" ? "Follow the on-screen prompts to connect." : "按照畫面提示完成連線。"}</li>
              </ol>
            </div>
          </div>
            <div className="flex justify-end">
              <a
                className={station?.badge ? "modal-layout station-badge-chh" : "modal-layout"}
                style={station && !station.badge ? { background: station.color, color: station.font } : undefined}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {locale === "en" ? "Visit official site" : "前往官方網站"}
              </a>
            </div>
        </Modal>
      ) : null}
    </>
  );
}

function ToiletMenu({
  toilet,
  layout,
  locale,
  station,
  label,
  closeLabel,
  pdfLabel,
}: {
  toilet: StationToilet;
  layout: Layout | null;
  locale: Locale;
  station: StationColor | null;
  label: string;
  closeLabel: string;
  pdfLabel: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [toilet]);
  const location = locale === "en" ? toilet.location : toilet.location_zh;
  const pdfUrl = layout ? (locale === "en" ? layout.pdf_url : layout.pdf_url_zh) : null;
  return (
    <>
      <button
        type="button"
        className="toilet"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <path d="M7.5 2a2 2 0 0 1 2 2a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2M6 7h3a2 2 0 0 1 2 2v5.5H9.5V22h-4v-7.5H4V9a2 2 0 0 1 2-2m10.5-5a2 2 0 0 1 2 2a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2M15 22v-6h-3l2.59-7.59C14.84 7.59 15.6 7 16.5 7s1.66.59 1.91 1.41L21 16h-3v6z" />
        </svg>
      </button>
      {open ? (
        <Modal title={label} closeLabel={closeLabel} onClose={() => setOpen(false)}>
          <div className="modal-location">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
              <path d="M12 11.5A2.5 2.5 0 0 1 9.5 9A2.5 2.5 0 0 1 12 6.5A2.5 2.5 0 0 1 14.5 9a2.5 2.5 0 0 1-2.5 2.5M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7" />
            </svg>
            <span className="modal-address">{location}</span>
            {pdfUrl ? (
              <a
                className={station?.badge ? "modal-layout station-badge-chh" : "modal-layout"}
                style={station && !station.badge ? { background: station.color, color: station.font } : undefined}
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2m-9.5 8.5c0 .8-.7 1.5-1.5 1.5H7v2H5.5V9H8c.8 0 1.5.7 1.5 1.5zm5 2c0 .8-.7 1.5-1.5 1.5h-2.5V9H13c.8 0 1.5.7 1.5 1.5zm4-3H17v1h1.5V13H17v2h-1.5V9h3zm-6.5 0h1v3h-1zm-5 0h1v1H7z" />
                </svg>
                {pdfLabel}
              </a>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

export function Modal({
  title,
  closeLabel,
  onClose,
  children,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-30 overflow-y-auto bg-[rgb(28_25_21/0.45)]" onClick={onClose}>
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className="relative my-8 w-full max-w-sm border border-[rgb(28_25_21/0.14)] bg-[rgb(244_239_230/0.96)] text-[var(--ink)] shadow-[0_12px_32px_rgb(28_25_21/0.16)]"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="flex items-center justify-between gap-3 border-b border-[rgb(28_25_21/0.12)] px-4 py-[0.85rem]">
            <h2 className="min-w-0 text-[1.05rem] font-semibold [overflow-wrap:anywhere]">{title}</h2>
            <button
              type="button"
              className="-m-2 flex size-11 shrink-0 items-center justify-center border-0 bg-transparent p-0"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              >
                <path d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </header>
          <div className="px-4 py-[0.85rem]">{children}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type MapChoice = "google" | "apple" | "baidu" | "amap" | "osm";

function mapUrl(choice: MapChoice, latitude: number, longitude: number, name: string): string {
  const at = `${latitude},${longitude}`;
  const place = encodeURIComponent(name);
  if (choice === "google") {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(at)}`;
  }
  if (choice === "apple") {
    return `https://maps.apple.com/?ll=${encodeURIComponent(at)}&q=${place}`;
  }
  if (choice === "baidu") {
    return `https://api.map.baidu.com/marker?location=${encodeURIComponent(at)}&title=${place}&content=${place}&output=html&coord_type=wgs84&src=webapp.realtime-hk-traffic.map`;
  }
  if (choice === "amap") {
    return `https://uri.amap.com/marker?position=${encodeURIComponent(`${longitude},${latitude}`)}&name=${place}&src=realtime-hk-traffic&coordinate=wgs84&callnative=1`;
  }
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=18/${latitude}/${longitude}`;
}

function taxiIconFiles(kind: TaxiKind): string[] {
  if (kind === "urban-nt") return ["taxi-urban.svg", "taxi-nt.svg"];
  if (kind === "urban-cross") return ["taxi-urban.svg", "taxi-cross.svg"];
  return [`taxi-${kind}.svg`];
}

function StationChip({ name, locale }: { name: string; locale: Locale }) {
  const color = mtrDestinationColor(name);
  return (
    <span
      className={color?.badge ? `station-chip ${color.badge}` : "station-chip"}
      style={
        color && !color.badge ? { background: color.color, color: color.font } : undefined
      }
    >
      {localizeStopName(name, "mtr", locale)}
    </span>
  );
}

function copy(state: State, t: Messages): string {
  if (state === "gone") return t.sheet.gone;
  if (state === "error") return t.sheet.feedError;
  if (state === "waiting") return t.sheet.waiting;
  return t.sheet.loading;
}

function soonestFirst(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const left = a.minutes ?? Number.POSITIVE_INFINITY;
    const right = b.minutes ?? Number.POSITIVE_INFINITY;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

function ageOf(fetchedAt: string, now: number, t: Messages): string {
  const then = Date.parse(fetchedAt);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return t.age.seconds(seconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t.age.minutes(minutes);
  return t.age.hours(Math.round(minutes / 60));
}
