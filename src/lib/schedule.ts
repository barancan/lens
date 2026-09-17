/**
 * Converting an operator's local wall-clock time into the UTC cron expression
 * Vercel needs.
 *
 * Vercel's cron schedules live in `vercel.json`, are always interpreted as UTC,
 * and are read at deploy time — so they cannot follow a timezone that observes
 * daylight saving. A schedule that means 08:00 in Berlin today means 07:00
 * there once CEST ends. These helpers make that conversion explicit, and make
 * the drift visible before it happens rather than after.
 *
 * Pure and dependency-free: all zone handling is done through `Intl`.
 */

export interface LocalTime {
  hour: number;
  minute: number;
}

/** Offset of `timeZone` from UTC, in minutes, at a given instant. */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  // Some locales render midnight as hour 24; normalise it.
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date currently showing in `timeZone`. */
function dateInZone(timeZone: string, at: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * The UTC time at which a given local wall-clock time occurs, on the day
 * `reference` falls in. Resolved twice because the offset itself depends on the
 * instant — the first guess picks the right side of a transition.
 */
export function localTimeToUtc(timeZone: string, local: LocalTime, reference: Date = new Date()): LocalTime {
  const { year, month, day } = dateInZone(timeZone, reference);
  const wallClock = Date.UTC(year, month - 1, day, local.hour, local.minute);
  const firstGuess = wallClock - zoneOffsetMinutes(timeZone, reference) * 60_000;
  const resolved = new Date(wallClock - zoneOffsetMinutes(timeZone, new Date(firstGuess)) * 60_000);
  return { hour: resolved.getUTCHours(), minute: resolved.getUTCMinutes() };
}

/** The local wall-clock time a UTC cron time lands on, on the day of `reference`. */
export function utcToLocalTime(timeZone: string, utc: LocalTime, reference: Date = new Date()): LocalTime {
  const { year, month, day } = dateInZone("UTC", reference);
  const instant = new Date(Date.UTC(year, month - 1, day, utc.hour, utc.minute));
  const shifted = new Date(instant.getTime() + zoneOffsetMinutes(timeZone, instant) * 60_000);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

/** A daily cron expression, e.g. `30 6 * * *`. */
export function dailyCron(utc: LocalTime): string {
  return `${utc.minute} ${utc.hour} * * *`;
}

export function formatTime({ hour, minute }: LocalTime): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseTime(value: string): LocalTime | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** The zone's abbreviation at an instant, e.g. "CEST". */
export function zoneAbbreviation(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, timeZoneName: "short" }).formatToParts(at);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

export interface DstTransition {
  /** The instant the offset changes. */
  at: Date;
  offsetBeforeMinutes: number;
  offsetAfterMinutes: number;
}

/**
 * The next offset change in `timeZone` after `from`, or null if the zone has
 * none in the search window (a year and a bit, so an annual cycle is covered).
 *
 * Scans day by day, then narrows to the hour — enough precision to name the
 * date, which is all the operator needs.
 */
export function nextDstTransition(timeZone: string, from: Date = new Date(), searchDays = 400): DstTransition | null {
  const DAY = 86_400_000;
  let previous = from;
  let previousOffset = zoneOffsetMinutes(timeZone, previous);

  for (let i = 1; i <= searchDays; i++) {
    const probe = new Date(from.getTime() + i * DAY);
    const offset = zoneOffsetMinutes(timeZone, probe);
    if (offset !== previousOffset) {
      // Narrow to the hour within the day that changed.
      let lo = previous.getTime();
      let hi = probe.getTime();
      while (hi - lo > 3_600_000) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (zoneOffsetMinutes(timeZone, new Date(mid)) === previousOffset) lo = mid;
        else hi = mid;
      }
      return { at: new Date(hi), offsetBeforeMinutes: previousOffset, offsetAfterMinutes: offset };
    }
    previous = probe;
    previousOffset = offset;
  }
  return null;
}

export interface ScheduleConversion {
  /** What to put in `vercel.json` today. */
  cron: string;
  utc: LocalTime;
  /** Zone abbreviation now, e.g. "CEST". */
  abbreviation: string;
  /** Null when the zone has no upcoming transition (e.g. UTC). */
  drift: {
    at: Date;
    /** What the unchanged cron will mean locally after the transition. */
    localAfter: LocalTime;
    abbreviationAfter: string;
    /** The cron to switch to in order to hold the intended local time. */
    cronAfter: string;
  } | null;
}

/**
 * Everything the Settings panel needs: the cron for the intended local time,
 * and — if the zone shifts within the year — when it will drift, to what, and
 * the replacement cron that restores the intended time.
 */
export function describeSchedule(timeZone: string, local: LocalTime, now: Date = new Date()): ScheduleConversion {
  const utc = localTimeToUtc(timeZone, local, now);
  const transition = nextDstTransition(timeZone, now);

  if (!transition) {
    return { cron: dailyCron(utc), utc, abbreviation: zoneAbbreviation(timeZone, now), drift: null };
  }

  // A day past the transition, so the new offset is firmly in effect.
  const after = new Date(transition.at.getTime() + 86_400_000);
  return {
    cron: dailyCron(utc),
    utc,
    abbreviation: zoneAbbreviation(timeZone, now),
    drift: {
      at: transition.at,
      localAfter: utcToLocalTime(timeZone, utc, after),
      abbreviationAfter: zoneAbbreviation(timeZone, after),
      cronAfter: dailyCron(localTimeToUtc(timeZone, local, after)),
    },
  };
}
