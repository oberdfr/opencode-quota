/**
 * The window names on a row, and what they leave for the bar.
 *
 * The name is not decoration: it is the widest fixed part of a row, and every
 * character in it comes straight out of the bar beside it. "5h" says the same as
 * "5-hour" next to a countdown that already reads "4h 52m", and the three
 * characters it gives back are the difference between a bar worth looking at and
 * a smudge.
 *
 * The column is then sized to each name rather than to the longest of them, since
 * padding "5h" out to the width of "weekly" would hand the space straight back.
 */

import { describe, expect, it } from "vitest";
import { pairPlan, windowKind } from "./format.ts";

const HOUR = 60;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

const windows = (resetOffsetMs: number, id: string, label: string, percent = 100) => ({
  id,
  label,
  remainingPercent: percent,
  resetTime: new Date(NOW + resetOffsetMs).toISOString(),
});

const claude5h = () => windows(4 * 3600_000 + 59 * 60_000, "c5", "Claude · 5h");
const claudeWeekly = () => windows(6 * 86400_000 + 23 * 3600_000, "cw", "Claude · wk");

describe("the name of a window", () => {
  it("abbreviates the five-hour one", () => {
    expect(windowKind(3 * HOUR)).toBe("5h");
  });

  it("abbreviates the weekly one too", () => {
    // Six characters is a third of a bar on a terminal this narrow, and the
    // countdown beside it already says how long the window has left.
    expect(windowKind(6 * DAY)).toBe("wk");
  });

  it("names nothing when the length is neither", () => {
    // Calling a window either of the two would be a guess.
    expect(windowKind(3 * DAY)).toBeUndefined();
  });
});

describe("what the shorter name buys", () => {
  it("gives the bar more room than padding the columns to match would", () => {
    const perColumn = pairPlan([claude5h(), claudeWeekly()], NOW, 2, 18, 12, 52);
    const sharedColumn = pairPlan([claude5h(), claudeWeekly()], NOW, 6, 18, 12, 52);

    // "5h" and "wk" are both two. Sized per column the row spends four on the two
    // names; sized to the longest of the spelled-out pair it spends twelve.
    expect(perColumn?.windowWidths).toEqual([2, 2]);
    expect(perColumn?.barWidth).toBe(8);
    expect(sharedColumn?.barWidth).toBe(4);
  });

  it("still reaches the full bar on a wider terminal", () => {
    expect(pairPlan([claude5h(), claudeWeekly()], NOW, 2, 18, 12, 78)?.barWidth).toBe(12);
  });
});
