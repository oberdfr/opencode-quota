/**
 * Whether a family's two windows can be set side by side at all.
 *
 * The dialog is clipped to the terminal, so the width is whatever is there and not
 * something that can be asked for. What has to hold is that a pair is either drawn
 * in full beside itself or drawn one per row, never half of one beside half of
 * the other: a wrapped pair leaves a fragment of the second bar on the line below
 * and reads as stray output.
 *
 * The family is on the line above the pair, so the whole width is the two windows'
 * to spend, and the bar is what the layout is trying hardest to keep.
 */

import { describe, expect, it } from "vitest";
import { pairPlan, windowRows } from "./format.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

const claude5h = (id = "c5") => ({
  id,
  label: "Claude · 5-hour",
  remainingPercent: 4,
  resetTime: new Date(NOW + 2 * HOUR + 47 * 60_000).toISOString(),
});
const claudeWeekly = { id: "cw", label: "Claude · weekly", remainingPercent: 100, resetTime: new Date(NOW + 6 * DAY + 21 * HOUR).toISOString() };
const geminiWeekly = { id: "gw", label: "Gemini · weekly", remainingPercent: 99, resetTime: new Date(NOW + 6 * DAY + 18 * HOUR).toISOString() };

describe("a pair in a narrow dialog", () => {
  it("keeps a bar at 52 characters, the width of the dialog on this terminal", () => {
    // The measured width of the dialog body. The bar is the figure the row is
    // really showing, and the percentage beside it is the same number spelled out,
    // so the bar is what the layout gives up last.
    const plan = pairPlan([claude5h(), claudeWeekly], NOW, 6, 18, 12, 52);

    expect(plan).toBeDefined();
    expect(plan?.barWidth).toBeGreaterThanOrEqual(4);
  });

  it("grows the bar as the width allows", () => {
    const narrow = pairPlan([claude5h(), claudeWeekly], NOW, 6, 18, 12, 52);
    const wide = pairPlan([claude5h(), claudeWeekly], NOW, 6, 18, 12, 88);

    expect(wide?.barWidth).toBeGreaterThan(narrow?.barWidth ?? 0);
    expect(wide?.barWidth).toBe(12);
  });

  it("sizes the window column to the names it holds", () => {
    const plan = pairPlan([claude5h(), claudeWeekly], NOW, 6, 18, 12, 88);

    // "5-hour" and "weekly" are both six. Padding past that is width thrown away,
    // and on a narrow terminal that width is the bar.
    expect(plan?.windowWidth).toBe(6);
  });

  it("measures the detail it will really print", () => {
    // A long countdown is what a pair is read for, and reserving room for the
    // longest one that could ever appear cost a bar on every account whose
    // countdowns are ordinary.
    const long = pairPlan(
      [{ ...claude5h(), resetTime: new Date(NOW + 20 * DAY + 14 * HOUR).toISOString() }, claudeWeekly],
      NOW,
      6,
      18,
      12,
      52,
    );
    const short = pairPlan([claude5h(), claudeWeekly], NOW, 6, 18, 12, 52);

    expect(long?.barWidth).toBeLessThan(short?.barWidth ?? 12);
  });

  it("drops a bar too narrow to read rather than drawing a smudge", () => {
    // One or two filled cells is not a bar, it is what a bar looks like when
    // something has gone wrong, and a percentage beside it would be believed.
    const plan = pairPlan([claude5h(), claudeWeekly], NOW, 6, 18, 12, 44);

    expect(plan?.barWidth).toBe(0);
  });

  it("gives up rather than drawing a pair that does not fit", () => {
    // Below the barless form there is nothing left to drop that would still be a
    // readable pair, and a wrapped one is worse than two rows.
    expect(pairPlan([claude5h(), claudeWeekly], NOW, 6, 18, 12, 30)).toBeUndefined();
  });

  it("will not put two different families in one row", () => {
    // A row whose columns are different budgets is not a pair of one budget, and
    // a single family heading above it would mislabel one of them.
    expect(pairPlan([claude5h(), geminiWeekly], NOW, 6, 18, 12, 88)).toBeUndefined();
  });

  it("refuses a line with no window to name", () => {
    // An allowance the provider does not put in a window cannot be paired, since
    // the row would have nothing to tell the two columns apart by.
    expect(
      pairPlan([{ id: "c", label: "Claude", remainingPercent: 5 }, claudeWeekly], NOW, 6, 18, 12, 88),
    ).toBeUndefined();
  });

  it("does not pair a single line", () => {
    expect(pairPlan([claudeWeekly], NOW, 6, 18, 12, 88)).toBeUndefined();
  });
});

describe("pairing what an account reports", () => {
  it("pairs a subscription account's two windows for each family", () => {
    const rows = windowRows([
      claude5h(),
      claudeWeekly,
      { id: "g5", label: "Gemini · 5-hour", remainingPercent: 98 },
      geminiWeekly,
    ]);

    expect(rows.map((row) => row.map((line) => line.id))).toEqual([
      ["g5", "gw"],
      ["c5", "cw"],
    ]);
  });

  it("reads Gemini before Claude however the provider ordered them", () => {
    // The provider hands back families in the order its buckets arrived in, which
    // is not a reading order: an account whose Claude buckets happened to come
    // first would show Claude first, and swap places on the next refresh.
    const rows = windowRows([claude5h(), claudeWeekly, geminiWeekly]);

    expect(rows.map((row) => row[0]?.id)).toEqual(["gw", "c5"]);
  });

  it("keeps a family with one window on its own", () => {
    // A free account has only the weekly allowance, so there is nothing to pair it
    // with and it is not padded out to look like it is missing a window.
    const rows = windowRows([{ id: "c", label: "Claude", remainingPercent: 6 }, geminiWeekly]);

    expect(rows.map((row) => row.map((line) => line.id))).toEqual([["gw"], ["c"]]);
  });
});
