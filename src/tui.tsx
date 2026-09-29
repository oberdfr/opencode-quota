/**
 * opencode-quota — terminal half.
 *
 * Registers `/quota` and renders the report in a dialog. Collecting the report
 * is the server half's job, so this file is only concerned with presentation and
 * staying responsive: the dialog opens on the first frame, shows whatever was
 * cached from last time, and swaps in fresh numbers when the request lands.
 */

import { createRoot, createSignal } from "solid-js";
import { Plugin } from "@opencode/plugin/tui";
import {
  QuotaRpc,
  parseQuotaReport,
  type QuotaAccount,
  type QuotaLine,
  type QuotaProvider,
  type QuotaReport,
} from "./rpc.ts";
import {
  COLUMN_GAP,
  formatBar,
  formatLabel,
  formatMeta,
  mergeGeminiAllowances,
  pairPlan,
  quotaTone,
  showProviderSpinner,
  strong,
  windowRows,
} from "./format.ts";

/**
 * Characters available for a row once the dialog's left and right padding are
 * taken off.
 *
 * Measured from the dialog itself rather than assumed, because the assumption was
 * wrong in both directions: the dialog asks for a fixed size, but a terminal
 * narrower than that clips it, and a budget set for the wider case pairs
 * allowances that then wrap, leaving a stray bar fragment on the line below. The
 * layout reads the width the dialog was actually given and works from that, and
 * this is only what the first frame falls back to before the dialog has been laid
 * out and reported its size.
 */
const CONTENT_FALLBACK = 60;
const BAR_WIDTH = 12;
const MIN_LABEL_WIDTH = 6;

/**
 * Space under an account name, before its first allowance.
 *
 * A whole row is too much: the name reads as a heading of its own section rather
 * than as the account the rows below it belong to, and a free account with one
 * allowance ends up with a row of nothing. The grid is a row per line, so the gap
 * that is actually wanted — a few pixels, enough to see the break — has to come
 * from somewhere other than the row count. It cannot: a terminal has no half row.
 * So this is deliberately 0 rather than 1, and the break is carried by the
 * indentation of the rows below.
 */
const NAME_GAP = 0;
const MAX_LABEL_WIDTH = 18;
/** Padding either side of the dialog body, taken off the measured width. */
const CONTENT_PADDING = 4;
const SPINNER_FRAMES = 10;
const CLOSE_COMMAND_ID = "opencode-quota.close";
const SHOW_COMMAND_ID = "opencode-quota.show";
const REFRESH_COMMAND_ID = "opencode-quota.refresh";

/**
 * How long one provider gets before it is reported as failed.
 *
 * Without this a request that never settles leaves the section on its loading
 * bar forever, with no way to tell a slow provider from a dead one. Cached
 * numbers stay on screen either way, so timing out costs a retry, not data.
 *
 * Deliberately longer than the server side timeout for the Antigravity call, so
 * a stalled read is reported by whoever can explain it rather than here.
 */
const REQUEST_TIMEOUT_MS = 40_000;

const PROVIDERS: readonly QuotaProvider[] = ["antigravity", "openai"];

const PROVIDER_TITLES: Record<QuotaProvider, string> = {
  antigravity: "Antigravity",
  openai: "OpenAI (Codex)",
};

/**
 * One provider's section.
 *
 * `report` and `refreshing` are tracked separately rather than as a status union
 * so that a provider can show the numbers it already has while a newer reading
 * is on the way, which is what makes `/quota` able to refresh without the dialog
 * going blank.
 */
interface Section {
  /** Last report that arrived, or null if this provider has never answered. */
  report: QuotaReport | null;
  /** Why the last attempt failed, if it did. */
  error: string | null;
  /** Whether a request for this provider is currently in flight. */
  refreshing: boolean;
}

type View = Record<QuotaProvider, Section>;

function initialView(cached: Record<QuotaProvider, QuotaReport | null>, refreshing: boolean): View {
  return {
    antigravity: { report: cached.antigravity, error: null, refreshing },
    openai: { report: cached.openai, error: null, refreshing },
  };
}

/** A readable account heading, never a raw storage key. */
function accountTitle(account: QuotaAccount): string {
  if (account.email) return account.email;
  if (account.plan) return `${account.plan} plan`;
  return "active account";
}

/** Indeterminate bar for the loading state. */
function spinnerBar(frame: number): string {
  const head = (frame % SPINNER_FRAMES) + 1;
  return `${"░".repeat(head - 1)}█${"░".repeat(Math.max(0, BAR_WIDTH - head))}`;
}

