"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n, type Locale, type Messages } from "./i18n";
import { mtrDestinationColor, mtrStationColor } from "./mtr-station-color";
import { stopIconUrl, type Mode, type TaxiKind } from "./stop-icon";
import { localizeStopName } from "./stop-name";
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
};

type Snapshot = {
  fetched_at: string;
  live: boolean;
  status?: string;
  note?: string;
  rows: Row[];
};

type State = "loading" | "waiting" | "gone" | "error";

export function StopSheet({
  id,
  mode,
  name,
  taxi,
  taxiType,
  taxiHours,
  onClose,
}: {
  id: string;
  mode: Mode;
  name: string;
  taxi?: TaxiKind;
  taxiType?: TaxiLabel;
  taxiHours?: TaxiLabel | null;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const sign = useMemo(() => stopIconUrl(mode), [mode]);
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
          ) : (
            <img className="stop-sign" src={sign} alt="" />
          )}
          <div>
            <h2>{localizeStopName(name, mode, locale)}</h2>
            <p className="mode">
              {mode === "taxi" && taxiType
                ? locale === "en"
                  ? taxiType.en
                  : taxiType.tc
                : t.mode[mode]}
            </p>
          </div>
        </div>
        <button type="button" onClick={onClose}>
          {t.sheet.close}
        </button>
      </header>
      {mode === "taxi" ? (
        <div className="body">
          <p className="muted">{t.sheet.taxiHours}</p>
          <p>{taxiHours ? (locale === "en" ? taxiHours.en : taxiHours.tc) : t.sheet.taxiAllDay}</p>
        </div>
      ) : apiBase ? (
        <div className="body">
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
                      {row.route && mode !== "mtr" ? <strong>{row.route}</strong> : null}
                      {mode === "mtr" ? (
                        <StationChip name={row.destination} locale={locale} />
                      ) : (
                        <span>{row.destination}</span>
                      )}
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
        </div>
      ) : null}
    </aside>
  );
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
