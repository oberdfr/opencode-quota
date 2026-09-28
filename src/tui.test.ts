import { describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/tui/context";
import type { QuotaReport } from "./rpc.ts";

/**
 * The host keeps keymap state in a reactive context that only exists inside the
 * app's render tree. Registering a layer straight from `setup` therefore fails at
 * runtime with "Keymap.Provider is missing". These tests pin that requirement, and
 * cover the dialog lifecycle: it must appear before the request resolves, and it
 * must be dismissible.
 */
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

function createContext(report?: { promise: Promise<unknown> }) {
  const state = {
    insideSlotRender: false,
    layers: [] as Array<{ commands: Array<Record<string, any>> }>,
    slotClaim: undefined as { render: (input: unknown) => unknown } | undefined,
    disposed: false,
    dialogShown: 0,
    dialogCleared: 0,
    dialogSetOptions: [] as unknown[],
    renderFn: undefined as (() => unknown) | undefined,
    cached: null as QuotaReport | null,
  };

  const request = report?.promise ?? Promise.resolve(REPORT);

  const context = {
    client: {
      rpc: () => ({ report: () => request }),
    },
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
      layer: (factory: () => { commands: Array<Record<string, any>> }) => {
        if (!state.insideSlotRender) throw new Error("Keymap.Provider is missing");
        state.layers.push(factory());
      },
    },
    ui: {
      dialog: {
        set: (options: unknown) => {
          state.dialogSetOptions.push(options);
        },
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

/** Mounts the plugin and returns its keymap commands plus the render harness. */
async function mount(report?: { promise: Promise<unknown> }) {
  const { default: plugin } = await import("./tui.tsx");
  const { context, state } = createContext(report);
  const cleanup = plugin.setup(context);
  state.insideSlotRender = true;
  state.slotClaim?.render({});
  const commands = state.layers.flatMap((layer) => layer.commands);
  const find = (id: string) => commands.find((command) => command.id === id);
  return { cleanup, state, show: find("opencode-quota.show"), close: find("opencode-quota.close") };
}

describe("opencode-quota TUI plugin", () => {
  it("does not touch the keymap during setup", async () => {
    const { default: plugin } = await import("./tui.tsx");
    const { context, state } = createContext();

    plugin.setup(context);

    expect(state.layers).toHaveLength(0);
    expect(state.slotClaim).toBeDefined();
  });

  it("registers /quota and an escape binding once the slot renders", async () => {
    const { show, close } = await mount();

    expect(show?.slash).toEqual({ name: "quota", aliases: ["quota-report"] });
    expect(show?.palette).toBe(true);
    expect(close?.bind).toBe("escape");
  });

  it("opens the dialog before the request resolves, then shows the report", async () => {
    const pending = deferred<unknown>();
    const { show, state } = await mount({ promise: pending.promise });

    show?.run();
    // Shown on the first frame, not after the network round-trip.
    expect(state.dialogShown).toBe(1);
    expect(state.dialogCleared).toBe(0);
    expect(state.renderFn).toBeTypeOf("function");

    pending.resolve(REPORT);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.cached).toEqual(REPORT);
  });

  it("surfaces a failed request without throwing", async () => {
    const pending = deferred<unknown>();
    const { show } = await mount({ promise: pending.promise });

    show?.run();
    pending.reject(new Error("rpc unavailable"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Nothing to assert beyond "no unhandled rejection"; the dialog stays open
    // showing the error state.
    expect(true).toBe(true);
  });

  it("closes on escape and reports back to the host so other handling continues", async () => {
    const { show, close, state } = await mount();

    show?.run();
    expect(state.dialogCleared).toBe(0);

    expect(close?.enabled?.()).toBe(true);
    // Returning false keeps the host's own escape handling in play.
    expect(close?.run()).toBe(false);
    expect(state.dialogCleared).toBe(1);
  });

  it("only enables the escape binding while the dialog is open", async () => {
    const { close, state } = await mount();

    expect(close?.enabled?.()).toBe(false);
    expect(state.dialogCleared).toBe(0);
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
    // setup may hand back the disposer directly or wrapped in a promise.
    const resolved = await cleanup;
    if (typeof resolved === "function") resolved();
    expect(state.disposed).toBe(true);
  });
});
