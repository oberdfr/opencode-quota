import { describe, expect, it } from "vitest";
import { parseCodexUsage } from "./codex.ts";

describe("parseCodexUsage", () => {
  it("parses the current WHAM shape", () => {
    const result = parseCodexUsage({
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 27,
          limit_window_seconds: 18000,
          reset_after_seconds: 13140,
          reset_at: 1782770922,
        },
        secondary_window: {
          used_percent: 4,
          limit_window_seconds: 604800,
          reset_at: 1783357722,
        },
      },
      credits: { has_credits: false, balance: "0" },
    });

    expect(result).toBeDefined();
    expect(result?.plan).toBe("pro");
    expect(result?.allowed).toBe(true);
    expect(result?.limitReached).toBe(false);
    // used_percent 27 means 73% remaining.
    expect(result?.primary?.remainingPercent).toBe(73);
    expect(result?.primary?.windowMinutes).toBe(300);
    expect(result?.primary?.resetTime).toBe(new Date(1782770922 * 1000).toISOString());
    expect(result?.secondary?.remainingPercent).toBe(96);
    expect(result?.secondary?.windowMinutes).toBe(10080);
    expect(result?.hasCredits).toBe(false);
    expect(result?.creditsBalance).toBe(0);
  });

  it("parses the legacy five_hour/weekly shape with percent_left", () => {
    const result = parseCodexUsage({
      rate_limit: {
        five_hour: {
          percent_left: 73.4,
          reset_time_ms: 1716393600000,
          limit_window_seconds: 18000,
        },
        weekly: {
          percent_left: 87.1,
          reset_time_ms: 1716998400000,
          limit_window_seconds: 604800,
        },
      },
    });

    expect(result?.primary?.remainingPercent).toBe(73.4);
    expect(result?.primary?.resetTime).toBe(new Date(1716393600000).toISOString());
    expect(result?.secondary?.remainingPercent).toBe(87.1);
  });

  it("parses additional rate limits from the array form", () => {
    const result = parseCodexUsage({
      plan_type: "prolite",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 81, reset_at: 1786536977 },
        secondary_window: null,
      },
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          metered_feature: "codex_bengalfox",
          rate_limit: { primary_window: { used_percent: 0, reset_at: 1786718196 } },
        },
      ],
      credits: { has_credits: false, balance: "0" },
    });

    expect(result?.secondary).toBeUndefined();
    expect(result?.primary?.remainingPercent).toBe(19);
    expect(result?.additional).toHaveLength(1);
    expect(result?.additional[0]).toMatchObject({
      id: "additional:GPT-5.3-Codex-Spark",
      label: "GPT-5.3-Codex-Spark",
      remainingPercent: 100,
    });
  });

  it("parses additional rate limits from the object form", () => {
    const result = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 10 } },
      additional_rate_limits: {
        "GPT-5.3-Codex-Spark": { primary_window: { used_percent: 50 } },
      },
    });

    expect(result?.additional[0]).toMatchObject({ label: "GPT-5.3-Codex-Spark", remainingPercent: 50 });
  });

  it("derives a reset time from reset_after_seconds when reset_at is absent", () => {
    const now = Date.now();
    const result = parseCodexUsage({
      rate_limit: { primary_window: { used_percent: 0, reset_after_seconds: 3600 } },
    });

    const reset = Date.parse(result!.primary!.resetTime!);
    expect(reset).toBeGreaterThan(now);
    expect(reset).toBeLessThanOrEqual(now + 3600 * 1000 + 1000);
  });

  it("accepts epoch milliseconds as well as seconds", () => {
    const seconds = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, reset_at: 1782770922 } } });
    const millis = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 1, reset_at: 1782770922000 } } });
    expect(seconds?.primary?.resetTime).toBe(millis?.primary?.resetTime);
  });

  it("clamps out-of-range percentages", () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 140 },
        secondary_window: { used_percent: -20 },
      },
    });

    expect(result?.primary?.remainingPercent).toBe(0);
    expect(result?.secondary?.remainingPercent).toBe(100);
  });

  it("returns undefined when no window carries a percentage", () => {
    expect(parseCodexUsage({ plan_type: "free" })).toBeUndefined();
    expect(parseCodexUsage({ rate_limit: { allowed: true } })).toBeUndefined();
    expect(parseCodexUsage(null)).toBeUndefined();
    expect(parseCodexUsage("nope")).toBeUndefined();
    expect(parseCodexUsage([])).toBeUndefined();
  });

  it("flags a reached limit", () => {
    const result = parseCodexUsage({
      rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100 } },
    });

    expect(result?.allowed).toBe(false);
    expect(result?.limitReached).toBe(true);
    expect(result?.primary?.remainingPercent).toBe(0);
  });
});
