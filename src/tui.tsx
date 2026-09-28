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
import { formatBar, formatLabel, formatMeta, quotaTone } from "./format.ts";

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

/** Widest label across the whole report so every bar starts in the same column. */
function labelWidthFor(report: QuotaReport): number {
  let widest = MIN_LABEL_WIDTH;
  for (const account of report.accounts) {
    for (const line of account.lines) widest = Math.max(widest, line.label.length);
  }
  return Math.min(widest, MAX_LABEL_WIDTH);
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

    const close = () => {
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
      if (disposeRoot) return;

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
      return (
        <box flexDirection="column" marginTop={1}>
          <text fg={muted}>{accountTitle(account())}</text>
          {account().status === "disabled" ? (
            <text fg={muted} opacity={0.7}>  disabled</text>
          ) : account().status === "error" ? (
            <text fg={muted} opacity={0.7}>{`  ${account().error ?? "error"}`}</text>
          ) : (
            account().lines.map((line) => <Line line={line} now={props.now} width={props.width} />)
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
        return state.status === "ready" ? labelWidthFor(state.report) : MIN_LABEL_WIDTH;
      };

      return (
        <box flexDirection="column" paddingLeft={4} paddingRight={4}>
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

          <text fg={muted} opacity={0.6} marginTop={1}>esc to close</text>
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
              // Only active while the dialog is up, so escape keeps its normal
              // meaning everywhere else.
              enabled: () => disposeRoot !== undefined,
              run: () => {
                close();
                // Let the host keep handling the key it was already seeing.
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
