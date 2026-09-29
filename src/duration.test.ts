/**
 * The remaining time on a row.
 *
 * The window is the thing being waited out, so how long it still has to run is the
 * one figure a row can add that is not already on it. Two levels of depth, always
 * the two that decide something: past a day the hours under the days, under a day
 * the minutes under the hours. Never three, and never a bare unit, because "6d"
 * cannot be planned around and "6d 21h 14m" is a third level nobody asked for.
 */

import { describe, expect, it } from "vitest";
import { describeDuration, formatMeta, shortReset } from "./format.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("the time left on a window", () => {
  it("pairs the days with the hours past a day", () => {
    // "6d" says nothing about whether the window frees up tonight or at the
    // weekend, which is the difference between starting now and waiting.
    expect(describeDuration(6 * DAY + 21 * HOUR)).toBe("6d 21h");
    expect(describeDuration(30 * DAY)).toBe("30d 0h");
    expect(describeDuration(1 * DAY + 2 * HOUR)).toBe("1d 2h");
  });

  it("pairs the hours with the minutes under a day", () => {
    // The minutes are what decide whether to start now or in a bit, and rounding
    // them to the hour throws that away.
    expect(describeDuration(4 * HOUR + 27 * MINUTE)).toBe("4h 27m");
    expect(describeDuration(2 * HOUR + 5 * MINUTE)).toBe("2h 5m");
    expect(describeDuration(1 * HOUR)).toBe("1h 0m");
  });

  it("gives minutes alone below an hour", () => {
    // There is no second level left to give, and "0h 43m" is a level of padding
    // pretending to be detail.
    expect(describeDuration(43 * MINUTE)).toBe("43m");
    expect(describeDuration(59 * MINUTE)).toBe("59m");
  });

  it("never gives a third level", () => {
    const long = describeDuration(6 * DAY + 21 * HOUR + 14 * MINUTE);
    expect(long).toBe("6d 21h");
    expect(long?.split(" ")).toHaveLength(2);
  });

  it("says now rather than a negative time", () => {
    expect(describeDuration(0)).toBe("now");
    expect(describeDuration(-1)).toBe("now");
  });

  it("reads the remaining time off a reset", () => {
    const now = Date.parse("2026-09-27T12:00:00.000Z");
    expect(shortReset(new Date(now + 4 * HOUR + 27 * MINUTE).toISOString(), now)).toBe("4h 27m");
    expect(shortReset(new Date(now + 6 * DAY + 21 * HOUR).toISOString(), now)).toBe("6d 21h");
    expect(shortReset(undefined, now)).toBeUndefined();
  });
});

describe("the trailing detail on a row", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");

  it("is the time left, on its own", () => {
    // "left" added a word to the widest part of the row and said nothing the
    // placement had not already said.
    expect(
      formatMeta(
        { id: "a", label: "Claude · 5-hour", remainingPercent: 4, resetTime: new Date(now + 2 * HOUR + 47 * MINUTE).toISOString() },
        now,
      ),
    ).toBe("2h 47m");
  });

  it("falls back to the window length only when there is no reset", () => {
    expect(formatMeta({ id: "a", label: "A", remainingPercent: 1, windowMinutes: 300 }, now)).toBe("5h window");
    expect(formatMeta({ id: "a", label: "A", remainingPercent: 1 }, now)).toBeUndefined();
  });
});
