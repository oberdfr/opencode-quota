/**
 * Human-readable rendering for a quota report.
 *
 * Kept separate from the TUI components so the exact text the user reads can be
 * unit tested without a terminal.
 */

import { bold, StyledText } from "@opentui/core";
import type { QuotaAccount, QuotaLine, QuotaReport } from "./rpc.ts";

/**
 * Whether a provider's title should carry its own loading marker.
 *
 * Only once the section has numbers on screen. Before the first report arrives
 * the section body already renders a full loading bar for that provider, so
 * marking the title as well put two bars on screen for a single request. With
 * numbers up, a small marker beside the title says which provider is being
 * re-read without hiding the values underneath.
 */
export function showProviderSpinner(refreshing: boolean, hasReport: boolean): boolean {
  return refreshing && hasReport;
}

/**
 * Bold text for use as a `text` child.
 *
 * `TextNodeRenderable.add` accepts a string, another renderable, or a
 * `StyledText`, and throws on anything else. The `bold` helper on its own returns
 * a bare chunk, which is none of those, so the chunk is wrapped in a
 * `StyledText`: the styled value the renderable actually expects.
 *
 * The return type is widened only so the published child type accepts it. The
 * value really is a `StyledText` at runtime, which `isStyledText` confirms.
 */
export function strong(value: string): string {
  return new StyledText([bold(value)]) as unknown as string;
}

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

/** "3d 4h" / "5h 20m" — how long an allowance still has to run. */
export function shortReset(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return undefined;
  return describeDuration(at - now);
}

/**
 * How long is left, at two levels of depth and no more.
 *
 * Past a day the hours alone are too coarse to plan around — "6d" says nothing
 * about whether the window frees up tonight or at the weekend — so the days are
 * paired with the hours under them. Under a day, minutes are what decides whether
 * to start now or in a bit, and the hours alone would round them away. Always two
 * levels, never three: a figure that precise is noise, and it is the widest part
 * of the row.
 *
 * Under an hour there is no second level left to give, so it is minutes alone
 * rather than a padded "0h 43m".
 */
