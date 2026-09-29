import { describe, expect, it } from "vitest";
import { bold, isStyledText, StyledText } from "@opentui/core";
import {
  formatBar,
  formatLabel,
  formatMeta,
  formatReport,
  formatResetTime,
  formatWindowName,
  mergeGeminiAllowances,
  quotaTone,
  showProviderSpinner,
  windowRows,
  strong,
  windowKind,
} from "./format.ts";
import { parseQuotaReport } from "./rpc.ts";
import type { QuotaReport } from "./rpc.ts";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const HOUR = 3_600_000;

const report: QuotaReport = {
  generatedAt: NOW,
  notes: [],
  accounts: [
    {
      key: "antigravity:work@example.com",
      provider: "antigravity",
      email: "work@example.com",
      status: "ok",
      lines: [
        { id: "antigravity:claude", label: "Claude", remainingPercent: 42.5, resetTime: new Date(NOW + 2 * HOUR).toISOString() },
        { id: "gemini-cli:gemini-3-pro-preview", label: "Gemini CLI · gemini-3-pro-preview", remainingPercent: 80 },
      ],
    },
    {
      key: "openai:me@example.com",
      provider: "openai",
      email: "me@example.com",
      plan: "pro",
      status: "ok",
      lines: [{ id: "primary", label: "Primary window", remainingPercent: 73, windowMinutes: 300 }],
    },
  ],
};

describe("formatResetTime", () => {
  it("describes minutes, hours, and days", () => {
    expect(formatResetTime(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe("resets in 30m");
    expect(formatResetTime(new Date(NOW + 3 * HOUR).toISOString(), NOW)).toBe("resets in 3h");
    expect(formatResetTime(new Date(NOW + 50 * HOUR).toISOString(), NOW)).toBe("resets in 2d");
  });

  it("handles past and unparseable timestamps", () => {
    expect(formatResetTime(new Date(NOW - 1000).toISOString(), NOW)).toBe("resetting now");
    expect(formatResetTime("not-a-date", NOW)).toBeUndefined();
    expect(formatResetTime(undefined, NOW)).toBeUndefined();
  });
});

describe("formatWindowName", () => {
  it("names hour and day windows", () => {
    expect(formatWindowName(300)).toBe("5h window");
    expect(formatWindowName(10_080)).toBe("7d window");
    expect(formatWindowName(45)).toBe("45m window");
    expect(formatWindowName(undefined)).toBeUndefined();
  });
});

describe("formatReport", () => {
  it("groups accounts by provider and shows percentages", () => {
    const output = formatReport(report);

    expect(output).toContain("Antigravity");
    expect(output).toContain("work@example.com");
    expect(output).toContain("Claude: 43%, resets in 2h");
    expect(output).toContain("Gemini CLI · gemini-3-pro-preview: 80%");
    expect(output).toContain("OpenAI (Codex)");
    expect(output).toContain("me@example.com (pro)");
    expect(output).toContain("Primary window: 73%, 5h window");
  });

  it("marks disabled and errored accounts", () => {
    const output = formatReport({
      generatedAt: NOW,
      notes: [],
      accounts: [
        { key: "antigravity:a", provider: "antigravity", email: "a@example.com", status: "disabled", lines: [] },
        { key: "antigravity:b", provider: "antigravity", email: "b@example.com", status: "error", error: "token refresh failed", lines: [] },
      ],
    });

    expect(output).toContain("disabled");
    expect(output).toContain("error: token refresh failed");
  });

  it("reports an empty report with its notes", () => {
    const output = formatReport({ generatedAt: NOW, accounts: [], notes: ["OpenAI: no account connected"] });

    expect(output).toContain("No quota data available.");
    expect(output).toContain("OpenAI: no account connected");
  });

  it("appends notes below the accounts", () => {
    const output = formatReport({ ...report, notes: ["Antigravity: plugin not loaded"] });
    expect(output).toContain("note: Antigravity: plugin not loaded");
  });

  it("falls back to a readable name when no email is present", () => {
    const output = formatReport({
      generatedAt: NOW,
      notes: [],
      accounts: [{ key: "openai:active", provider: "openai", status: "ok", lines: [] }],
    });

    expect(output).toContain("active");
  });
});

describe("parseQuotaReport", () => {
  it("accepts a well-formed payload", () => {
    const parsed = parseQuotaReport({
      generatedAt: NOW,
      notes: ["a note"],
      accounts: [
        {
          key: "antigravity:x",
          provider: "antigravity",
          status: "ok",
          lines: [{ id: "claude", label: "Claude", remainingPercent: 50 }],
        },
      ],
    });

    expect(parsed.generatedAt).toBe(NOW);
    expect(parsed.notes).toEqual(["a note"]);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]?.lines[0]?.remainingPercent).toBe(50);
  });

  it("drops malformed accounts and lines rather than trusting them", () => {
    const parsed = parseQuotaReport({
      generatedAt: NOW,
      notes: [1, "keep", null],
      accounts: [
        { key: "a", provider: "antigravity", status: "ok", lines: [{ id: "x", label: "X" }, { bad: true }] },
        { key: "b", provider: "not-a-provider", status: "ok", lines: [] },
        { provider: "openai", status: "ok", lines: [] },
        "garbage",
      ],
    });

    expect(parsed.notes).toEqual(["keep"]);
    expect(parsed.accounts).toHaveLength(1);
    // The first line lacks remainingPercent, so it is discarded.
    expect(parsed.accounts[0]?.lines).toHaveLength(0);
  });

  it("defaults an unknown status to error", () => {
    const parsed = parseQuotaReport({
      generatedAt: NOW,
      notes: [],
      accounts: [{ key: "a", provider: "openai", status: "weird", lines: [] }],
    });

    expect(parsed.accounts[0]?.status).toBe("error");
  });

  it("produces an empty report for junk input", () => {
    for (const junk of [null, undefined, "text", 42, []]) {
      const parsed = parseQuotaReport(junk);
      expect(parsed.accounts).toEqual([]);
      expect(parsed.notes).toEqual([]);
      expect(Number.isFinite(parsed.generatedAt)).toBe(true);
    }
  });
});

