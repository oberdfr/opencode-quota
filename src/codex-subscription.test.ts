/**
 * Subscription accounts report two allowances that are halves of one budget: a
 * rolling five-hour window and a weekly one. These pin that both are shown, that
 * they are named after how long they actually run, and that the plan is
 * identified.
 *
 * The payload is the shape a paid account returns, built from the free
 * account's real response with the second window filled in. A free account
 * reports `secondary_window: null` and a 30-day primary, which is the case the
 * label and subscription logic has to get right too.
 */

import { describe, expect, it } from "vitest";
import { isPaidPlan, parseCodexUsage, planLabel, windowLabel } from "./codex.ts";

/** Five hours, in seconds. */
const FIVE_HOURS = 5 * 3600;
/** One week, in seconds. */
const WEEK = 7 * 24 * 3600;
/** Thirty days, in seconds. */
const THIRTY_DAYS = 30 * 24 * 3600;

const RESET_AT = 1_800_000_000;

function payload(plan: string, primarySeconds: number, secondarySeconds: number | null) {
  return {
    plan_type: plan,
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 27,
        limit_window_seconds: primarySeconds,
        reset_after_seconds: 3600,
        reset_at: RESET_AT,
      },
      secondary_window: secondarySeconds
        ? {
            used_percent: 64,
            limit_window_seconds: secondarySeconds,
            reset_after_seconds: 4 * 24 * 3600,
            reset_at: RESET_AT + 4 * 24 * 3600,
          }
        : null,
    },
    additional_rate_limits: null,
  };
}

describe("windowLabel", () => {
  it("names the rolling five-hour window", () => {
    expect(windowLabel(300, "Primary window")).toBe("5h");
  });

  it("names a weekly window in weeks", () => {
    expect(windowLabel(10_080, "Weekly window")).toBe("1-wk");
    expect(windowLabel(20_160, "Weekly window")).toBe("2-wk");
  });

  it("names a 30-day window in days instead of implying a weekly limit", () => {
    expect(windowLabel(43_200, "Primary window")).toBe("30-day");
  });

  it("keeps the caller's label when the length is unknown", () => {
    expect(windowLabel(undefined, "Primary window")).toBe("Primary window");
    expect(windowLabel(0, "Primary window")).toBe("Primary window");
  });
});

describe("plan identification", () => {
  it("treats every plan but free as a subscription", () => {
    expect(isPaidPlan("pro")).toBe(true);
    expect(isPaidPlan("plus")).toBe(true);
    expect(isPaidPlan("business")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
  });

  it("gives plans a readable name and passes unknown ones through", () => {
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("plus")).toBe("Plus");
    expect(planLabel("enterprise")).toBe("Enterprise");
    expect(planLabel("team-pro")).toBe("Team pro");
    expect(planLabel(undefined)).toBeUndefined();
  });
});

describe("a paid subscription", () => {
  const usage = parseCodexUsage(payload("pro", FIVE_HOURS, WEEK));

  it("reports both the five-hour and the weekly allowance", () => {
    expect(usage?.primary).toBeDefined();
    expect(usage?.secondary).toBeDefined();
    expect(usage?.primary?.remainingPercent).toBe(73);
    expect(usage?.secondary?.remainingPercent).toBe(36);
  });

  it("names each window after the limit it reports", () => {
    expect(usage?.primary?.label).toBe("5h");
    expect(usage?.secondary?.label).toBe("1-wk");
  });

  it("carries the plan so the view can label the account", () => {
    expect(usage?.plan).toBe("pro");
    expect(isPaidPlan(usage?.plan)).toBe(true);
  });
});

describe("a free account", () => {
  const usage = parseCodexUsage(payload("free", THIRTY_DAYS, null));

  it("has no weekly window to show", () => {
    expect(usage?.secondary).toBeUndefined();
  });

  it("names its single window for what it is", () => {
    // Reporting a 30-day allowance as "Primary window" left it looking like a
    // short window whose weekly counterpart was missing.
    expect(usage?.primary?.label).toBe("30-day");
    expect(usage?.primary?.windowMinutes).toBe(43_200);
  });

  it("is not labelled as a subscription", () => {
    expect(isPaidPlan(usage?.plan)).toBe(false);
  });
});

describe("older payload shape", () => {
  it("still labels a five-hour and a weekly window", () => {
    // The previous generation reported percent_left under five_hour/weekly with
    // the same key names for the limit length, so both windows are still named
    // from their length rather than from the slot they arrived in.
    const usage = parseCodexUsage({
      plan_type: "plus",
      rate_limit: {
        five_hour: { percent_left: 80, reset_time_ms: 1_716_393_600_000, limit_window_seconds: 18_000 },
        weekly: { percent_left: 55, reset_time_ms: 1_716_998_400_000, limit_window_seconds: 604_800 },
      },
    });

    expect(usage?.primary?.label).toBe("5h");
    expect(usage?.secondary?.label).toBe("1-wk");
    expect(usage?.secondary?.remainingPercent).toBe(55);
    expect(isPaidPlan(usage?.plan)).toBe(true);
  });

  it("keeps the caller's label when the old shape omits the limit length", () => {
    // Without a length there is nothing to name the window after, so the label it
    // arrived with stands rather than being guessed at.
    const usage = parseCodexUsage({
      rate_limit: { five_hour: { percent_left: 80 }, weekly: { percent_left: 55 } },
    });

    expect(usage?.primary?.label).toBe("Primary window");
    expect(usage?.secondary?.label).toBe("Weekly window");
  });
});

describe("the account a subscription produces", () => {
  it("is labelled with its plan and pairs the two limits", async () => {
    const { codexAccounts } = await import("./index.ts");
    const usage = parseCodexUsage(payload("pro", FIVE_HOURS, WEEK));

    const [account] = codexAccounts(usage, "me@example.com");

    expect(account?.plan).toBe("pro");
    expect(account?.subscription).toBe("Pro");
    // Both halves of the budget are marked so the view can read them side by side.
    expect(account?.lines.every((line) => line.paired)).toBe(true);
    expect(account?.lines.map((line) => line.label)).toEqual(["5h", "1-wk"]);
  });

  it("leaves a free account unlabelled with nothing to pair", async () => {
    const { codexAccounts } = await import("./index.ts");
    const usage = parseCodexUsage(payload("free", THIRTY_DAYS, null));

    const [account] = codexAccounts(usage, "me@example.com");

    expect(account?.subscription).toBeUndefined();
    expect(account?.plan).toBe("free");
    expect(account?.lines).toHaveLength(1);
  });

  it("names a Max-style plan it has never seen before", async () => {
    const { codexAccounts } = await import("./index.ts");
    const usage = parseCodexUsage(payload("chatgpt-max-20x", FIVE_HOURS, WEEK));

    const [account] = codexAccounts(usage, "me@example.com");

    // Unknown ids are passed through rather than dropped: the plan is what says
    // the account is a subscription, so losing it would hide that.
    expect(account?.subscription).toBe("Chatgpt max 20x");
  });
});
