"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n, type Locale, type Messages } from "./i18n";
import { mtrDestinationColor, mtrStationColor, type StationColor } from "./mtr-station-color";
import { ferryDestinationColor } from "./ferry-destination-color";
import { loadTaxiKindImages, loadVehicleImages, citybusIconUrl, ferryBoatIconUrl, isCitybus, isStarFerry, stopIconUrl, type Mode, type TaxiKind } from "./stop-icon";
import { loadCachedJson } from "./catalogue-cache";
import { stopPath } from "./stop-link";
import { localizeBilingualName, localizeStopName } from "./stop-name";
import type { TaxiLabel } from "./taxi-stand";

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

type TimetableDestination = { destination: string; days: TimetableDay[] };

type Timetable = { source: string; destinations: TimetableDestination[] };

type StationToilet = {
  station_code: string;
  location: string;
  location_zh: string;
  pdf_url: string;
  pdf_url_zh: string;
};

export function StopSheet({
  id,
  mode,
  name,
  nameTc,
  nameEn,
  latitude,
  longitude,
  taxi,
  taxiType,
  taxiHours,
  serviceHours,
  onClose,
}: {
  id: string;
  mode: Mode;
  name: string;
  nameTc?: string;
  nameEn?: string;
  latitude: number;
  longitude: number;
  taxi?: TaxiKind;
  taxiType?: TaxiLabel;
  taxiHours?: TaxiLabel | null;
  serviceHours?: string | null;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const [sign, setSign] = useState<string | null>(null);
  const [toilet, setToilet] = useState<StationToilet | null>(null);
  useEffect(() => {
    if (mode !== "mtr") {
      setToilet(null);
      return;
    }
    let cancelled = false;
    setToilet(null);
    const code = id.startsWith("mtr:") ? id.slice(4) : "";
    loadCachedJson<StationToilet[]>("station-toilet-v2", async () => {
      const response = await fetch(`${basePath}/station-toilet.json`);
      if (!response.ok) throw new Error("station-toilet");
      return response.json() as Promise<StationToilet[]>;
    })
      .then((body) => {
        if (!cancelled) setToilet(body.find((entry) => entry.station_code === code) ?? null);
      })
      .catch(() => {
        // A missing catalogue only hides the toilet line.
      });
    return () => {
      cancelled = true;
    };
  }, [id, mode]);
  useEffect(() => {
    if (mode === "taxi" && taxi) return;
    let cancelled = false;
    // A deep link opens the sheet before the SVG artwork has loaded. Drawing
    // then keeps the plain fallback instead of the full sign.
    void Promise.all([loadVehicleImages(basePath), loadTaxiKindImages(basePath)]).then(() => {
      if (!cancelled) {
        setSign(
          mode === "ferry" && !isStarFerry(id)
            ? ferryBoatIconUrl()
            : mode === "bus" && isCitybus(id)
              ? citybusIconUrl()
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
    fetch(`${apiBase}/stops/${encodeURIComponent(id)}/arrivals`)
      .then((response) => {
        if (cancelled) return null;
        if (response.status === 404) {
          // The server has no snapshot yet; the stream below asks for one.
          setState("waiting");
          return null;
        }
        if (!response.ok) {
          setState("error");
          return null;
        }
        return response.json() as Promise<Snapshot>;
      })
      .then((body) => {
        if (!cancelled && body) setSnapshot(body);
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [id, mode]);

  useEffect(() => {
    if (!apiBase || mode === "taxi") return;
    const source = new EventSource(`${apiBase}/stops/${encodeURIComponent(id)}/events`);
    const onArrivals = (event: Event) => {
      try {
        setSnapshot(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
      } catch {
        // A malformed push keeps the last good snapshot on screen.
      }
    };
    source.addEventListener("arrivals", onArrivals);
    return () => {
      source.removeEventListener("arrivals", onArrivals);
      source.close();
    };
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
    ) : apiBase && mode === "ferry" ? (
      <FerryTimetable id={id} locale={locale} t={t} />
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
            {description || toilet ? (
              <section className={description ? "description" : "description icon-only"}>
                {description}
                {toilet ? (
                  <ToiletMenu
                    toilet={toilet}
                    locale={locale}
                    station={station}
                    label={t.sheet.toilet}
                    closeLabel={t.sheet.close}
                    pdfLabel={t.sheet.toiletLayout}
                  />
                ) : null}
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
                  {rows.map((row, index) => (
                    <li key={`${row.route}-${index}`}>
                      {mode === "ferry" && row.operator ? (
                        <img
                          src={operatorIcon(row.operator)}
                          alt=""
                          className="ferry-op-icon"
                        />
                      ) : null}
                      {row.route && mode !== "mtr" ? (
                        <strong>
                          {mode === "ferry" ? localizeBilingualName(row.route, locale) : row.route}
                        </strong>
                      ) : null}
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
    default:
      return operator;
  }
}

function sessionMinutes(time: string): number {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isPastSession(time: string): boolean {
  const match = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return false;
  const mins = sessionMinutes(time);
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  // A session before 06:00 is treated as next-day when viewed in the evening.
  if (mins < 360 && currentMinutes >= 720) return false;
  return mins < currentMinutes;
}

function operatorIcon(operator: string): string {
  switch (operator) {
    case "sun":
      return `${basePath}/icons/ferry-boat.svg`;
    case "hkkf":
    case "star":
    case "tsuiwah":
    default:
      return `${basePath}/icons/ferry.svg`;
  }
}

function FerryTimetable({ id, locale, t }: { id: string; locale: Locale; t: Messages }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [timetable, setTimetable] = useState<Timetable | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    loadCachedJson<Timetable>(`ferry-timetable:v2:${id}`, async () => {
      const response = await fetch(`${apiBase}/stops/${encodeURIComponent(id)}/timetable`);
      if (!response.ok) throw new Error("timetable");
      return response.json() as Promise<Timetable>;
    })
      .then((body) => {
        if (!cancelled) setTimetable(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  const destinations = timetable?.destinations ?? [];
  const current = destinations[active];
  const iconMask = `url(${basePath}/icons/ferry-timetable.svg) center / contain no-repeat`;
  return (
    <>
      {destinations.length > 0 ? (
        <div className="ferry-destinations">
          {destinations.map((dest, index) => (
            <FerryDestination key={`${dest.destination}-${index}`} name={dest.destination} locale={locale} />
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="sheet-icon"
        aria-label={t.sheet.ferryTimetable}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span
          aria-hidden="true"
          className="ferry-timetable-icon"
          style={{ mask: iconMask, WebkitMask: iconMask }}
        />
      </button>
      {open ? (
        <Modal title={t.sheet.ferryTimetable} closeLabel={t.sheet.close} onClose={() => setOpen(false)}>
          {failed ? <p className="stale">{t.sheet.feedError}</p> : null}
          {!failed && !timetable ? <p className="muted">{t.sheet.loading}</p> : null}
          {timetable && destinations.length === 0 ? <p className="muted">{t.sheet.noArrivals}</p> : null}
          {timetable && current ? (
            <>
              <div className="ferry-tabs" role="tablist">
                {destinations.map((item, index) => (
                  <button
                    key={`${item.destination}-${index}`}
                    type="button"
                    role="tab"
                    aria-selected={index === active}
                    className="ferry-tab"
                    onClick={() => setActive(index)}
                  >
                    {localizeBilingualName(item.destination, locale)}
                  </button>
                ))}
              </div>
              <div role="tabpanel">
                {current.days.map((day) => (
                  <section key={day.day} className="ferry-day">
                    <h3>{t.sheet.ferryDay(day.day)}</h3>
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
                                  const past = isPastSession(session.time);
                                  return (
                                    <li key={`${session.time}-${index}`} className={`${highlight} ${past ? "past" : ""}`.trim()}>
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
                ))}
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

function ToiletMenu({
  toilet,
  locale,
  station,
  label,
  closeLabel,
  pdfLabel,
}: {
  toilet: StationToilet;
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
  const pdfUrl = locale === "en" ? toilet.pdf_url : toilet.pdf_url_zh;
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
