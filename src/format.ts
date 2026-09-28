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
  return label.length >= width ? `${label.slice(0, Math.max(0, width - 1))}…` : label.padEnd(width, " ");
}
