import { describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/tui/context";
import type { QuotaReport } from "./rpc.ts";

/**
 * Two things are pinned here.
 *
 * 1. The host keeps keymap state in a reactive context that only exists inside
 *    the app's render tree, so a layer registered straight from `setup` fails at
 *    runtime with "Keymap.Provider is missing".
 * 2. The host evaluates a layer through a memo. Anything a command's `enabled`
 *    reads therefore has to be a signal, or the value is computed once and
 *    cached. A plain closure variable left the escape binding permanently
 *    disabled, so the dialog could not be dismissed.
 */

const CLOSE_ID = "opencode-quota.close";
const SHOW_ID = "opencode-quota.show";

const REPORT: QuotaReport = {
  generatedAt: 1_700_000_000_000,
  notes: [],
  accounts: [
    {
      key: "antigravity:work@example.com",
      provider: "antigravity",
      email: "work@example.com",
      status: "ok",
      lines: [{ id: "claude", label: "Claude", remainingPercent: 43 }],
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type LayerFactory = () => { commands: Array<Record<string, any>>; bindings?: string[] };

function createContext(report?: { promise: Promise<unknown> }) {
  const state = {
    insideSlotRender: false,
    factory: undefined as LayerFactory | undefined,
    slotClaim: undefined as { render: (input: unknown) => unknown } | undefined,
    disposed: false,
    dialogShown: 0,
    dialogCleared: 0,
    renderFn: undefined as (() => unknown) | undefined,
    cached: null as QuotaReport | null,
  };

  const request = report?.promise ?? Promise.resolve(REPORT);

  const context = {
    client: { rpc: () => ({ report: () => request }) },
    storage: {
      memory: (_key: string, options: { initial: { report: QuotaReport | null } }) => {
        const store = { report: options.initial.report };
        return [
          store,
          (mutation: (draft: { report: QuotaReport | null }) => void) => {
            mutation(store);
            state.cached = store.report;
          },
        ] as const;
      },
    },
    keymap: {
      layer: (factory: LayerFactory) => {
        if (!state.insideSlotRender) throw new Error("Keymap.Provider is missing");
        state.factory = factory;
      },
    },
    ui: {
      dialog: {
        set: vi.fn(),
        show: (render: () => unknown) => {
          state.dialogShown += 1;
          state.renderFn = render;
        },
        clear: () => {
          state.dialogCleared += 1;
        },
      },
      slot: (claim: { render: (input: unknown) => unknown }) => {
        state.slotClaim = claim;
        return () => {
          state.disposed = true;
        };
      },
    },
    theme: { text: { base: "#eee", muted: "#888" }, success: { base: "#0f0" } },
  } as unknown as Context;

  return { context, state };
}

/**
 * Mounts the plugin and exposes the layer factory it registered.
 *
 * The layer is read by calling the factory directly rather than through a
 * reactive memo: this test environment resolves `solid-js` to its server build,
 * where reactivity is a stubbed no-op, so a memo would never re-evaluate and
 * would test nothing. That is also why the plugin no longer depends on reactive
 * gating for its dismiss binding.
 */
async function mount(report?: { promise: Promise<unknown> }) {
  const { default: plugin } = await import("./tui.tsx");
  const { context, state } = createContext(report);
  const cleanup = plugin.setup(context);
  state.insideSlotRender = true;
  state.slotClaim?.render({});

  const layer = () => state.factory!();
  const find = (id: string) => layer().commands.find((command: Record<string, any>) => command.id === id);

  return {
    cleanup,
    state,
    layer,
    show: find(SHOW_ID),
    close: find(CLOSE_ID),
  };
}

describe("opencode-quota TUI plugin", () => {
  it("does not touch the keymap during setup", async () => {
    const { default: plugin } = await import("./tui.tsx");
    const { context, state } = createContext();

    plugin.setup(context);

    expect(state.factory).toBeUndefined();
    expect(state.slotClaim).toBeDefined();
  });

  it("registers /quota and an escape binding once the slot renders", async () => {
    const { show, close, layer } = await mount();

    expect(show?.slash).toEqual({ name: "quota", aliases: ["quota-report"] });
    expect(show?.palette).toBe(true);
    expect(close?.bind).toBe("escape");
    // A command's `bind` is inert unless its id is listed here.
    expect(layer().bindings).toEqual([CLOSE_ID]);
  });

  it("registers the close binding without an enabled gate", async () => {
    // The host resolves `enabled` reactively, so gating the binding on live
    // state risks it being evaluated once and cached with no way to re-check.
    // The binding is therefore always registered and `close()` guards itself.
    const { close } = await mount();

    expect(close?.bind).toBe("escape");
    expect(close?.enabled).toBeUndefined();
  });

  it("activates the close binding by listing the command in bindings", async () => {
    // A command's `bind` is inert unless its id appears in the layer's
    // `bindings`, so this is what makes escape reach the plugin at all.
    const { layer } = await mount();

    expect(layer().bindings).toEqual([CLOSE_ID]);
  });

  it("opens the dialog before the request resolves, then shows the report", async () => {
    const pending = deferred<unknown>();
    const { show, state } = await mount({ promise: pending.promise });

    show?.run();
    // Shown on the first frame, not after the round-trip.
    expect(state.dialogShown).toBe(1);
    expect(state.renderFn).toBeTypeOf("function");

    pending.resolve(REPORT);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.cached).toEqual(REPORT);
  });

  it("surfaces a failed request without throwing", async () => {
    const pending = deferred<unknown>();
    const { show, state } = await mount({ promise: pending.promise });

    show?.run();
    pending.reject(new Error("rpc unavailable"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.dialogShown).toBe(1);
  });

  it("closes on escape and lets the host keep handling the key", async () => {
    const { show, state } = await mount();

    show?.run();
    expect(state.dialogCleared).toBe(0);

    const close = closeFrom(state.factory!(), CLOSE_ID);
    // Returning false keeps the host's own escape handling in play.
    expect(close?.run()).toBe(false);
    expect(state.dialogCleared).toBe(1);
  });

  it("ignores escape when no quota dialog is open", async () => {
    // Otherwise a stray escape could clear a dialog owned by something else.
    const { state } = await mount();

    closeFrom(state.factory!(), CLOSE_ID)?.run();

    expect(state.dialogCleared).toBe(0);
  });

  it("can be reopened after being closed", async () => {
    const { show, state } = await mount();

    show?.run();
    closeFrom(state.factory!(), CLOSE_ID)?.run();
    show?.run();

    expect(state.dialogShown).toBe(2);
    expect(state.dialogCleared).toBe(1);
  });

  it("ignores a second /quota while the dialog is already open", async () => {
    const { show, state } = await mount();

    show?.run();
    show?.run();

    expect(state.dialogShown).toBe(1);
  });

  it("returns a disposer that releases the slot", async () => {
    const { cleanup, state } = await mount();

    expect(state.disposed).toBe(false);
    const resolved = await cleanup;
    if (typeof resolved === "function") resolved();
    expect(state.disposed).toBe(true);
  });
});

/**
 * Reads a command from a freshly evaluated layer.
 *
 * Note: the dialog's JSX tree cannot be asserted on here. OpenTUI's JSX runtime
 * instantiates intrinsic elements through a live renderer, so calling the
 * render function throws without one, and the plugin ships no test renderer. The
 * dialog's own `onKeyDown` handler is therefore covered by the type checker and
 * review, not by a unit test.
 */
function closeFrom(layer: { commands: Array<Record<string, any>> }, id: string) {
  return layer.commands.find((command) => command.id === id);
}