describe("quotaTone", () => {
  it("bands the remaining percentage", () => {
    expect(quotaTone(100)).toBe("ok");
    expect(quotaTone(50)).toBe("ok");
    expect(quotaTone(49.9)).toBe("warn");
    expect(quotaTone(20)).toBe("warn");
    expect(quotaTone(19.9)).toBe("critical");
    expect(quotaTone(0)).toBe("spent");
    expect(quotaTone(-5)).toBe("spent");
  });
});

describe("formatBar", () => {
  it("fills proportionally to the percentage", () => {
    expect(formatBar(100, 10)).toBe("█".repeat(10));
    expect(formatBar(0, 10)).toBe("░".repeat(10));
    expect(formatBar(50, 10)).toBe("█".repeat(5) + "░".repeat(5));
  });

  it("always renders the requested width", () => {
    for (const pct of [0, 1, 33, 66, 99, 100]) {
      expect(formatBar(pct, 20)).toHaveLength(20);
    }
  });

  it("clamps values a provider could get wrong", () => {
    expect(formatBar(150, 4)).toBe("█".repeat(4));
    expect(formatBar(-20, 4)).toBe("░".repeat(4));
    expect(formatBar(Number.NaN, 4)).toBe("░".repeat(4));
  });
});

describe("formatLabel", () => {
  it("pads short labels and truncates only genuine overflow", () => {
    expect(formatLabel("Claude", 10)).toBe("Claude    ");
    expect(formatLabel("A very long label indeed", 10)).toBe("A very lo…");
  });

  it("does not truncate a label that exactly fills the column", () => {
    // "Primary window" is 14 characters, which is the widest label the Codex
    // report produces; truncating here produced "Primary windo…".
    expect(formatLabel("Primary window", 14)).toBe("Primary window");
    expect(formatLabel("Primary window", 14)).toHaveLength(14);
  });
});

