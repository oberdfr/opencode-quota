/**
 * Shared quota report contract.
 *
 * The server plugin registers this and the TUI half calls it, so both halves
 * import the same definition and the report shape has a single source of truth.
 */

import { Rpc } from "@opencode/plugin/rpc";

/** One metered allowance, e.g. Antigravity "Claude" or the Codex 5-hour window. */
export interface QuotaLine {
  id: string;
  label: string;
  /** Percentage of the allowance still available, 0-100. */
  remainingPercent: number;
  /** ISO-8601 timestamp when the window refills, when the provider reports one. */
  resetTime?: string;
  /** How long the window runs, in minutes, when known. */
  windowMinutes?: number;
  /**
   * Set on allowances that are worth showing side by side rather than stacked.
   *
   * A Codex subscription reports a 5-hour and a weekly allowance that are two
   * halves of one budget; comparing them in a row reads better than as two
   * separate lines. Antigravity's buckets are independent quotas, so they are
   * left unmarked and stay stacked.
   */
  paired?: boolean;
}

/** A source the terminal half can request and render on its own. */
export type QuotaProvider = "antigravity" | "openai";

export interface QuotaAccount {
  /** Stable identifier: email when known, otherwise a provider-local fallback. */
  key: string;
  provider: QuotaProvider;
  email?: string;
  plan?: string;
  /**
   * Friendly name of the paid plan, when the account is on one.
   *
   * Present only for subscriptions, so the view can say so without having to
   * know which plan ids count as paid.
   */
  subscription?: string;
  status: "ok" | "disabled" | "error" | "unavailable";
  error?: string;
  lines: QuotaLine[];
}

export interface QuotaReport {
  generatedAt: number;
  accounts: QuotaAccount[];
  /** Non-fatal problems, such as a provider that is not connected. */
  notes: string[];
}

const quotaLineSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    remainingPercent: { type: "number" },
    resetTime: { type: "string" },
    windowMinutes: { type: "number" },
    paired: { type: "boolean" },
  },
  required: ["id", "label", "remainingPercent"],
  additionalProperties: false,
} as const;

const quotaAccountSchema = {
  type: "object",
  properties: {
    key: { type: "string" },
    provider: { type: "string", enum: ["antigravity", "openai"] },
    email: { type: "string" },
    plan: { type: "string" },
    subscription: { type: "string" },
    status: { type: "string", enum: ["ok", "disabled", "error", "unavailable"] },
    error: { type: "string" },
    lines: { type: "array", items: quotaLineSchema },
  },
  required: ["key", "provider", "status", "lines"],
  additionalProperties: false,
} as const;

export const QuotaRpc = Rpc.define({
  id: "quota",
  methods: {
    report: {
      input: {
        type: "object",
        properties: {
          // Restrict the report to one provider. The terminal half calls this
          // once per provider so a slow provider does not hold back a fast one.
          provider: { type: "string", enum: ["antigravity", "openai"] },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          generatedAt: { type: "number" },
          accounts: { type: "array", items: quotaAccountSchema },
          notes: { type: "array", items: { type: "string" } },
        },
        required: ["generatedAt", "accounts", "notes"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseLine(value: unknown): QuotaLine | undefined {
  const record = asRecord(value);
  const id = optionalString(record?.id);
  const label = optionalString(record?.label);
  const remainingPercent = optionalNumber(record?.remainingPercent);
  if (!id || !label || remainingPercent === undefined) return undefined;

  const resetTime = optionalString(record?.resetTime);
  const windowMinutes = optionalNumber(record?.windowMinutes);
  const paired = record?.paired === true ? true : undefined;
  return {
    id,
    label,
    remainingPercent,
    ...(resetTime ? { resetTime } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
    ...(paired ? { paired } : {}),
  };
}

const STATUSES = new Set(["ok", "disabled", "error", "unavailable"]);

function parseAccount(value: unknown): QuotaAccount | undefined {
  const record = asRecord(value);
  const key = optionalString(record?.key);
  const provider = record?.provider;
  const status = record?.status;
  if (!key || (provider !== "antigravity" && provider !== "openai")) return undefined;

  const email = optionalString(record?.email);
  const plan = optionalString(record?.plan);
  const subscription = optionalString(record?.subscription);
  const error = optionalString(record?.error);
  return {
    key,
    provider,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(subscription ? { subscription } : {}),
    status: typeof status === "string" && STATUSES.has(status) ? (status as QuotaAccount["status"]) : "error",
    ...(error ? { error } : {}),
    lines: Array.isArray(record?.lines)
      ? record.lines.map(parseLine).filter((line): line is QuotaLine => line !== undefined)
      : [],
  };
}

/**
 * Narrows an RPC response into a `QuotaReport`.
 *
 * JSON Schema inputs and outputs are typed `unknown`, and the value arrives over
 * the wire, so the shape is verified rather than asserted. A response that fails
 * validation yields an empty report, which the formatter already handles.
 */
export function parseQuotaReport(value: unknown): QuotaReport {
  const record = asRecord(value);
  return {
    generatedAt: optionalNumber(record?.generatedAt) ?? Date.now(),
    accounts: Array.isArray(record?.accounts)
      ? record.accounts.map(parseAccount).filter((account): account is QuotaAccount => account !== undefined)
      : [],
    notes: Array.isArray(record?.notes)
      ? record.notes.filter((note): note is string => typeof note === "string")
      : [],
  };
}
