"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n, type Locale, type Messages } from "./i18n";
import { mtrDestinationColor, mtrStationColor } from "./mtr-station-color";
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
};

type Snapshot = {
  fetched_at: string;
  live: boolean;
  status?: string;
  note?: string;
  rows: Row[];
};

type State = "loading" | "waiting" | "gone" | "error";

type FerryText = { zh: string; en: string };

type FerryService = {
  destination: string;
  first: FerryText;
  last: FerryText;
};

export function StopSheet({
  id,
  mode,
  name,
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
  const [sailings, setSailings] = useState<FerryService[] | null>(null);
  useEffect(() => {
    if (mode !== "ferry") {
      setSailings(null);
      return;
    }
    let cancelled = false;
    setSailings(null);
    loadCachedJson<Record<string, FerryService[]>>("ferry-services", async () => {
      const response = await fetch(`${basePath}/ferry-services.json`);
      if (!response.ok) throw new Error("ferry-services");
      return response.json() as Promise<Record<string, FerryService[]>>;
    })
      .then((body) => {
        if (!cancelled) setSailings(body[id] ?? []);
      })
      .catch(() => {
        if (!cancelled) setSailings([]);
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
    ) : apiBase && mode === "ferry" && sailings && sailings.length > 0 ? (
      <table className="ferry-services">
        <thead>
          <tr>
            <th>{t.sheet.destination}</th>
            <th>{t.sheet.firstBoat}</th>
            <th>{t.sheet.lastBoat}</th>
          </tr>
        </thead>
        <tbody>
          {sailings.map((sailing, index) => {
            const text = locale === "en" ? "en" : "zh";
            return (
              <tr key={`${sailing.destination}-${index}`}>
                <td><FerryDestination name={sailing.destination} locale={locale} /></td>
                <td>{formatFerryWhen(sailing.first[text], t)}</td>
                <td>{formatFerryLast(sailing.first[text], sailing.last[text], t)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
                <h2>{localizeStopName(name, mode, locale)}</h2>
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
                  name={localizeStopName(name, mode, locale)}
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
            {description ? <section className="description">{description}</section> : null}
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

function Modal({
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
    <div className="modal" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <h3>{title}</h3>
          <button type="button" onClick={onClose}>
            {closeLabel}
          </button>
        </header>
        {children}
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

function formatFerryWhen(value: string, t: Messages): string {
  return value
    .split("\n")
    .map((line) => line.replace(/(\d{1,2}):(\d{2})/g, (_match, hour, minute) => t.clock(`${hour.padStart(2, "0")}:${minute}`)))
    .join("\n");
}

function bareClock(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatFerryLast(first: string, last: string, t: Messages): string {
  const shown = formatFerryWhen(last, t);
  const from = bareClock(first);
  const to = bareClock(last);
  if (from != null && to != null && to < from) return t.nextDayTime(shown);
  return shown;
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