/**
 * Bold text for use as a `text` child.
 *
 * The chunk helper is the supported way to style a run of text, and the
 * renderable takes a chunk at runtime, but the published child type only admits
 * primitives, so the cast is confined to this one helper.
 */
/** Small spinner shown beside a provider that already has data on screen. */
function spinnerTick(frame: number): string {
  return "|/-\\"[frame % 4] as string;
}

/**
 * Fails a request that never settles, so one stalled provider cannot leave the
 * dialog waiting forever.
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export default Plugin.define({
  id: "opencode-quota.tui",
  setup(context) {
    const quota = context.client.rpc(QuotaRpc);
    // `storage.memory` returns a reactive store, so the cached report is read as
    // a property. A wrapper object is used because the store's value type is
    // constrained to non-null.
    const [cache, patchCache] = context.storage.memory("report", {
      initial: { antigravity: null as QuotaReport | null, openai: null as QuotaReport | null },
    });

    // Live view state, owned by a Solid root created on open and disposed on
    // close so the dialog re-renders in place rather than being torn down and
    // rebuilt while a request is in flight.
    let readView: (() => View) | undefined;
    let writeView: ((next: View | ((view: View) => View)) => void) | undefined;
    let disposeRoot: (() => void) | undefined;
    const [frame, setFrame] = createSignal(0);
    // Whether a quota dialog is on screen.
    //
    // Deliberately a plain boolean rather than a signal. This value gates a
    // keymap command, and the host resolves `enabled` through a reactive
    // computation, so a signal-free read can be evaluated once and cached with
    // no way to re-check it. Depending on that re-evaluation made escape
    // unreliable, so the binding is registered unconditionally and the state is
    // checked here instead, where it is always live.
    let dialogIsOpen = false;
    // The spinner only ticks while something is in flight, so an idle dialog
    // costs nothing.
    let ticker: ReturnType<typeof setInterval> | undefined;

    const stopTicker = () => {
      if (ticker === undefined) return;
      clearInterval(ticker);
      ticker = undefined;
    };

    const startTickerIfIdle = () => {
      if (ticker !== undefined) return;
      ticker = setInterval(() => setFrame((n) => n + 1), 90);
    };

    const close = () => {
      // Guarded so an escape press that lands with no quota dialog on screen
      // cannot clear a dialog belonging to something else.
      if (!dialogIsOpen) return;
      dialogIsOpen = false;
      stopTicker();
      if (disposeRoot) {
        disposeRoot();
        disposeRoot = undefined;
      }
      readView = undefined;
      writeView = undefined;
      try {
        context.ui.dialog.clear();
      } catch {
        // The host may already have torn the dialog down; nothing left to do.
      }
    };

    /**
     * Monotonic counter identifying the newest refresh, so a request that
     * resolves after a retry cannot revert the dialog to older numbers.
     */
    let latestGeneration = 0;

    /**
     * Asks the server for both providers and updates each section as it lands.
     *
     * Safe to call again while a request is in flight, which is what the refresh
     * control does: the newest answer wins and an earlier one that arrives late
     * is ignored, so a slow first request cannot overwrite a faster retry.
     */
    const refresh = () => {
      if (!dialogIsOpen) return;
      const apply = writeView;
      if (!apply) return;

      // Each provider gets its own request generation. Only the newest one may
      // write, so an in-flight request that resolves after a retry is dropped
      // instead of reverting the dialog to older numbers.
      const generation = (latestGeneration += 1);
      const isCurrent = () => latestGeneration === generation;

      apply((view) => ({
        antigravity: { ...view.antigravity, refreshing: true },
        openai: { ...view.openai, refreshing: true },
      }));
      startTickerIfIdle();

      for (const provider of PROVIDERS) {
        const label = PROVIDER_TITLES[provider];
        // The call is wrapped so a synchronous throw is handled like a rejection:
        // letting it escape would skip the handlers below and leave the section
        // on its loading bar for good.
        let request: Promise<unknown>;
        try {
          request = Promise.resolve(quota.report({ provider }));
        } catch (error: unknown) {
          request = Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }

        void withTimeout(request, REQUEST_TIMEOUT_MS, label)
          .then((result) => {
            if (!isCurrent() || !dialogIsOpen) return;
            const report = parseQuotaReport(result);
            patchCache((draft) => {
              draft[provider] = report;
            });
            apply((view) => ({
              ...view,
              [provider]: { report, error: null, refreshing: false },
            }));
          })
          .catch((error: unknown) => {
            if (!isCurrent() || !dialogIsOpen) return;
            const message = error instanceof Error ? error.message : String(error);
            // A provider that already has numbers keeps showing them: the point
            // of the cache is that a failed refresh does not blank the dialog.
            apply((view) => ({
              ...view,
              [provider]: { ...view[provider], error: message, refreshing: false },
            }));
          })
          .finally(() => {
            if (!isCurrent()) return;
            if (readView && !Object.values(readView()).some((section) => section.refreshing)) {
              stopTicker();
            }
          });
      }
    };

    const open = () => {
      // Ignore a second /quota while one is already on screen: the dialog is
      // already showing the data, and `refresh` is the way to ask again.
      if (dialogIsOpen) {
        refresh();
        return;
      }
      dialogIsOpen = true;

      const cached = { antigravity: cache.antigravity, openai: cache.openai };
      // createRoot passes its disposer to the callback, so the root can be torn
      // down later to release the signals it owns.
      disposeRoot = createRoot((dispose) => {
        // Any cached report is on screen from the first frame, and the sections
        // start out refreshing so the spinner appears immediately.
        const [signal, setSignal] = createSignal<View>(initialView(cached, true));
        readView = signal;
        writeView = setSignal;
        return dispose;
      });

      // The widest size, so the paired row has room for it. A terminal narrower
      // than this clips the dialog, which is why the layout reads the width the
      // dialog was actually given rather than this size.
      context.ui.dialog.set({ size: "xlarge", centered: true });
      context.ui.dialog.show(
        () => <QuotaView read={readView!} frame={frame} />,
        () => close(),
      );

      // Always a fresh read: the cache only decides what the first frame shows.
      refresh();
    };

    // The host's resolved theme type is not resolvable from this package, so
    // tokens are read defensively: an unexpected shape falls back to the
    // documented foreground tokens instead of rendering nothing.
    const theme = context.theme as unknown as Record<string, any>;
    const text = (theme.text ?? {}) as Record<string, string | undefined>;
    const base = text.base;
    const muted = text.muted ?? text.base;

    const tone = (percent: number) => {
      switch (quotaTone(percent)) {
        case "ok":
          return theme.success?.base ?? base;
        case "warn":
          return theme.warning?.base ?? base;
        case "critical":
          return theme.error?.base ?? base;
        default:
          return muted;
      }
    };

    /**
     * Width the dialog was actually given, in characters.
     *
     * Set from the dialog's own root renderable once it has been laid out. Reading
     * it beats assuming the size that was asked for: the dialog is clipped to a
     * narrower terminal, and a layout built for the width that was requested then
     * overflows the width that exists.
     */
    const [measured, setMeasured] = createSignal<number | undefined>(undefined);
    /** Width a row may occupy, falling back until the dialog reports its own. */
    const contentWidth = () => measured() ?? CONTENT_FALLBACK;

    /** One allowance's label, bar, percentage and trailing detail. */
    const Allowance = (props: {
      line: QuotaLine;
      now: number;
      width: number;
      barWidth?: number;
      gap?: number;
      /** Replaces the label, so a pair can show just the window it sits in. */
      label?: string;
    }) => {
      const meta = () => formatMeta(props.line, props.now);
      const lead = props.gap ? " ".repeat(props.gap) : "";
      // A bar of 0 is the layout saying the width will not take one. The
      // percentage is then the whole figure, so the row does not read as missing
      // something.
      const bar = props.barWidth === undefined ? BAR_WIDTH : props.barWidth;
      return (
        <box flexDirection="row">
          <text fg={muted}>{`${lead}${formatLabel(props.label ?? props.line.label, props.width)}`}</text>
          {/* The space after the label belongs to the bar, so a barless column does
              not pay for it. On a narrow terminal that space is the difference
              between a pair on one row and the same two on two rows. */}
          {bar > 0 ? (
            <>
              <text fg={muted}> </text>
              <text fg={tone(props.line.remainingPercent)}>{formatBar(props.line.remainingPercent, bar)}</text>
            </>
          ) : null}
          <text fg={base}>{`  ${Math.round(props.line.remainingPercent)}%`}</text>
          {meta() ? <text fg={muted} opacity={0.8}>{`  ${meta()}`}</text> : null}
        </box>
      );
    };

    const Account = (props: { account: QuotaAccount; now: number; width: number }) => {
      const account = () => props.account;
      // Gemini Pro and Flash are still tracked and reported separately; they are
      // only collapsed for display.
      const lines = () => mergeGeminiAllowances(account().lines);
      // A family's five-hour and weekly windows share a row, so the two can be read
      // against each other rather than one per line.
      const rows = () => windowRows(lines());
      // The widest pair decides the columns, so every pair in the account starts
      // its bar in the same place.
      const widestPair = () => {
        let widest: QuotaLine[] = [];
        for (const row of rows()) {
          if (row.length > widest.length) widest = row;
        }
        return widest;
      };
      const layout = () =>
        pairPlan(widestPair(), props.now, MIN_LABEL_WIDTH, MAX_LABEL_WIDTH, BAR_WIDTH, contentWidth());
      /** The window each column of a pair sits in, without the family on it. */
      const windowOf = (line: QuotaLine) => {
        const marker = " · ";
        const at = line.label.lastIndexOf(marker);
        return at === -1 ? line.label : line.label.slice(at + marker.length);
      };
      /** The family a line belongs to, for the heading above its windows. */
      const lineFamily = (line: QuotaLine) => {
        const marker = " · ";
        const at = line.label.indexOf(marker);
        return at === -1 ? line.label : line.label.slice(0, at);
      };
      // Only set them side by side when the row genuinely fits; otherwise they
      // stack, since a wrapped pair leaves a fragment of the second bar on the
      // line below, which reads as stray output rather than as a second limit.
      const fits = () => layout() !== undefined;
      return (
        <box flexDirection="column" marginTop={1}>
          <box flexDirection="row" gap={1} marginBottom={NAME_GAP}>
            <text fg={muted}>{accountTitle(account())}</text>
            {/* Names the plan, so a paid account is recognisable as one. */}
            {account().subscription ? (
              <text fg={base} opacity={0.7}>{`(${account().subscription})`}</text>
            ) : null}
          </box>
          {account().status === "disabled" ? (
            <text fg={muted} opacity={0.7}>  disabled</text>
          ) : account().status === "error" ? (
            <text fg={muted} opacity={0.7}>{`  ${account().error ?? "error"}`}</text>
          ) : (
            rows().map((row) => {
              const plan = row.length > 1 ? layout() : undefined;
              if (!plan) {
                return row.map((line) => <Allowance line={line} now={props.now} width={props.width} />);
              }
              // The family on its own line, so the row below it belongs to it and
              // the two windows have the whole width to spend between them. Sharing
              // one line with the windows left so little room that the bar was the
              // thing that had to go, and a bar is the figure worth keeping.
              return (
                <>
                  <text fg={muted}>{lineFamily(row[0]!)}</text>
                  <box flexDirection="row">
                    {row.map((line, index) => (
                      <Allowance
                        line={line}
                        label={windowOf(line)}
                        now={props.now}
                        width={plan.windowWidth}
                        barWidth={plan.barWidth}
                        gap={index === 0 ? undefined : COLUMN_GAP}
                      />
                    ))}
                  </box>
                </>
              );
            })
          )}
        </box>
      );
    };

    /** Body of one provider section. */
    const SectionBody = (props: { section: Section; now: number; width: number; frameRef: () => number }) => {
      const section = () => props.section;
      const report = section().report;

      if (!report) {
        if (section().refreshing) {
          // Each provider gets its own bar, so a slow one shows its own progress
          // instead of blanking the whole dialog.
          return <text fg={muted}>{`${spinnerBar(props.frameRef())} fetching…`}</text>;
        }
        return (
          <text fg={muted} opacity={0.8}>
            {section().error ?? "No quota data available."}
          </text>
        );
      }

      if (report.accounts.length === 0) {
        return (
          <text fg={muted} opacity={0.8}>
            {section().error ?? report.notes[0] ?? "No quota data available."}
          </text>
        );
      }

      return (
        <box flexDirection="column">
          {report.accounts.map((account) => (
            <Account account={account} now={props.now} width={props.width} />
          ))}
          {report.notes.map((note) => (
            <text fg={muted} opacity={0.8}>{note}</text>
          ))}
          {section().error ? (
            <text fg={muted} opacity={0.8}>{`refresh failed: ${section().error}`}</text>
          ) : null}
        </box>
      );
    };

    const QuotaView = (props: { read: () => View; frame: () => number }) => {
      const current = () => props.read();
      const frameRef = () => props.frame();
      /** Newest report timestamp across the providers that have landed. */
      const now = () => {
        const stamps = PROVIDERS.flatMap((provider) => {
          const report = current()[provider].report;
          return report ? [report.generatedAt] : [];
        });
        return stamps.length > 0 ? Math.max(...stamps) : Date.now();
      };
      const width = () => {
        // Measure the width from what is actually displayed, so merging the
        // Gemini allowances does not leave a column sized for a hidden label.
        const accounts = PROVIDERS.flatMap((provider) => {
          const report = current()[provider].report;
          return report ? report.accounts : [];
        });
        const max = accounts.reduce(
          (acc, account) =>
            Math.max(acc, ...mergeGeminiAllowances(account.lines).map((line) => line.label.length)),
          MIN_LABEL_WIDTH,
        );
        return Math.min(max, MAX_LABEL_WIDTH);
      };
      const anyRefreshing = () => PROVIDERS.some((provider) => current()[provider].refreshing);

      return (
        <box
          flexDirection="column"
          paddingLeft={4}
          paddingRight={4}
          paddingBottom={1}
          // No top padding: the first section brings its own spacing with the
          // marginTop on the provider blocks below.
          paddingTop={0}
          // Reports the width the dialog was actually given, so the paired layout
          // is built for the space that exists rather than the space that was
          // asked for. A terminal narrower than the requested size clips the
          // dialog, and a pair laid out for the wider case wraps, which leaves a
          // fragment of the second bar on the line below.
          onSizeChange={function (this: { width: number }) {
            const available = this.width - CONTENT_PADDING * 2;
            if (available > 0 && available !== measured()) setMeasured(available);
          }}
          // Second, independent way out. A custom dialog owns its own dismissal,
          // so the dialog's root renderable takes focus and closes on escape
          // directly. This does not rely on the host delivering keys to plugin
          // keymap layers while a dialog is on screen.
          focusable
          onKeyDown={(event) => {
            if (event.name === "escape") close();
          }}
        >
          {/* Header: title on the left, the dismiss hint on the right. */}
          <box flexDirection="row" justifyContent="space-between">
            <text fg={base}>{strong("Quota")}</text>
            <text
              fg={muted}
              onMouseDown={(event: unknown) => {
                (event as { stopPropagation?: () => void }).stopPropagation?.();
                close();
              }}
            >
              esc
            </text>
          </box>

          <box marginTop={-1}>
            {PROVIDERS.map((provider) => {
              const section = current()[provider];
              return (
                <box flexDirection="column" marginTop={2}>
                  <box flexDirection="row" gap={1}>
                    <text fg={base}>{strong(PROVIDER_TITLES[provider])}</text>
                    {/* The provider's own marker, so it is clear which section is
                      being re-read rather than the whole dialog. */}
                    {showProviderSpinner(section.refreshing, section.report !== null) ? (
                      <text fg={muted}>{spinnerTick(props.frame())}</text>
                    ) : null}
                  </box>
                  <SectionBody
                    section={section}
                    now={now()}
                    width={width()}
                    frameRef={frameRef}
                  />
                </box>
              );
            })}
          </box>

          {/* Footer: the refresh control, styled like the host's key hints and
              clickable the same way. */}
          <box flexDirection="row" marginTop={2}>
            <text
              fg={muted}
              onMouseDown={(event: unknown) => {
                (event as { stopPropagation?: () => void }).stopPropagation?.();
                if (anyRefreshing()) return;
                refresh();
              }}
            >
              {strong("r")} to refresh
            </text>
          </box>
        </box>
      );
    };

    // The keymap layer must be created from inside the app's render tree: the
    // host keeps its keymap state in a reactive context, and reaching for it
    // during setup runs outside that tree and fails with "Keymap.Provider is
    // missing". Claiming an `app` slot places this render inside the tree, and
    // the disposer returned by `ui.slot` is returned from setup.
    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 20,
          commands: [
            {
              id: SHOW_COMMAND_ID,
              title: "Quota",
              description: "Show remaining quota for connected accounts",
              group: "opencode-quota",
              palette: true,
              slash: { name: "quota", aliases: ["quota-report"] },
              run: open,
            },
            {
              id: REFRESH_COMMAND_ID,
              title: "Refresh quota",
              group: "opencode-quota",
              bind: "r",
              // No `enabled` gate, for the same reason as the close command: the
              // host resolves `enabled` reactively and may cache the result.
              run: () => {
                if (!dialogIsOpen) return false;
                refresh();
                return false;
              },
            },
            {
              id: CLOSE_COMMAND_ID,
              title: "Close quota",
              group: "opencode-quota",
              bind: "escape",
              // No `enabled` gate. The host resolves `enabled` reactively, so
              // gating the binding on live state risks it being evaluated once
              // and cached. `close()` checks whether a quota dialog is actually
              // open instead, and returns false so the host still handles the
              // key it was already seeing.
              run: () => {
                close();
                return false;
              },
            },
          ],
          // A command's `bind` is inert unless its id is listed here, which is
          // why listing the close command is what makes escape reach it.
          bindings: [CLOSE_COMMAND_ID, REFRESH_COMMAND_ID],
        }));
        return null;
      },
    });
  },
});
