/**
 * Antigravity half of the quota report.
 *
 * The quota data lives in the opencode-antigravity-auth plugin, which exposes a
 * read-only `antigravity.quota` RPC. This plugin mirrors that definition instead
 * of depending on the other package: RPCs are routed by id, so the two
 * declarations resolve to the same server-side registration while the packages
 * stay independent. Keep the schemas in sync with `src/plugin/rpc.ts` there.
 */

import { Rpc } from "@opencode/plugin/rpc";

const AntigravityQuotaRpc = Rpc.define({
  id: "antigravity",
  methods: {
    quota: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          available: { type: "boolean" },
          reason: { type: "string" },
          accounts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "number" },
                email: { type: "string" },
                status: { type: "string", enum: ["ok", "disabled", "error"] },
                error: { type: "string" },
                enabled: { type: "boolean" },
                subscription: { type: "object" },
                groups: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      label: { type: "string" },
                      remainingPercent: { type: "number" },
                      resetTime: { type: "string" },
                      modelCount: { type: "number" },
                      // Declared because the schema forbids extra properties: a
                      // field the provider sets but the schema omits is dropped.
                      windowMinutes: { type: "number" },
                    },
                    required: ["id", "label", "remainingPercent", "modelCount"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["index", "status", "enabled", "groups"],
              additionalProperties: false,
            },
          },
        },
        required: ["available", "accounts"],
        additionalProperties: false,
      },
    },
  },
  events: {},
});

export interface AntigravityQuotaResult {
  available: boolean;
  reason?: string;
  accounts: Array<{
    index: number;
    email?: string;
    status: "ok" | "disabled" | "error";
    error?: string;
    enabled: boolean;
    /** The account's plan, when project resolution reported one. */
    subscription?: { id: string; name?: string };
    groups: Array<{
      id: string;
      label: string;
      remainingPercent: number;
      resetTime?: string;
      modelCount: number;
      /** Minutes until the window refills, when the provider reports a reset. */
      windowMinutes?: number;
    }>;
  }>;
}

export interface RpcCaller {
  <D extends Rpc.PortableDefinition>(definition: D): {
    [Name in keyof D["methods"]]: (
      input?: unknown,
    ) => Promise<unknown>;
  };
}

/**
 * How long the other plugin gets to answer before the call is given up on.
 *
 * The quota RPC is a hop into another plugin, so a call that never settles would
 * hold this report open with no way to tell it apart from a slow read. A timeout
 * turns that into a note in the report instead of a request that never returns.
 */
const ANTIGRAVITY_TIMEOUT_MS = 30_000;

/**
 * Calls the Antigravity plugin's quota RPC.
 *
 * Returns undefined when the other plugin is not loaded or the call fails, so the
 * report can note the reason instead of erroring out. A call that outlives the
 * timeout reports itself as unavailable with the reason spelled out.
 */
export async function fetchAntigravityQuota(
  rpc: RpcCaller,
  signal?: AbortSignal,
): Promise<AntigravityQuotaResult | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${ANTIGRAVITY_TIMEOUT_MS / 1000}s`)),
      ANTIGRAVITY_TIMEOUT_MS,
    );
  });

  try {
    const client = rpc(AntigravityQuotaRpc);
    const result = await Promise.race([client.quota({}), timeout]);
    return result as AntigravityQuotaResult;
  } catch (error) {
    if (signal?.aborted) return undefined;
    const message = error instanceof Error ? error.message : String(error);
    // A timeout is reported like any other absence, with the reason attached, so
    // the dialog shows why the section is empty rather than an unexplained gap.
    if (message.includes("no answer within")) {
      return { available: false, reason: `opencode-antigravity-auth ${message}`, accounts: [] };
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
