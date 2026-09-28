import { describe, expect, it } from "vitest";
import { formatReport } from "./format.ts";
import { rowWidth, formatMeta, shortReset, shortWindow } from "./format.ts";
import { parseQuotaReport } from "./rpc.ts";

/**
 * Shape captured from a live `/api/rpc/quota/report` call against real connected
 * accounts, so this guards the rendering against the payload shape the two
 * providers actually produce rather than an invented fixture. Identifiers are
 * replaced with placeholders; the values are otherwise untouched.
 */
const LIVE_RESPONSE = {
  output: {
    generatedAt: 1790537787579,
    notes: [],
    accounts: [
      {
        key: "antigravity:work@example.com",
        provider: "antigravity",
        email: "work@example.com",
        status: "ok",
        lines: [
          { id: "antigravity:gemini-pro", label: "Gemini Pro", remainingPercent: 33.5, resetTime: "2026-09-30T16:29:32Z" },
          { id: "antigravity:gemini-flash", label: "Gemini Flash", remainingPercent: 33.5, resetTime: "2026-09-30T16:29:32Z" },
          { id: "antigravity:claude", label: "Claude", remainingPercent: 0, resetTime: "2026-10-01T15:16:34Z" },
        ],
      },
      {
        key: "openai:active",
        provider: "openai",
        plan: "free",
        status: "ok",
        lines: [
          { id: "primary", label: "Primary window", remainingPercent: 73, windowMinutes: 10080, resetTime: "2026-10-27T16:54:08.000Z" },
        ],
      },
    ],
  },
};

describe("formatReport against a live response", () => {
  const report = parseQuotaReport(LIVE_RESPONSE.output);
  const output = formatReport(report);

  it("passes the live payload through the validator intact", () => {
    expect(report.accounts).toHaveLength(2);
    expect(report.accounts[0]?.lines).toHaveLength(3);
    expect(report.accounts[1]?.lines).toHaveLength(1);
    expect(report.accounts[1]?.plan).toBe("free");
  });

  it("groups the two providers under their own headings", () => {
    const lines = output.split("\n");
    const antigravityIndex = lines.indexOf("Antigravity");
    const openaiIndex = lines.indexOf("OpenAI (Codex)");

    expect(antigravityIndex).toBeGreaterThanOrEqual(0);
    expect(openaiIndex).toBeGreaterThan(antigravityIndex);
  });

  it("renders the Antigravity groups with their remaining percentages", () => {
    expect(output).toContain("work@example.com");
    expect(output).toContain("Gemini Pro: 34%");
    expect(output).toContain("Gemini Flash: 34%");
    // A spent allowance still renders, rather than being hidden.
    expect(output).toContain("Claude: 0%");
  });

  it("renders the Codex plan and window", () => {
    expect(output).toContain("active (free)");
    expect(output).toContain("Primary window: 73%, 7d window");
  });

  it("describes reset times relative to the report timestamp", () => {
    // 2026-10-27 is about 30 days after the report was generated.
    expect(output).toContain("resets in 30d");
  });
});

describe("row layout fits the dialog", () => {
  const report = parseQuotaReport(LIVE_RESPONSE.output);
  const now = report.generatedAt;
  const LABEL_WIDTH = 14;
  const BAR_WIDTH = 12;
  // The dialog is `size: "large"` with four columns of padding on each side.
  // Rows wider than the content box wrap, which previously left a fragment of
  // the bar on the following line.
  const CONTENT_BUDGET = 56;

  it("keeps every row of the live report inside the content width", () => {
    const widths = report.accounts.flatMap((account) =>
      account.lines.map((line) => ({
        label: line.label,
        width: rowWidth(line, now, LABEL_WIDTH, BAR_WIDTH),
      })),
    );

    for (const row of widths) {
      expect(row.width).toBeLessThanOrEqual(CONTENT_BUDGET);
    }
    expect(Math.max(...widths.map((row) => row.width))).toBeLessThanOrEqual(CONTENT_BUDGET);
  });

  it("keeps the label column from wasting horizontal space", () => {
    // The longest label in this report is "Primary window" at 14 characters, so
    // the column is sized to the data rather than a fixed guess.
    const longest = Math.max(
      ...report.accounts.flatMap((account) => account.lines.map((line) => line.label.length)),
    );
    expect(longest).toBe(14);
  });
});

describe("compact metadata", () => {
  const now = Date.parse("2026-09-27T12:00:00.000Z");

  it("shortens the window length and the reset distance", () => {
    expect(shortWindow(300)).toBe("5h");
    expect(shortWindow(10_080)).toBe("7d");
    expect(shortWindow(45)).toBe("45m");
    expect(shortWindow(undefined)).toBeUndefined();

    expect(shortReset(new Date(now + 3 * 86_400_000).toISOString(), now)).toBe("3d");
    expect(shortReset(new Date(now + 2 * 3_600_000).toISOString(), now)).toBe("2h");
    expect(shortReset(new Date(now - 1000).toISOString(), now)).toBe("now");
    expect(shortReset(undefined, now)).toBeUndefined();
  });

  it("joins the parts into a single trailing detail", () => {
    const meta = formatMeta(
      { id: "primary", label: "Primary window", remainingPercent: 73, windowMinutes: 10_080, resetTime: new Date(now + 30 * 86_400_000).toISOString() },
      now,
    );
    expect(meta).toBe("7d left · 30d left");
  });

  it("omits metadata entirely when the provider reports none", () => {
    expect(formatMeta({ id: "claude", label: "Claude", remainingPercent: 0 }, now)).toBeUndefined();
  });
});
