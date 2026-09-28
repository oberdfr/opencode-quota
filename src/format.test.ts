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
  pairedLayout,
  showProviderSpinner,
  splitPairedLines,
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
    expect(meta).toBe("30d left");
  });

  it("prefers the reset countdown over the window length", () => {
    // Showing both produced "30d left · 29d left", where the first number is the
    // window length and not something remaining.
    const meta = formatMeta(
      { id: "primary", label: "Primary window", remainingPercent: 73, windowMinutes: 43_200, resetTime: new Date(now + 29 * 86_400_000).toISOString() },
      now,
    );
    expect(meta).toBe("29d left");
  });

  it("degrades cleanly when only one side is known", () => {
    expect(formatMeta({ id: "a", label: "A", remainingPercent: 1, windowMinutes: 300 }, now)).toBe("5h window");
    expect(
      formatMeta({ id: "a", label: "A", remainingPercent: 1, resetTime: new Date(now + 3_600_000).toISOString() }, now),
    ).toBe("1h left");
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

describe("splitPairedLines", () => {
  it("groups consecutive paired lines and leaves the rest stacked", () => {
    const { paired, stacked } = splitPairedLines([
      { id: "a", label: "5-hour", remainingPercent: 73, paired: true },
      { id: "b", label: "Weekly", remainingPercent: 36, paired: true },
      { id: "c", label: "Credits", remainingPercent: 0 },
    ]);

    expect(paired.map((l) => l.id)).toEqual(["a", "b"]);
    expect(stacked.map((l) => l.id)).toEqual(["c"]);
  });

  it("stops grouping at the first unpaired line", () => {
    // A later paired line after a stacked one is independent, so it must not join
    // the first row and misrepresent itself as part of that budget.
    const { paired, stacked } = splitPairedLines([
      { id: "a", label: "5-hour", remainingPercent: 73, paired: true },
      { id: "b", label: "Other", remainingPercent: 10 },
      { id: "c", label: "Weekly", remainingPercent: 36, paired: true },
    ]);

    expect(paired.map((l) => l.id)).toEqual(["a"]);
    expect(stacked.map((l) => l.id)).toEqual(["b", "c"]);
  });

  it("leaves an account with no paired lines entirely stacked", () => {
    const { paired, stacked } = splitPairedLines([
      { id: "g", label: "Gemini", remainingPercent: 100 },
      { id: "c", label: "Claude", remainingPercent: 8 },
    ]);

    expect(paired).toEqual([]);
    expect(stacked).toHaveLength(2);
  });
});

describe("pairedLayout", () => {
  const FIVE_HOUR = { id: "a", label: "5-hour", remainingPercent: 73, paired: true };
  const WEEKLY = { id: "b", label: "1-week", remainingPercent: 36, paired: true };

  it("gives both columns the same label width so the bars line up", () => {
    const layout = pairedLayout([FIVE_HOUR, WEEKLY], 8, 18, 12, 72);
    expect(layout?.labelWidth).toBe(8);
  });

  it("uses the full bar when the row is wide enough", () => {
    // 8 label + 1 gap + 12 bar + 2 + "100%" + 2 + detail = 25 fixed plus the
    // bar, twice, plus the two-space gap between: 76.
    expect(pairedLayout([FIVE_HOUR, WEEKLY], 8, 18, 12, 76)?.barWidth).toBe(12);
  });

  it("narrows the bar rather than wrapping the row", () => {
    // Room for the pair, but not for a full-width bar in both.
    const layout = pairedLayout([FIVE_HOUR, WEEKLY], 8, 18, 12, 70);
    expect(layout).toBeDefined();
    expect(layout?.barWidth).toBeLessThan(12);
    expect(layout?.barWidth).toBeGreaterThanOrEqual(8);
  });

  it("refuses to pair when even the narrowest bar would not fit", () => {
    // The caller stacks instead: a wrapped pair leaves a fragment of the second
    // bar on the line below, which reads as stray output. 68 is the narrowest
    // width that still allows a bar of eight.
    expect(pairedLayout([FIVE_HOUR, WEEKLY], 8, 18, 12, 56)).toBeUndefined();
    expect(pairedLayout([FIVE_HOUR, WEEKLY], 8, 18, 12, 67)).toBeUndefined();
    expect(pairedLayout([FIVE_HOUR, WEEKLY], 8, 18, 12, 68)).toBeDefined();
  });

  it("refuses to pair three columns in a narrow dialog", () => {
    const three = [FIVE_HOUR, WEEKLY, { ...WEEKLY, id: "c", label: "Monthly" }];
    expect(pairedLayout(three, 8, 18, 12, 76)).toBeUndefined();
  });

  it("caps a long label so one name cannot push the pair out of the row", () => {
    const long = [
      { id: "a", label: "A very long window label", remainingPercent: 50, paired: true },
      WEEKLY,
    ];
    const layout = pairedLayout(long, 8, 18, 12, 200);
    expect(layout?.labelWidth).toBe(18);
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