export function describeDuration(deltaMs: number): string | undefined {
  if (!Number.isFinite(deltaMs)) return undefined;
  if (deltaMs <= 0) return "now";

  const totalMinutes = Math.floor(deltaMs / MINUTE);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
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
 * The time the window still has to run is the actionable figure, so it is what is
 * shown, and it is the only thing: "left" added nothing the placement did not
 * already say, and it was one more word on the widest part of the row. The window
 * length appears only when the provider gives no reset time, since a length is not
 * something anyone has left.
 */
export function formatMeta(line: QuotaLine, now: number): string | undefined {
  const reset = shortReset(line.resetTime, now);
  if (reset) return reset;
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
 * The window a line is on, from the name its label carries.
 *
 * Labels are `<family> · <window>`, and the window is the part that decides
 * whether two rows are two halves of one allowance or two different allowances.
 */
function lineWindow(line: QuotaLine): string {
  const marker = " · ";
  const at = line.label.lastIndexOf(marker);
  return at === -1 ? "" : line.label.slice(at + marker.length);
}

/**
 * Collapses the Gemini Pro and Gemini Flash allowances into a single line.
 *
 * The two are tracked separately all the way down: the RPC still reports each one,
 * and they are merged only for display. The merged value is the lower of the two,
 * so the bar reflects whichever allowance is tighter if they ever diverge, and it
 * takes the sooner reset for the same reason.
 *
 * They are merged per window, not wholesale. A subscription account reports both
 * halves twice, once for the five-hour window and once for the weekly one, and
 * collapsing across windows would produce a single row that can only report one
 * of the two windows' figures. Matching is on the family prefix so a row is still
 * recognised with the window named after it.
 *
 * The merged line takes the position of the first Gemini line so ordering in the
 * report is otherwise preserved. Any other line is passed through untouched.
 */
export function mergeGeminiAllowances(lines: readonly QuotaLine[]): QuotaLine[] {
  const familyOf = (id: string) => id.split(":").slice(0, 2).join(":");
  const isGemini = (id: string) => (GEMINI_GROUP_IDS as readonly string[]).includes(familyOf(id));

  const windows: string[] = [];
  for (const line of lines) {
    if (isGemini(line.id) && !windows.includes(lineWindow(line))) windows.push(lineWindow(line));
  }

  // The merged row is placed where the first Gemini line of its window was, and
  // everything else keeps its position. Walking the list once and replacing each
  // window's first Gemini line with the merge is what keeps the order stable.
  const placed = new Set<string>();
  return lines.flatMap((line) => {
    if (!isGemini(line.id)) return [line];
    const window = lineWindow(line);
    if (placed.has(window)) return [];

    const gemini = lines.filter((other) => isGemini(other.id) && lineWindow(other) === window);
    if (gemini.length < 2) {
      placed.add(window);
      return [line];
    }

    const resets = gemini
      .map((entry) => entry.resetTime)
      .filter((value): value is string => typeof value === "string")
      .sort();

    placed.add(window);
    return [
      {
        id: `antigravity:gemini${window ? `:${window}` : ""}`,
        label: window ? `Gemini · ${window}` : "Gemini",
        remainingPercent: Math.min(...gemini.map((entry) => entry.remainingPercent)),
        ...(resets[0] ? { resetTime: resets[0] } : {}),
        ...(gemini[0]?.windowMinutes !== undefined ? { windowMinutes: gemini[0].windowMinutes } : {}),
      },
    ];
  });
}

/** Gap between two allowances drawn on the same row. */
export const COLUMN_GAP = 2;

/** The family a line belongs to, without the window it sits in. */
function lineFamily(line: QuotaLine): string {
  const marker = " · ";
  const at = line.label.indexOf(marker);
  return at === -1 ? line.label : line.label.slice(0, at);
}

/** The window a line sits in, or an empty string when it is not named. */
function lineWindowName(line: QuotaLine): string {
  const marker = " · ";
  const at = line.label.lastIndexOf(marker);
  return at === -1 ? "" : line.label.slice(at + marker.length);
}

/**
 * Lays an account's allowances out in rows.
 *
 * A family running on a five-hour window and a weekly one is one budget seen
 * twice, and setting the two side by side is what lets them be read against each
 * other: a nearly spent five-hour window beside an untouched weekly one says
 * something no single row can. The pairing is per family, so Claude and Gemini
 * each get their own row rather than four allowances interleaved.
 *
 * A provider that marks its own pairable lines is taken at its word and consecutive
 * ones share a row, since that is how the consumer already knows they belong
 * together.
 */
export function windowRows(lines: readonly QuotaLine[]): QuotaLine[][] {
  const rows: QuotaLine[][] = [];
  const index = new Map<string, QuotaLine[][]>();
  let stillPaired = true;

  for (const line of lines) {
    if (line.paired) {
      const open = stillPaired ? rows[rows.length - 1] : undefined;
      if (open && open.length < 2) {
        open.push(line);
        continue;
      }
      const row = [line];
      rows.push(row);
      continue;
    }

    stillPaired = false;

    // Two windows of one family, and only two: a third would not fit a row, and
    // the pairing is what the width is spent on.
    const family = lineFamily(line);
    const rowsForFamily = index.get(family) ?? [];
    const target = rowsForFamily.find((row) => row.length < 2);
    if (target) {
      target.push(line);
      continue;
    }

    const row = [line];
    rows.push(row);
    index.set(family, [...rowsForFamily, row]);
  }

  return orderFamilies(rows);
}

/**
 * Where a family sits in the reading order.
 *
 * Gemini before Claude, and everything else after both. The provider reports
 * families in whatever order the buckets arrived in, which is not a reading
 * order: an account whose Claude buckets happen to be listed first would show
 * Claude first, and the two families would swap places between refreshes.
 */
function familyRank(family: string): number {
  const name = family.toLowerCase();
  if (name.includes("gemini")) return 0;
  if (name.includes("claude")) return 1;
  return 2;
}

/** Puts the families in a fixed order, leaving each family's own rows in place. */
function orderFamilies(rows: QuotaLine[][]): QuotaLine[][] {
  // A family repeated over several rows keeps those rows together, and only the
  // first appearance decides where its block goes.
  const order: string[] = [];
  for (const row of rows) {
    const family = lineFamily(row[0]!);
    if (!order.includes(family)) order.push(family);
  }

  const rank = (row: QuotaLine[]) => {
    const family = order[order.indexOf(lineFamily(row[0]!))]!;
    return { family: familyRank(family), at: order.indexOf(family) };
  };

  return [...rows].sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    return left.family - right.family || left.at - right.at;
  });
}