describe("formatMeta", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");

  it("shows one value when the window and the reset countdown agree", () => {
    // A Codex plan measured from its last reset: a 30-day window resetting in
    // 30 days used to render as "30d left · 30d left".
    const meta = formatMeta(
      { id: "primary", label: "Primary window", remainingPercent: 73, windowMinutes: 43_200, resetTime: new Date(now + 30 * 86_400_000).toISOString() },
      now,
    );
    expect(meta).toBe("30d 0h");
  });

  it("prefers the reset countdown over the window length", () => {
    // Showing both produced "30d left · 29d left", where the first number is the
    // window length and not something remaining.
    const meta = formatMeta(
      { id: "primary", label: "Primary window", remainingPercent: 73, windowMinutes: 43_200, resetTime: new Date(now + 29 * 86_400_000).toISOString() },
      now,
    );
    expect(meta).toBe("29d 0h");
  });

  it("degrades cleanly when only one side is known", () => {
    expect(formatMeta({ id: "a", label: "A", remainingPercent: 1, windowMinutes: 300 }, now)).toBe("5h window");
    expect(
      formatMeta({ id: "a", label: "A", remainingPercent: 1, resetTime: new Date(now + 3_600_000).toISOString() }, now),
    ).toBe("1h 0m");
    expect(formatMeta({ id: "a", label: "A", remainingPercent: 1 }, now)).toBeUndefined();
  });
});

describe("mergeGeminiAllowances", () => {
  const claude = { id: "antigravity:claude", label: "Claude", remainingPercent: 12 };
  const pro = { id: "antigravity:gemini-pro", label: "Gemini Pro", remainingPercent: 34, resetTime: "2026-09-30T16:29:32Z" };
  const flash = { id: "antigravity:gemini-flash", label: "Gemini Flash", remainingPercent: 34, resetTime: "2026-09-29T10:00:00Z" };

  it("collapses Pro and Flash into one Gemini line", () => {
    const merged = mergeGeminiAllowances([claude, pro, flash]);

    expect(merged.map((line) => line.label)).toEqual(["Claude", "Gemini"]);
    expect(merged[1]).toMatchObject({ id: "antigravity:gemini", label: "Gemini", remainingPercent: 34 });
  });

  it("keeps the lower allowance and the sooner reset", () => {
    const merged = mergeGeminiAllowances([
      { ...pro, remainingPercent: 34 },
      { ...flash, remainingPercent: 9, resetTime: "2026-09-28T10:00:00Z" },
    ]);

    expect(merged[0]?.remainingPercent).toBe(9);
    expect(merged[0]?.resetTime).toBe("2026-09-28T10:00:00Z");
  });

  it("takes the position of the first Gemini line", () => {
    const merged = mergeGeminiAllowances([flash, claude, pro]);
    expect(merged.map((line) => line.label)).toEqual(["Gemini", "Claude"]);
  });

  it("passes other providers and lone Gemini lines through untouched", () => {
    const codex = { id: "primary", label: "Primary window", remainingPercent: 73 };
    expect(mergeGeminiAllowances([codex])).toEqual([codex]);
    // Only one of the two present: nothing to merge, so it is left alone.
    expect(mergeGeminiAllowances([pro])).toEqual([pro]);
  });

  it("does not mutate its input", () => {
    const input = [claude, pro, flash];
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeGeminiAllowances(input);
    expect(input).toEqual(snapshot);
  });
});

describe("strong", () => {
  it("produces a value the text renderable accepts", () => {
    // `TextNodeRenderable.add` throws on anything that is not a string, another
    // renderable, or a StyledText, and that throw only happens at render time,
    // so this is the check that keeps it from reaching the TUI.
    expect(isStyledText(strong("r"))).toBe(true);
  });

  it("keeps the bold attribute on the wrapped chunk", () => {
    const [chunk] = new StyledText([bold("r")]).chunks;
    const [wrapped] = new StyledText([bold("r")]).chunks;

    expect(wrapped?.text).toBe("r");
    expect(wrapped?.attributes).toBe(chunk?.attributes);
    expect(wrapped?.attributes).toBeGreaterThan(0);
  });

  it("is why the bare bold chunk cannot be used directly", () => {
    // Documents the trap: the chunk is what `bold` returns, and it is not
    // something `add` accepts on its own.
    expect(isStyledText(bold("r"))).toBeFalsy();
  });
});

