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
import { QuotaRpc, parseQuotaReport, type QuotaAccount, type QuotaLine, type QuotaReport } from "./rpc.ts";
import { formatBar, formatLabel, formatMeta, mergeGeminiAllowances, quotaTone } from "./format.ts";

const BAR_WIDTH = 12;
const MIN_LABEL_WIDTH = 8;
const MAX_LABEL_WIDTH = 18;
const SPINNER_FRAMES = 10;
const CLOSE_COMMAND_ID = "opencode-quota.close";
const SHOW_COMMAND_ID = "opencode-quota.show";

type View =
  | { status: "loading" }
  | { status: "ready"; report: QuotaReport }
  | { status: "error"; message: string };

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

export default Plugin.define({
  id: "opencode-quota.tui",
  setup(context) {
    const quota = context.client.rpc(QuotaRpc);
    // `storage.memory` returns a reactive store, so the cached report is read as
    // a property. A wrapper object is used because the store's value type is
    // constrained to non-null.
    const [cache, patchCache] = context.storage.memory("report", {
      initial: { report: null as QuotaReport | null },
    });

    // Live view state, owned by a Solid root created on open and disposed on
    // close so the dialog re-renders in place rather than being torn down and
    // rebuilt while the request is in flight.
    let readView: (() => View) | undefined;
    let writeView: ((next: View) => void) | undefined;
    let disposeRoot: (() => void) | undefined;
    let spinner: ReturnType<typeof setInterval> | undefined;
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

    const close = () => {
      // Guarded so an escape press that lands with no quota dialog on screen
      // cannot clear a dialog belonging to something else.
      if (!dialogIsOpen) return;
      dialogIsOpen = false;
      if (spinner !== undefined) {
        clearInterval(spinner);
        spinner = undefined;
      }
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

    const open = () => {
      // Ignore a second /quota while one is already on screen.
      if (dialogIsOpen) return;
      dialogIsOpen = true;

      const cached = cache.report;
      // createRoot passes its disposer to the callback, so the root can be torn
      // down later to release the signals it owns.
      disposeRoot = createRoot((dispose) => {
        const [signal, setSignal] = createSignal<View>(
          cached ? { status: "ready", report: cached } : { status: "loading" },
        );
        readView = signal;
        writeView = setSignal;
        return dispose;
      });

      // A fresh fetch always runs; the cache only decides what the first frame shows.
      spinner = setInterval(() => setFrame((n) => n + 1), 90);

      context.ui.dialog.set({ size: "large", centered: true });
      context.ui.dialog.show(
        () => <QuotaView read={readView!} frame={frame} />,
        () => close(),
      );

      void quota
        .report({})
        .then((result) => {
          const report = parseQuotaReport(result);
          patchCache((draft) => {
            draft.report = report;
          });
          writeView?.({ status: "ready", report });
        })
        .catch((error: unknown) => {
          writeView?.({ status: "error", message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          if (spinner !== undefined) {
            clearInterval(spinner);
            spinner = undefined;
          }
        });
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

    const Line = (props: { line: QuotaLine; now: number; width: number }) => {
      const meta = () => formatMeta(props.line, props.now);
      return (
        <box flexDirection="row">
          <text fg={muted}>{`${formatLabel(props.line.label, props.width)} `}</text>
          <text fg={tone(props.line.remainingPercent)}>{formatBar(props.line.remainingPercent, BAR_WIDTH)}</text>
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
      return (
        <box flexDirection="column" marginTop={1}>
          <text fg={muted}>{accountTitle(account())}</text>
          {account().status === "disabled" ? (
            <text fg={muted} opacity={0.7}>  disabled</text>
          ) : account().status === "error" ? (
            <text fg={muted} opacity={0.7}>{`  ${account().error ?? "error"}`}</text>
          ) : (
            lines().map((line) => <Line line={line} now={props.now} width={props.width} />)
          )}
        </box>
      );
    };

    const QuotaView = (props: { read: () => View; frame: () => number }) => {
      const current = () => props.read();
      // Read once so the union narrows; a second call would be untyped again.
      const now = () => {
        const state = current();
        return state.status === "ready" ? state.report.generatedAt : Date.now();
      };
      const width = () => {
        const state = current();
        if (state.status !== "ready") return MIN_LABEL_WIDTH;
        // Measure the width from what is actually displayed, so merging the
        // Gemini allowances does not leave a column sized for a hidden label.
        const widest = state.report.accounts.reduce((max, account) => {
          return Math.max(
            max,
            ...mergeGeminiAllowances(account.lines).map((line) => line.label.length),
          );
        }, MIN_LABEL_WIDTH);
        return Math.min(widest, MAX_LABEL_WIDTH);
      };

      return (
        <box
          flexDirection="column"
          paddingLeft={4}
          paddingRight={4}
          paddingBottom={1}
          // Halfway between none and a whole cell. Padding is measured in whole
          // cells, so an integer cannot express "a little": 0 leaves the title
          // against the panel edge and 1 pushes it a full line down. Yoga
          // resolves a percentage against the containing block's width, and a
          // terminal cell is about twice as tall as it is wide, so on a ~60
          // column dialog one row of vertical space is roughly 3.3%. This sits
          // between the two at about three quarters of a row.
          paddingTop="2.5%"
          // Second, independent way out. A custom dialog owns its own dismissal,
          // so the dialog's root renderable takes focus and closes on escape
          // directly. This does not rely on the host delivering keys to plugin
          // keymap layers while a dialog is on screen.
          focusable
          onKeyDown={(event) => {
            if (event.name === "escape") close();
          }}
        >
          <text fg={base}>Quota</text>

          {(() => {
            const state = current();
            if (state.status === "loading") {
              return (
                <box flexDirection="column" marginTop={1}>
                  <text fg={base}>{`${spinnerBar(props.frame())}  fetching…`}</text>
                </box>
              );
            }
            if (state.status === "error") {
              return <text fg={muted}>{state.message}</text>;
            }
            if (state.report.accounts.length === 0) {
              return <text fg={muted}>No quota data available.</text>;
            }
            return (
              <box flexDirection="column">
                {(["antigravity", "openai"] as const).map((provider) => {
                  const group = state.report.accounts.filter((account) => account.provider === provider);
                  if (group.length === 0) return null;
                  return (
                    <box flexDirection="column" marginTop={1}>
                      <text fg={base}>{provider === "antigravity" ? "Antigravity" : "OpenAI (Codex)"}</text>
                      {group.map((account) => (
                        <Account account={account} now={now()} width={width()} />
                      ))}
                    </box>
                  );
                })}
                {state.report.notes.map((note) => (
                  <text fg={muted} opacity={0.8}>{note}</text>
                ))}
              </box>
            );
          })()}

          <text fg={muted} opacity={0.6} marginTop={2}>esc to close</text>
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
          bindings: [CLOSE_COMMAND_ID],
        }));
        return null;
      },
    });
  },
});
