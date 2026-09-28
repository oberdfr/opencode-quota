/**
 * What an Antigravity account is on, and which window each of its allowances
 * sits in.
 *
 * The provider reports when a window refills rather than how long it runs, and
 * the plan is read from the project's own lookup: "g1-pro-tier" for Google AI
 * Pro, "free-tier" otherwise. The practical split is the tier, since a
 * subscription account's allowances run on a five-hour window and a free one on
 * the weekly.
 */

import { describe, expect, it } from "vitest";
import type { AntigravityQuotaResult } from "./antigravity.ts";

const FIVE_HOURS = 5 * 60;
const ONE_WEEK = 7 * 24 * 60;

function account(
  overrides: Partial<AntigravityQuotaResult["accounts"][number]> = {},
): AntigravityQuotaResult {
  return {
    available: true,
    accounts: [
      {
        index: 0,
        email: "me@example.com",
        status: "ok",
        enabled: true,
        groups: [
          { id: "gemini-pro", label: "Gemini Pro", remainingPercent: 100, modelCount: 3, windowMinutes: FIVE_HOURS },
          { id: "claude", label: "Claude", remainingPercent: 8, modelCount: 2, windowMinutes: FIVE_HOURS },
        ],
        geminiCli: [],
        ...overrides,
      },
    ],
  };
}

async function map(result: AntigravityQuotaResult) {
  const { antigravityAccounts } = await import("./index.ts");
  return antigravityAccounts(result)[0];
}

describe("the plan on an Antigravity account", () => {
  it("names a Google AI Pro subscription", async () => {
    const mapped = await map(
      account({ subscription: { id: "g1-pro-tier", name: "Google AI Pro" } }),
    );

    expect(mapped?.subscription).toBe("Google AI Pro");
  });

  it("does not call the free tier a subscription", async () => {
    // The lookup reports "free-tier" for accounts without a plan. Showing that as
    // a subscription would claim every account is a paying one.
    const mapped = await map(
      account({ subscription: { id: "free-tier", name: "Antigravity Starter Quota" } }),
    );

    expect(mapped?.subscription).toBeUndefined();
  });

  it("leaves the account unlabelled when the lookup reported nothing", async () => {
    const mapped = await map(account());

    expect(mapped?.subscription).toBeUndefined();
  });
});

describe("the window on each allowance", () => {
  it("names the five-hour window a subscription account runs on", async () => {
    const mapped = await map(
      account({ subscription: { id: "g1-pro-tier", name: "Google AI Pro" } }),
    );

    expect(mapped?.lines.map((line) => line.label)).toEqual([
      "Gemini Pro · 5-hour",
      "Claude · 5-hour",
    ]);
    // Both sit in the same window, so they are set side by side.
    expect(mapped?.lines.every((line) => line.paired)).toBe(true);
  });

  it("names the weekly window a free account runs on", async () => {
    const mapped = await map(
      account({
        subscription: { id: "free-tier", name: "Antigravity Starter Quota" },
        groups: [
          { id: "gemini-pro", label: "Gemini Pro", remainingPercent: 100, modelCount: 3, windowMinutes: ONE_WEEK },
        ],
      }),
    );

    expect(mapped?.lines[0]?.label).toBe("Gemini Pro · weekly");
  });

  it("leaves the label alone when the window cannot be told", async () => {
    const mapped = await map(
      account({
        groups: [
          { id: "claude", label: "Claude", remainingPercent: 8, modelCount: 2, windowMinutes: 45 * 60 },
        ],
      }),
    );

    expect(mapped?.lines[0]?.label).toBe("Claude");
    expect(mapped?.lines[0]?.paired).toBeUndefined();
  });

  it("carries the window through so the reset countdown can be shown", async () => {
    const mapped = await map(account());

    expect(mapped?.lines.map((line) => line.windowMinutes)).toEqual([FIVE_HOURS, FIVE_HOURS]);
  });
});
