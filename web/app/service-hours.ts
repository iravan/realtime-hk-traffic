import type { Mode } from "./stop-icon";

// One contiguous stretch of service. `days` are ISO weekdays (1 = Monday,
// 7 = Sunday) for the day the window opens. A `to` earlier than `from` runs
// past midnight into the next day.
export type ServiceWindow = {
  days: number[];
  from: string;
  to: string;
};

export type Schedule = ServiceWindow[];

// `web/public/service-hours.json` ships every mode default, every MTR
// station, and the green-minibus routes the catalogue knows. A stop without a
// matching entry keeps the mode default, so the file never has to list every
// street stop.
export type ServiceHours = {
  timezone?: string;
  modes?: Partial<Record<Mode, Schedule>>;
  stations?: Record<string, Schedule>;
  routes?: Record<string, Schedule>;
};

type TimedStop = {
  id: string;
  mode: Mode;
  routes?: string[];
  // Set for stops served by an overnight bus or minibus route: the route is
  // still running while the mode default is closed.
  night?: boolean;
};

type Clock = { day: number; minute: number };

const defaultTimezone = "Asia/Hong_Kong";
const weekdayIndex: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

// Service hours belong to the operator's clock, not the visitor's. A browser in
// London must still grey a Hong Kong stop at 3 a.m. Hong Kong time.
export function clockAt(now: Date, timezone = defaultTimezone): Clock {
  const parts = formatterFor(timezone).formatToParts(now);
  let day = 1;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "weekday") day = weekdayIndex[part.value] ?? day;
    if (part.type === "hour") hour = Number(part.value) ?? 0;
    if (part.type === "minute") minute = Number(part.value) ?? 0;
  }
  return { day, minute: hour * 60 + minute };
}

function minutesOf(value: string): number {
  const [hour, minute] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

export function isWindowOpen(window: ServiceWindow, clock: Clock): boolean {
  const start = minutesOf(window.from);
  const end = minutesOf(window.to);
  if (end === start) return true;
  if (end > start) {
    return window.days.includes(clock.day) && clock.minute >= start && clock.minute < end;
  }
  // The window opened on the previous day and has not reached its close yet.
  const previous = clock.day === 1 ? 7 : clock.day - 1;
  return (
    (window.days.includes(clock.day) && clock.minute >= start) ||
    (window.days.includes(previous) && clock.minute < end)
  );
}

export function isScheduleOpen(schedule: Schedule, clock: Clock): boolean {
  return schedule.some((window) => isWindowOpen(window, clock));
}

// Human label for a schedule's windows, e.g. "05:50–01:00". A window that
// closes after midnight keeps its published times.
export function serviceHoursLabel(schedule: Schedule): string {
  return schedule.map((window) => `${window.from}–${window.to}`).join(", ");
}

// Resolution order: the station's own hours, then any route entry the stop
// carries, then the mode default. Routes without an entry widen the set toward
// the mode default so a gap in the static data never greys a running stop.
export function schedulesForStop(stop: TimedStop, hours: ServiceHours): Schedule[] {
  if (stop.mode === "mtr") {
    const code = stop.id.startsWith("mtr:") ? stop.id.slice(4) : "";
    const station = code ? hours.stations?.[code] : undefined;
    if (station?.length) return [station];
  }
  if (stop.routes?.length) {
    const known: Schedule[] = [];
    let missing = false;
    for (const route of stop.routes) {
      const schedule = hours.routes?.[`${stop.mode}:${route}`];
      if (schedule?.length) known.push(schedule);
      else missing = true;
    }
    const fallback = hours.modes?.[stop.mode];
    if (!missing) return known;
    return fallback?.length ? [...known, fallback] : known;
  }
  const fallback = hours.modes?.[stop.mode];
  return fallback?.length ? [fallback] : [];
}

export function isStopOpen(stop: TimedStop, hours: ServiceHours | null, now: Date): boolean {
  if (stop.night) return true;
  if (!hours) return true;
  const schedules = schedulesForStop(stop, hours);
  if (schedules.length === 0) return true;
  const clock = clockAt(now, hours.timezone || defaultTimezone);
  return schedules.some((schedule) => isScheduleOpen(schedule, clock));
}
