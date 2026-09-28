/**
 * Human-readable rendering for a quota report.
 *
 * Kept separate from the TUI components so the exact text the user reads can be
 * unit tested without a terminal.
 */

import type { QuotaAccount, QuotaLine, QuotaReport } from "./rpc.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatResetTime(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;

  const delta = at - now;
  if (delta <= 0) return "resetting now";

  if (delta < HOUR) return `resets in ${Math.max(1, Math.round(delta / MINUTE))}m`;
  if (delta < DAY) return `resets in ${Math.round(delta / HOUR)}h`;
  return `resets in ${Math.round(delta / DAY)}d`;
}

export function formatWindowName(windowMinutes: number | undefined): string | undefined {
  if (!windowMinutes) return undefined;
  if (windowMinutes % (60 * 24) === 0 && windowMinutes >= 60 * 24) {
    const days = windowMinutes / (60 * 24);
    return `${days}d window`;
  }
  if (windowMinutes % 60 === 0 && windowMinutes >= 60) return `${windowMinutes / 60}h window`;
  return `${windowMinutes}m window`;
}

function describeLine(line: QuotaLine, now: number): string {
  const parts: string[] = [`${line.remainingPercent.toFixed(0)}%`];
  const window = formatWindowName(line.windowMinutes);
  if (window) parts.push(window);
  const reset = formatResetTime(line.resetTime, now);
  if (reset) parts.push(reset);
  return parts.join(", ");
}

function describeAccount(account: QuotaAccount, now: number): string[] {
  const fallbackName = account.key.split(":").slice(1).join(":");
  const who = account.email ?? (fallbackName || account.key);
  const plan = account.plan ? ` (${account.plan})` : "";
  const lines = [`${who}${plan}`];

  if (account.status === "disabled") {
    lines.push("  disabled");
  } else if (account.status === "error") {
    lines.push(`  error: ${account.error ?? "unknown error"}`);
  } else if (account.status === "unavailable") {
    lines.push("  unavailable");
  }

  for (const line of account.lines) {
    lines.push(`  ${line.label}: ${describeLine(line, now)}`);
  }

  return lines;
}

/** Renders the whole report as plain text, grouped by provider. */
export function formatReport(report: QuotaReport): string {
  const { generatedAt, accounts, notes } = report;
  if (accounts.length === 0) {
    return ["No quota data available.", ...notes.map((note) => `  ${note}`)].join("\n");
  }

  const out: string[] = [];
  for (const provider of ["antigravity", "openai"] as const) {
    const group = accounts.filter((account) => account.provider === provider);
    if (group.length === 0) continue;

    out.push(provider === "antigravity" ? "Antigravity" : "OpenAI (Codex)");
    for (const account of group) out.push(...describeAccount(account, generatedAt));
    out.push("");
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  for (const note of notes) out.push(`note: ${note}`);

  return out.join("\n");
}

const BAR_WIDTH = 20;
const FILLED = "█";
const EMPTY = "░";

/** Severity of a remaining percentage, used to pick the bar colour. */
export type QuotaTone = "ok" | "warn" | "critical" | "spent";

export function quotaTone(remainingPercent: number): QuotaTone {
  if (remainingPercent <= 0) return "spent";
  if (remainingPercent < 20) return "critical";
  if (remainingPercent < 50) return "warn";
  return "ok";
}

/**
 * Renders a remaining percentage as a fixed-width bar.
 *
 * A percentage that is not a number, or is out of range, is clamped rather than
 * trusted, so a malformed provider response cannot produce a broken bar.
 */
export function formatBar(remainingPercent: number, width: number = BAR_WIDTH): string {
  const safe = Number.isFinite(remainingPercent) ? Math.min(Math.max(remainingPercent, 0), 100) : 0;
  const filled = Math.round((safe / 100) * width);
  return FILLED.repeat(filled) + EMPTY.repeat(Math.max(0, width - filled));
}

/** Pads a label to a fixed width so bars and percentages line up in a column. */
export function formatLabel(label: string, width: number): string {
  // A label that exactly fills the column is not truncated; only overflow is.
  if (label.length <= width) return label.padEnd(width, " ");
  return `${label.slice(0, Math.max(0, width - 1))}…`.padEnd(width, " ");
}

/** "3d" / "5h" / "20m" — the time until the window refills. */
export function shortReset(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

/** "5h" / "7d" — how long the window runs. */
export function shortWindow(minutes: number | undefined): string | undefined {
  if (!minutes) return undefined;
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Trailing detail for a row.
 *
 * The reset countdown is the actionable figure, so it is what is shown; the
 * window length only appears when the provider gives no reset time. Printing
 * both produced rows like "30d left · 29d left", where the first number is the
 * window length rather than something left, and it pushed the row past the
 * dialog width.
 */
export function formatMeta(line: QuotaLine, now: number): string | undefined {
  const reset = shortReset(line.resetTime, now);
  if (reset) return `${reset} left`;
  const window = shortWindow(line.windowMinutes);
  return window ? `${window} window` : undefined;
}

/**
 * Character width a rendered row will occupy.
 *
 * The view draws each column separately so it can colour them independently, so
 * this sums the same pieces the view uses. Rows that exceed the dialog width
 * wrap, which previously left a stray bar fragment on the following line, so the
 * tests assert the total stays inside the available width.
 */
export function rowWidth(line: QuotaLine, now: number, labelWidth: number, barWidth: number): number {
  const meta = formatMeta(line, now);
  // label + gap + bar + two spaces + percentage + two spaces + optional meta
  return labelWidth + 1 + barWidth + 2 + `${Math.round(line.remainingPercent)}%`.length + (meta ? 2 + meta.length : 0);
}

/** Line ids of the two Antigravity Gemini allowances, as reported by its RPC. */
export const GEMINI_GROUP_IDS = ["antigravity:gemini-pro", "antigravity:gemini-flash"] as const;

/**
 * Collapses the Gemini Pro and Gemini Flash allowances into a single line.
 *
 * The two allowances are tracked separately all the way down: the RPC still
 * reports each one, and they are merged only for display. The merged value is
 * the lower of the two, so the bar reflects whichever allowance is tighter if
 * they ever diverge, and it takes the sooner reset for the same reason.
 *
 * The merged line takes the position of the first Gemini line so ordering in
 * the report is otherwise preserved. Any other line is passed through untouched.
 */
export function mergeGeminiAllowances(lines: readonly QuotaLine[]): QuotaLine[] {
  const isGemini = (id: string) => (GEMINI_GROUP_IDS as readonly string[]).includes(id);
  const gemini = lines.filter((line) => isGemini(line.id));
  if (gemini.length < 2) return [...lines];

  const resets = gemini
    .map((line) => line.resetTime)
    .filter((value): value is string => typeof value === "string")
    .sort();

  const merged: QuotaLine = {
    id: "antigravity:gemini",
    label: "Gemini",
    remainingPercent: Math.min(...gemini.map((line) => line.remainingPercent)),
    ...(resets[0] ? { resetTime: resets[0] } : {}),
  };

  const out: QuotaLine[] = [];
  let inserted = false;
  for (const line of lines) {
    if (!isGemini(line.id)) {
      out.push(line);
      continue;
    }
    if (!inserted) {
      out.push(merged);
      inserted = true;
    }
  }
  return out;
}
