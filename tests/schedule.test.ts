import { describe, expect, it } from "vitest";
import {
  dailyCron,
  describeSchedule,
  formatTime,
  isValidTimeZone,
  localTimeToUtc,
  nextDstTransition,
  parseTime,
  utcToLocalTime,
  zoneAbbreviation,
  zoneOffsetMinutes,
} from "@/lib/schedule";

// Fixed instants either side of the 2026 European DST boundary (25 Oct 2026).
const SUMMER = new Date("2026-09-17T12:00:00Z"); // CEST, UTC+2
const WINTER = new Date("2026-12-15T12:00:00Z"); // CET,  UTC+1

describe("zoneOffsetMinutes", () => {
  it("reads Berlin's summer and winter offsets", () => {
    expect(zoneOffsetMinutes("Europe/Berlin", SUMMER)).toBe(120);
    expect(zoneOffsetMinutes("Europe/Berlin", WINTER)).toBe(60);
  });

  it("is zero for UTC and handles zones behind it", () => {
    expect(zoneOffsetMinutes("UTC", SUMMER)).toBe(0);
    expect(zoneOffsetMinutes("America/New_York", SUMMER)).toBe(-240);
  });

  it("handles a half-hour zone", () => {
    expect(zoneOffsetMinutes("Asia/Kolkata", SUMMER)).toBe(330);
  });
});

describe("localTimeToUtc", () => {
  it("converts a Berlin morning to UTC on both sides of DST", () => {
    expect(localTimeToUtc("Europe/Berlin", { hour: 8, minute: 0 }, SUMMER)).toEqual({ hour: 6, minute: 0 });
    // The same wall-clock time needs a different UTC hour once CET returns.
    expect(localTimeToUtc("Europe/Berlin", { hour: 8, minute: 0 }, WINTER)).toEqual({ hour: 7, minute: 0 });
  });

  it("preserves minutes, including in half-hour zones", () => {
    expect(localTimeToUtc("Europe/Berlin", { hour: 8, minute: 30 }, SUMMER)).toEqual({ hour: 6, minute: 30 });
    expect(localTimeToUtc("Asia/Kolkata", { hour: 9, minute: 0 }, SUMMER)).toEqual({ hour: 3, minute: 30 });
  });

  it("wraps backwards across midnight", () => {
    // 00:30 in Berlin (UTC+2) is 22:30 UTC the previous day.
    expect(localTimeToUtc("Europe/Berlin", { hour: 0, minute: 30 }, SUMMER)).toEqual({ hour: 22, minute: 30 });
  });

  it("wraps forwards across midnight for zones behind UTC", () => {
    // 21:00 in New York (UTC-4) is 01:00 UTC the next day.
    expect(localTimeToUtc("America/New_York", { hour: 21, minute: 0 }, SUMMER)).toEqual({ hour: 1, minute: 0 });
  });

  it("round-trips with utcToLocalTime", () => {
    for (const hour of [0, 6, 8, 13, 23]) {
      const utc = localTimeToUtc("Europe/Berlin", { hour, minute: 15 }, SUMMER);
      expect(utcToLocalTime("Europe/Berlin", utc, SUMMER)).toEqual({ hour, minute: 15 });
    }
  });
});

describe("utcToLocalTime", () => {
  it("explains what the current vercel.json schedule means in Berlin", () => {
    // "0 6 * * *" — what the repo ships today.
    expect(utcToLocalTime("Europe/Berlin", { hour: 6, minute: 0 }, SUMMER)).toEqual({ hour: 8, minute: 0 });
    expect(utcToLocalTime("Europe/Berlin", { hour: 6, minute: 0 }, WINTER)).toEqual({ hour: 7, minute: 0 });
  });
});

describe("nextDstTransition", () => {
  it("finds the end of European summer time in 2026", () => {
    const t = nextDstTransition("Europe/Berlin", SUMMER)!;
    expect(t).not.toBeNull();
    expect(t.at.toISOString().slice(0, 10)).toBe("2026-10-25");
    expect(t.offsetBeforeMinutes).toBe(120);
    expect(t.offsetAfterMinutes).toBe(60);
  });

  it("finds the start of the next summer time from winter", () => {
    const t = nextDstTransition("Europe/Berlin", WINTER)!;
    expect(t.at.toISOString().slice(0, 10)).toBe("2027-03-28");
    expect(t.offsetAfterMinutes).toBe(120);
  });

  it("returns null for a zone that never shifts", () => {
    expect(nextDstTransition("UTC", SUMMER)).toBeNull();
    expect(nextDstTransition("Asia/Kolkata", SUMMER)).toBeNull();
  });
});

describe("describeSchedule", () => {
  it("gives the cron for 08:00 Berlin and warns what DST will do to it", () => {
    const d = describeSchedule("Europe/Berlin", { hour: 8, minute: 0 }, SUMMER);
    expect(d.cron).toBe("0 6 * * *");
    expect(d.abbreviation).toBe("CEST");

    expect(d.drift).not.toBeNull();
    expect(d.drift!.at.toISOString().slice(0, 10)).toBe("2026-10-25");
    // Left alone, "0 6 * * *" becomes 07:00 in Berlin...
    expect(d.drift!.localAfter).toEqual({ hour: 7, minute: 0 });
    expect(d.drift!.abbreviationAfter).toBe("CET");
    // ...so holding 08:00 means moving to 07:00 UTC.
    expect(d.drift!.cronAfter).toBe("0 7 * * *");
  });

  it("reports no drift for a fixed-offset zone", () => {
    const d = describeSchedule("UTC", { hour: 6, minute: 0 }, SUMMER);
    expect(d.cron).toBe("0 6 * * *");
    expect(d.drift).toBeNull();
  });

  it("keeps non-zero minutes in the cron", () => {
    expect(describeSchedule("Europe/Berlin", { hour: 9, minute: 45 }, SUMMER).cron).toBe("45 7 * * *");
  });
});

describe("parsing and formatting", () => {
  it("round-trips a time", () => {
    expect(formatTime({ hour: 8, minute: 5 })).toBe("08:05");
    expect(parseTime("08:05")).toEqual({ hour: 8, minute: 5 });
    expect(parseTime("8:05")).toEqual({ hour: 8, minute: 5 });
  });

  it("rejects malformed or out-of-range times", () => {
    for (const bad of ["", "8", "24:00", "12:60", "-1:00", "aa:bb", "12:5"]) {
      expect(parseTime(bad)).toBeNull();
    }
  });

  it("builds a daily cron", () => {
    expect(dailyCron({ hour: 6, minute: 0 })).toBe("0 6 * * *");
    expect(dailyCron({ hour: 0, minute: 30 })).toBe("30 0 * * *");
  });

  it("validates timezone names", () => {
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("names the zone", () => {
    expect(zoneAbbreviation("Europe/Berlin", SUMMER)).toBe("CEST");
    expect(zoneAbbreviation("Europe/Berlin", WINTER)).toBe("CET");
  });
});
