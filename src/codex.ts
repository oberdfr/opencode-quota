/**
 * OpenAI (Codex / ChatGPT plan) quota.
 *
 * ChatGPT OAuth accounts expose quota through the WHAM usage endpoint, which is
 * the same source the official Codex client polls. There is no public quota API
 * and the payload has changed shape across releases, so the parser below accepts
 * every shape we have observed rather than assuming one.
 *
 * The endpoint is undocumented and private. Treat a parse failure as "no data"
 * rather than an error: the account may still be usable.
 */

const USAGE_ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage",
  "https://chatgpt.com/backend-api/codex/usage",
] as const;

const FETCH_TIMEOUT_MS = 10_000;

export interface CodexWindow {
  id: string;
  label: string;
  remainingPercent: number;
  resetTime?: string;
  windowMinutes?: number;
}

export interface CodexUsage {
  plan?: string;
  allowed?: boolean;
  limitReached?: boolean;
  primary?: CodexWindow;
  secondary?: CodexWindow;
  additional: CodexWindow[];
  creditsBalance?: number;
  hasCredits?: boolean;
}

export interface CodexCredential {
  accessToken: string;
  accountId?: string;
  label?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.round(Math.min(Math.max(value, 0), 100) * 10) / 10;
}

/** Normalises an epoch timestamp in seconds, milliseconds, or an ISO string. */
function toIsoTime(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return undefined;
  }

  const numeric = asNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;

  // Values below ~1e11 are seconds; above that they are milliseconds. Both
  // appear in the wild, and 1e11 seconds is the year 5138, so the split is safe.
  const millis = numeric < 1e11 ? numeric * 1000 : numeric;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function toWindowMinutes(value: unknown): number | undefined {
  const seconds = asNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return Math.round(seconds / 60);
}

interface WindowInput {
  id: string;
  label: string;
  usedPercent?: number;
  percentLeft?: number;
  resetAt?: unknown;
  resetAfterSeconds?: unknown;
  resetTimeMs?: unknown;
  limitWindowSeconds?: unknown;
}

/**
 * Builds one allowance line from either schema generation.
 *
 * The current shape reports `used_percent` plus `reset_at` in epoch seconds; the
 * older shape reports `percent_left` plus `reset_time_ms` and used different
 * window names.
 */
function toWindow(input: WindowInput): CodexWindow | undefined {
  const remaining =
    input.percentLeft !== undefined
      ? clampPercent(input.percentLeft)
      : input.usedPercent !== undefined
        ? clampPercent(100 - input.usedPercent)
        : undefined;

  if (remaining === undefined) return undefined;

  const resetTime =
    toIsoTime(input.resetAt) ??
    toIsoTime(input.resetTimeMs) ??
    toIsoTime(
      asNumber(input.resetAfterSeconds) !== undefined && asNumber(input.resetAfterSeconds)! > 0
        ? Date.now() + (asNumber(input.resetAfterSeconds) as number) * 1000
        : undefined,
    );

  return {
    id: input.id,
    label: input.label,
    remainingPercent: remaining,
    ...(resetTime ? { resetTime } : {}),
    ...(toWindowMinutes(input.limitWindowSeconds) !== undefined
      ? { windowMinutes: toWindowMinutes(input.limitWindowSeconds) as number }
      : {}),
  };
}

function readWindow(
  rateLimit: Record<string, unknown>,
  keys: string[],
  id: string,
  label: string,
): CodexWindow | undefined {
  for (const key of keys) {
    const raw = asRecord(rateLimit[key]);
    if (!raw) continue;
    const window = toWindow({
      id,
      label,
      usedPercent: asNumber(raw.used_percent ?? raw.usedPercent),
      percentLeft: asNumber(raw.percent_left ?? raw.percentLeft),
      resetAt: raw.reset_at ?? raw.resetAt,
      resetAfterSeconds: raw.reset_after_seconds ?? raw.resetAfterSeconds,
      resetTimeMs: raw.reset_time_ms ?? raw.resetTimeMs,
      limitWindowSeconds: raw.limit_window_seconds ?? raw.limitWindowSeconds,
    });
    if (window) return window;
  }
  return undefined;
}

const PRIMARY_KEYS = ["primary_window", "primaryWindow", "five_hour", "fiveHour"];
const SECONDARY_KEYS = ["secondary_window", "secondaryWindow", "weekly"];

/** A rolling five-hour window, the one every paid plan reports. */
const FIVE_HOUR_MINUTES = 300;
/** A calendar week, the allowance that runs alongside it on a paid plan. */
const WEEK_MINUTES = 10_080;

/**
 * Names a window after how long it actually runs.
 *
 * The endpoint does not name its windows and which ones exist depends on the
 * plan: a free account reports one 30-day window, a paid one also reports a
 * 5-hour and a weekly allowance. Naming from the reported length means the row
 * describes itself instead of guessing, and a free account's lone window reads
 * "30-day" rather than implying a weekly limit it does not have.
 */
