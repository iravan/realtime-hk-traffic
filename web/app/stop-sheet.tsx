"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { modeLabel, stopIconUrl, type Mode } from "./stop-icon";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
// On Vercel the API is same-origin behind the /api rewrite. A static host such
// as GitHub Pages has no API, so it must name one, or the sheet stays name-only.
const apiBase = process.env.NEXT_PUBLIC_API_BASE || (basePath ? "" : "/api");
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
  onClose,
}: {
  id: string;
  mode: Mode;
  name: string;
  onClose: () => void;
}) {
  const sign = useMemo(() => stopIconUrl(mode), [mode]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  snapshotRef.current = snapshot;
  const [state, setState] = useState<State>("loading");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!apiBase) return;
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
  }, [id]);

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
  const age = snapshot ? ageOf(snapshot.fetched_at, now) : "";
  const timetable = snapshot ? !snapshot.live && snapshot.note !== "no-arrivals" : false;

  return (
    <aside className="sheet">
      <header>
        <div className="stop-title">
          <img className="stop-sign" src={sign} alt="" />
          <div>
            <h2>{name}</h2>
            <p className="mode">{modeLabel(mode)}</p>
          </div>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {apiBase ? (
        <div className="body">
          {snapshot?.note === "no-arrivals" ? (
            <p className="muted">A taxi stand has no arrival list.</p>
          ) : snapshot ? (
            <>
              {snapshot.status === "delayed" ? <p className="stale">Delayed</p> : null}
              {timetable ? <p className="muted">Not live. These are timetable times.</p> : null}
              {rows.length === 0 ? (
                <p className="muted">No arrivals right now.</p>
              ) : (
                <ul>
                  {rows.map((row, index) => (
                    <li key={`${row.route}-${index}`}>
                      <strong>{row.route}</strong>
                      <span>{row.destination}</span>
                      <span> · {row.minutes !== undefined ? `${row.minutes} min` : row.time}</span>
                    </li>
                  ))}
                </ul>
              )}
              {age ? <p className="muted">Updated {age}</p> : null}
            </>
          ) : (
            <p className={state === "error" || state === "gone" ? "stale" : "muted"}>
              {copy(state)}
            </p>
          )}
        </div>
      ) : null}
    </aside>
  );
}

function copy(state: State): string {
  if (state === "gone") return "The snapshot is gone.";
  if (state === "error") return "The arrivals feed did not answer.";
  if (state === "waiting") return "Waiting for the live feed…";
  return "Loading arrivals…";
}

function soonestFirst(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const left = a.minutes ?? Number.POSITIVE_INFINITY;
    const right = b.minutes ?? Number.POSITIVE_INFINITY;
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

function ageOf(fetchedAt: string, now: number): string {
  const then = Date.parse(fetchedAt);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}
