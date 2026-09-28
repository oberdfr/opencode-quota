import { describe, expect, it, vi } from "vitest";
import type { Context } from "@opencode/plugin/tui/context";

/**
 * The host keeps keymap state in a reactive context that only exists inside the
 * app's render tree. Registering a layer straight from `setup` therefore fails at
 * runtime with "Keymap.Provider is missing". These tests pin the requirement:
 * setup may claim a slot, but the keymap layer must be created from the slot's
 * render function.
 */
function createContext() {
  const state = {
    insideSlotRender: false,
    layerCalls: [] as unknown[],
    slotClaim: undefined as { render: (input: unknown) => unknown } | undefined,
    disposed: false,
  };

  const context = {
    client: {
      rpc: () => ({
        report: async () => ({
          generatedAt: 1,
          accounts: [],
          notes: [],
        }),
      }),
    },
    keymap: {
      layer: (factory: () => unknown) => {
        if (!state.insideSlotRender) {
          throw new Error("Keymap.Provider is missing");
        }
        state.layerCalls.push(factory());
      },
    },
    ui: {
      dialog: {
        set: vi.fn(),
        show: vi.fn(),
        clear: vi.fn(),
      },
      slot: (claim: { render: (input: unknown) => unknown }) => {
        state.slotClaim = claim;
        return () => {
          state.disposed = true;
        };
      },
    },
    theme: { text: { base: "#fff", muted: "#999" } },
  } as unknown as Context;

  return { context, state };
}

describe("opencode-quota TUI plugin", () => {
  it("does not touch the keymap during setup", async () => {
    const { default: plugin } = await import("./tui.tsx");
    const { context, state } = createContext();

    const cleanup = plugin.setup(context);

    expect(state.layerCalls).toHaveLength(0);
    expect(state.slotClaim).toBeDefined();
    expect(typeof cleanup).toBe("function");
  });

  it("registers the /quota command when the slot renders", async () => {
    const { default: plugin } = await import("./tui.tsx");
    const { context, state } = createContext();

    plugin.setup(context);

    state.insideSlotRender = true;
    state.slotClaim?.render({});

    expect(state.layerCalls).toHaveLength(1);
    const layer = state.layerCalls[0] as {
      mode: string;
      commands: Array<{ id: string; slash?: { name: string; aliases?: string[] }; palette?: boolean }>;
    };

    expect(layer.mode).toBe("global");
    expect(layer.commands[0]?.id).toBe("opencode-quota.show");
    expect(layer.commands[0]?.slash).toEqual({ name: "quota", aliases: ["quota-report"] });
    expect(layer.commands[0]?.palette).toBe(true);
  });

  it("returns a disposer that releases the slot", async () => {
    const { default: plugin } = await import("./tui.tsx");
    const { context, state } = createContext();

    const cleanup = plugin.setup(context);
    expect(state.disposed).toBe(false);

    cleanup?.();
    expect(state.disposed).toBe(true);
  });
});