describe("showProviderSpinner", () => {
  it("stays off before the first report, where the body already shows a bar", () => {
    // Two bars appeared for one request: the title drew one and the section body
    // drew its own "fetching…" bar.
    expect(showProviderSpinner(true, false)).toBe(false);
  });

  it("shows a small marker once there are numbers to keep on screen", () => {
    expect(showProviderSpinner(true, true)).toBe(true);
  });

  it("is off when nothing is in flight", () => {
    expect(showProviderSpinner(false, false)).toBe(false);
    expect(showProviderSpinner(false, true)).toBe(false);
  });
});

describe("windowRows", () => {
  it("sets a family's five-hour and weekly windows side by side", () => {
    // A subscription account runs on both at once, and a nearly spent five-hour
    // window beside an untouched weekly one says something neither row can alone.
    const rows = windowRows([
      { id: "c5", label: "Claude · 5-hour", remainingPercent: 4 },
      { id: "cw", label: "Claude · weekly", remainingPercent: 100 },
      { id: "g5", label: "Gemini · 5-hour", remainingPercent: 98 },
      { id: "gw", label: "Gemini · weekly", remainingPercent: 100 },
    ]);

    // Gemini reads before Claude, whatever order the provider handed them over in.
    expect(rows.map((row) => row.map((line) => line.id))).toEqual([
      ["g5", "gw"],
      ["c5", "cw"],
    ]);
  });

  it("gives each family its own row rather than interleaving them", () => {
    // Windows arrive grouped by window rather than by family, so pairing has to
    // follow the family. Pairing the two five-hour windows instead would put two
    // different budgets on one row and read as one budget with two figures.
    const rows = windowRows([
      { id: "c5", label: "Claude · 5-hour", remainingPercent: 4 },
      { id: "g5", label: "Gemini · 5-hour", remainingPercent: 98 },
      { id: "cw", label: "Claude · weekly", remainingPercent: 100 },
      { id: "gw", label: "Gemini · weekly", remainingPercent: 100 },
    ]);

    expect(rows.map((row) => row.map((line) => line.id))).toEqual([
      ["g5", "gw"],
      ["c5", "cw"],
    ]);
  });

  it("leaves a family with a single window on its own row", () => {
    // A free account only has the weekly one, so it has nothing to pair with and
    // the row is not padded out to look like it is missing something.
    const rows = windowRows([
      { id: "g", label: "Gemini · weekly", remainingPercent: 100 },
      { id: "c", label: "Claude", remainingPercent: 6 },
    ]);

    expect(rows.map((row) => row.map((line) => line.id))).toEqual([["g"], ["c"]]);
  });

  it("keeps a third window of the same family on a row of its own", () => {
    const rows = windowRows([
      { id: "a", label: "Zeta · 5-hour", remainingPercent: 4 },
      { id: "b", label: "Zeta · weekly", remainingPercent: 100 },
      { id: "c", label: "Zeta · monthly", remainingPercent: 50 },
    ]);

    expect(rows.map((row) => row.map((line) => line.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("takes the provider's own pairing for lines it marks", () => {
    // Codex marks its two windows as a pair, and that is how it knows they belong
    // together, so the labels say nothing about it.
    const rows = windowRows([
      { id: "p", label: "Primary window", remainingPercent: 73, paired: true },
      { id: "s", label: "Secondary window", remainingPercent: 36, paired: true },
    ]);

    expect(rows.map((row) => row.map((line) => line.id))).toEqual([["p", "s"]]);
  });
});


describe("windowKind", () => {
  it("names a five-hour window from the hours left on it", () => {
    // A rolling five-hour window cannot have more than five hours left.
    expect(windowKind(60)).toBe("5-hour");
    expect(windowKind(300)).toBe("5-hour");
    expect(windowKind(6 * 60)).toBe("5-hour");
  });

  it("names the weekly window from the days left on it", () => {
    expect(windowKind(5 * 24 * 60)).toBe("weekly");
    expect(windowKind(7 * 24 * 60)).toBe("weekly");
    expect(windowKind(166 * 60)).toBe("weekly");
  });

  it("leaves a window unnamed when the remaining time fits neither", () => {
    // Calling a 45-hour allowance either would be a guess.
    expect(windowKind(45 * 60)).toBeUndefined();
    expect(windowKind(7 * 60)).toBeUndefined();
  });

  it("has nothing to say without a reset time", () => {
    expect(windowKind(undefined)).toBeUndefined();
    expect(windowKind(0)).toBeUndefined();
  });
});
