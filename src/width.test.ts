/**
 * Whether a family's two windows can be set side by side at all.
 *
 * The dialog is clipped to the terminal, so the width is whatever is there and not
 * something that can be asked for. What has to hold is that a pair is either drawn
 * in full beside itself or drawn one per row, never half of one beside half of
 * the other: a wrapped pair leaves a fragment of the second bar on the line below
 * and reads as stray output.
 */

import { describe, expect, it } from "vitest";
import { pairPlan, windowRows } from "./format.ts";

const CLAUDE_5H = { id: "c5", label: "Claude · 5-hour", remainingPercent: 4 };
const CLAUDE_WEEKLY = { id: "cw", label: "Claude · weekly", remainingPercent: 100 };
const GEMINI_5H = { id: "g5", label: "Gemini · 5-hour", remainingPercent: 98 };
const GEMINI_WEEKLY = { id: "gw", label: "Gemini · weekly", remainingPercent: 100 };

describe("a pair in a narrow dialog", () => {
  it("fits both windows in 52 characters once the bar gives way", () => {
    // The measured width of the dialog body on a 62-column terminal. A family name
    // repeated on both columns does not fit there, so it moves to a column of its
    // own and the bar is what has to go: the percentage is the same figure, and a
    // missing bar reads as less alarming than a row that does not fit.
    const plan = pairPlan([CLAUDE_5H, CLAUDE_WEEKLY], 6, 18, 12, 52);

    expect(plan).toBeDefined();
    expect(plan?.familyWidth).toBe(6);
    expect(plan?.windowWidth).toBe(6);
    expect(plan?.barWidth).toBe(0);
  });

  it("keeps a bar when the width is there for one", () => {
    const plan = pairPlan([CLAUDE_5H, CLAUDE_WEEKLY], 6, 18, 12, 88);

    expect(plan?.barWidth).toBeGreaterThan(0);
  });

  it("drops a bar too narrow to read rather than drawing a smudge", () => {
    // One or two filled cells is not a bar, it is what a bar looks like when
    // something has gone wrong, and a percentage beside it would be believed.
    const plan = pairPlan([CLAUDE_5H, CLAUDE_WEEKLY], 6, 18, 12, 62);

    expect(plan?.barWidth).toBe(0);
  });

  it("gives up rather than drawing a pair that does not fit", () => {
    // Below the barless form there is nothing left to drop that would still be a
    // readable pair, and a wrapped one is worse than two rows.
    expect(pairPlan([CLAUDE_5H, CLAUDE_WEEKLY], 6, 18, 12, 30)).toBeUndefined();
  });

  it("will not put two different families in one row", () => {
    // A row whose columns are different budgets is not a pair of one budget, and
    // a single family column would mislabel one of them.
    expect(pairPlan([CLAUDE_5H, GEMINI_WEEKLY], 6, 18, 12, 88)).toBeUndefined();
  });

  it("refuses a line with no window to name", () => {
    // An allowance the provider does not put in a window cannot be paired, since
    // the row would have nothing to tell the two columns apart by.
    expect(
      pairPlan([{ id: "c", label: "Claude", remainingPercent: 5 }, CLAUDE_WEEKLY], 6, 18, 12, 88),
    ).toBeUndefined();
  });

  it("does not pair a single line", () => {
    expect(pairPlan([CLAUDE_WEEKLY], 6, 18, 12, 88)).toBeUndefined();
  });
});

describe("pairing what an account reports", () => {
  it("pairs a subscription account's two windows for each family", () => {
    const rows = windowRows([CLAUDE_5H, CLAUDE_WEEKLY, GEMINI_5H, GEMINI_WEEKLY]);

    expect(rows.map((row) => row.map((line) => line.id))).toEqual([
      ["c5", "cw"],
      ["g5", "gw"],
    ]);
  });
});