export function windowLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes || minutes <= 0) return fallback;
  if (minutes === FIVE_HOUR_MINUTES) return "5h";
  if (minutes % WEEK_MINUTES === 0) return `${Math.round(minutes / WEEK_MINUTES)}-week`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${Math.round(minutes / 60)}-hour`;
  return fallback;
}

/** Friendly names for the plan ids the endpoint reports. */
const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  business: "Business",
  enterprise: "Enterprise",
  team: "Team",
  edu: "Edu",
  education: "Edu",
};

/**
 * Whether the plan is a paid subscription.
 *
 * Only the free tier is not one. This is what decides whether the account is
 * worth labelling as a subscription: the endpoint reports the same windows for
 * both, so the plan is the only thing that says an account is paid.
 */
export function isPaidPlan(plan: string | undefined): boolean {
  if (!plan) return false;
  return plan.trim().toLowerCase() !== "free";
}

/** "pro" -> "Pro". Unknown ids are passed through, trimmed of separators. */
export function planLabel(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  const key = plan.trim().toLowerCase();
  if (!key) return undefined;
  return PLAN_NAMES[key] ?? key.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function readAdditional(value: unknown): CodexWindow[] {
  const windows: CodexWindow[] = [];
  const entries: Array<[string, unknown]> = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      const record = asRecord(item);
      if (!record) continue;
      const name =
        (typeof record.limit_name === "string" && record.limit_name) ||
        (typeof record.limitName === "string" && record.limitName) ||
        (typeof record.name === "string" && record.name) ||
        "additional";
      entries.push([name, record]);
    }
  } else {
    const record = asRecord(value);
    if (record) {
      for (const [name, item] of Object.entries(record)) entries.push([name, item]);
    }
  }

  for (const [name, item] of entries.slice(0, 8)) {
    const record = asRecord(item);
    if (!record) continue;
    const rateLimit = asRecord(record.rate_limit ?? record.rateLimit) ?? record;
    const window = readWindow(rateLimit, PRIMARY_KEYS, `additional:${name}`, name);
    if (window) windows.push(window);
  }

  return windows;
}

export function parseCodexUsage(payload: unknown): CodexUsage | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;

  const rateLimit = asRecord(root.rate_limit ?? root.rateLimit);
  const credits = asRecord(root.credits);

  const primary = rateLimit ? readWindow(rateLimit, PRIMARY_KEYS, "primary", "Primary window") : undefined;
  const secondary = rateLimit
    ? readWindow(rateLimit, SECONDARY_KEYS, "secondary", "Weekly window")
    : undefined;

  // Named from the reported length rather than from the slot they came from, so
  // the label matches the window the provider actually gave us.
  if (primary) primary.label = windowLabel(primary.windowMinutes, primary.label);
  if (secondary) secondary.label = windowLabel(secondary.windowMinutes, secondary.label);
  const additional = readAdditional(root.additional_rate_limits ?? root.additionalRateLimits);

  if (!primary && !secondary && additional.length === 0) return undefined;

  const balanceRaw = credits?.balance;
  const creditsBalance = typeof balanceRaw === "string" ? asNumber(balanceRaw) : asNumber(balanceRaw);

  return {
    ...(typeof root.plan_type === "string" ? { plan: root.plan_type } : {}),
    ...(asRecord(rateLimit) && typeof rateLimit!.allowed === "boolean" ? { allowed: rateLimit!.allowed as boolean } : {}),
    ...(asRecord(rateLimit) && typeof rateLimit!.limit_reached === "boolean"
      ? { limitReached: rateLimit!.limit_reached as boolean }
      : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    additional,
    ...(creditsBalance !== undefined ? { creditsBalance } : {}),
    ...(typeof credits?.has_credits === "boolean" ? { hasCredits: credits.has_credits as boolean } : {}),
  };
}

function headersFor(credential: CodexCredential): Headers {
  const headers = new Headers({
    authorization: `Bearer ${credential.accessToken}`,
    accept: "application/json",
    originator: "codex_cli_rs",
    origin: "https://chatgpt.com",
    referer: "https://chatgpt.com/",
  });
  if (credential.accountId) headers.set("chatgpt-account-id", credential.accountId);
  return headers;
}

/**
 * Fetches and parses Codex quota, trying each known endpoint in turn.
 *
 * Returns undefined when the account cannot be read; callers report that as a
 * note rather than a failure so one provider never blocks the whole report.
 */
export async function fetchCodexUsage(
  credential: CodexCredential,
  signal?: AbortSignal,
): Promise<CodexUsage | undefined> {
  const headers = headersFor(credential);

  for (const endpoint of USAGE_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const parsed = parseCodexUsage(await response.json());
      if (parsed) return parsed;
    } catch {
      // Network failure or abort: fall through to the next endpoint.
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return undefined;
}
