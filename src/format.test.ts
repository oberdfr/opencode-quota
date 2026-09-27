import { describe, expect, it } from "vitest";
import { formatReport, formatResetTime, formatWindowName } from "./format.ts";
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
