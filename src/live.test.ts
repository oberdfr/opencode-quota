import { describe, expect, it } from "vitest";
import { formatReport } from "./format.ts";
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