/** What a pair needs in order to be drawn beside itself. */
export interface PairPlan {
  /**
   * Width of each column's window name, in the order the columns are drawn.
   *
   * Sized to the data per column rather than to the longest of them, because the
   * column is what the bar is paid for: "5h" and "wk" are not the same width,
   * and padding the short one out to match threw away bar on every account.
   */
  windowWidths: number[];
  /** 0 when the width will not take a bar, in which case the percentage carries it. */
  barWidth: number;
}

/**
 * Works out how a pair of windows can be drawn side by side in the room there is.
 *
 * The family is on the line above, so the whole width is the two windows' to
 * spend, and the bar is kept: it is the figure the row is really showing, and the
 * percentage beside it is the same number spelled out.
 *
 * Returns undefined when the pair does not fit at all, and the caller stacks the
 * allowances: a wrapped pair leaves a fragment of the second bar on the line
 * below, which reads as stray output rather than as a second limit.
 */
export function pairPlan(
  lines: readonly QuotaLine[],
  now: number,
  min: number,
  max: number,
  maxBar: number,
  budget: number,
): PairPlan | undefined {
  if (lines.length < 2) return undefined;

  // Only one family per row. Two different budgets side by side is not a pair of
  // one budget.
  const families = lines.map(lineFamily);
  if (!families.every((family) => family === families[0])) return undefined;

  const names = lines.map(lineWindowName);
  if (names.some((name) => name === "")) return undefined;

  const windowWidths = names.map((name) => Math.min(Math.max(name.length, min), max));
  // The widest trailing detail in the pair, not the widest one that could ever be
  // shown. Reserving the worst case cost a bar on every account, because most
  // countdowns are "4h 52m" and only the long weekly ones reach seven characters.
  const detail = Math.max(
    0,
    ...lines.map((line) => {
      const meta = formatMeta(line, now);
      return meta ? meta.length : 0;
    }),
  );

  // label, the bar and its gap, the percentage and the trailing detail. The gap
  // after the label belongs to the bar, so a barless column does not pay for it.
  const roomFor = (bar: number) => {
    const perColumn = (width: number) =>
      width + (bar > 0 ? 1 + bar : 0) + COLUMN_OVERHEAD + (detail > 0 ? 2 + detail : 0);
    return windowWidths.reduce((total, width) => total + perColumn(width), 0) +
      COLUMN_GAP * (lines.length - 1);
  };
  if (roomFor(0) > budget) return undefined;

  let barWidth = maxBar;
  while (barWidth > 0 && roomFor(barWidth) > budget) barWidth -= 1;
  // A bar one or two characters wide is not a bar, it is a smudge that reads as a
  // rendering fault. Below the narrowest that still says something, the percentage
  // carries the figure on its own.
  return { windowWidths, barWidth: barWidth >= MIN_PAIRED_BAR ? barWidth : 0 };
}

/** Room kept per column for the two spaces and the percentage. */
const COLUMN_OVERHEAD = 2 + 4;
/** Narrowest bar that still reads as a bar rather than a smudge. */
const MIN_PAIRED_BAR = 4;

/**
 * A window kind, or undefined when the provider does not say which it is.
 *
 * Both are abbreviated, and both for the same reason: the name is the widest fixed
 * part of a row, and every character in it comes straight out of the bar beside it.
 * "5h" and "wk" say the same as "5-hour" and "weekly" next to countdowns that
 * already read "4h 52m" and "6d 23h", and the six characters they give back are
 * the difference between a bar worth looking at and a smudge.
 */
export type WindowKind = "5h" | "wk";

/**
 * Names an allowance's window from how long it has left.
 *
 * Antigravity reports when a window refills rather than how long it runs, and the
 * two are distinguishable: a rolling five-hour window has at most five hours
 * left, and the weekly one is days out. Anything between is left unnamed, since
 * calling it either would be a guess. The practical split is the tier, so an
 * account on a subscription shows its five-hour allowance and one without shows
 * the weekly one.
 */
export function windowKind(minutes: number | undefined): WindowKind | undefined {
  if (minutes === undefined || minutes <= 0) return undefined;
  if (minutes <= 6 * 60) return "5h";
  if (minutes >= 5 * 24 * 60) return "wk";
  return undefined;
}

