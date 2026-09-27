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
                    },
                    required: ["id", "label", "remainingPercent", "modelCount"],
                    additionalProperties: false,
                  },
                },
                geminiCli: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      modelId: { type: "string" },
                      remainingPercent: { type: "number" },
                      resetTime: { type: "string" },
                    },
                    required: ["modelId", "remainingPercent"],
                    additionalProperties: false,
                  },
                },
                geminiCliError: { type: "string" },
              },
              required: ["index", "status", "enabled", "groups", "geminiCli"],
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
    groups: Array<{
      id: string;
      label: string;
      remainingPercent: number;
      resetTime?: string;
      modelCount: number;
    }>;
    geminiCli: Array<{ modelId: string; remainingPercent: number; resetTime?: string }>;
    geminiCliError?: string;
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
 * Calls the Antigravity plugin's quota RPC.
 *
 * Returns undefined when the other plugin is not loaded or the call fails, so the
 * report can note the reason instead of erroring out.
 */
export async function fetchAntigravityQuota(
  rpc: RpcCaller,
  signal?: AbortSignal,
): Promise<AntigravityQuotaResult | undefined> {
  try {
    const client = rpc(AntigravityQuotaRpc);
    const result = await client.quota({});
    return result as AntigravityQuotaResult;
  } catch (error) {
    if (signal?.aborted) return undefined;
    throw error;
  }
}
