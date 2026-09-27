/**
 * opencode-quota — server half.
 *
 * Collects quota for every connected account and exposes it over RPC. The TUI
 * half registers `/quota` and calls this, which keeps the data collection on the
 * server where credentials already live.
 *
 * Two providers are supported, and they work very differently:
 *
 * - Antigravity polls a quota endpoint, but only the opencode-antigravity-auth
 *   plugin knows the credentials and the endpoint, so this plugin calls that
 *   plugin's read-only RPC.
 * - OpenAI (Codex) quota is read from the WHAM usage endpoint with the ChatGPT
 *   OAuth credential OpenCode already stores for the `openai` integration.
 */

import { Plugin } from "@opencode/plugin";
import type { Context } from "@opencode/plugin/promise/plugin";
import { QuotaRpc, type QuotaAccount, type QuotaLine, type QuotaReport } from "./rpc.ts";
import { fetchAntigravityQuota, type RpcCaller } from "./antigravity.ts";
import { fetchCodexUsage, type CodexCredential } from "./codex.ts";

const PLUGIN_ID = "opencode-quota";
const OPENAI_INTEGRATION = "openai";

interface QuotaOptions {
  /**
   * Observe Codex quota from response headers instead of polling.
   *
   * Off by default: registering an `http.response` hook keeps the provider on
   * HTTP transport, which forfeits the WebSocket context reuse that OpenAI
   * Responses sessions otherwise get. Enable it only if polling is blocked.
   */
  observeCodexHeaders?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function pickString(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

const ACCOUNT_ID_KEYS = [
  "accountId",
  "account_id",
  "chatgpt_account_id",
  "chatgptAccountId",
  "organizationId",
  "organization_id",
];

/**
 * Reads the active OpenAI credential and the ChatGPT account id it targets.
 *
 * The account id is required by the WHAM endpoint and is stored differently
 * depending on how the account was connected, so several spellings are probed,
 * including a nested `tokens` object mirroring the Codex CLI auth file.
 */
async function resolveCodexCredential(ctx: Context): Promise<
  { credential: CodexCredential } | { error: string } | undefined
> {
  const connection = await ctx.integration.connection.active(OPENAI_INTEGRATION);
  if (!connection) return { error: "No OpenAI account connected" };

  const resolved = await ctx.integration.connection.resolve(connection);
  if (!resolved) return { error: "The active OpenAI account has no readable credential" };
  if (resolved.type !== "oauth") {
    return { error: "Codex quota needs a ChatGPT OAuth account, not an API key" };
  }

  const metadata = asRecord(resolved.metadata);
  const tokens = asRecord(metadata?.tokens);
  const accountId = pickString(metadata, ACCOUNT_ID_KEYS) ?? pickString(tokens, ACCOUNT_ID_KEYS);
  const label = pickString(metadata, ["email", "label"]) ?? pickString(tokens, ["email"]);

  if (!resolved.access) return { error: "The active OpenAI account has no access token" };

  return {
    credential: {
      accessToken: resolved.access,
      ...(accountId ? { accountId } : {}),
      ...(label ? { label } : {}),
    },
  };
}

function codexAccounts(usage: Awaited<ReturnType<typeof fetchCodexUsage>>, label?: string): QuotaAccount[] {
  if (!usage) return [];

  const lines: QuotaLine[] = [];
  if (usage.primary) lines.push(usage.primary);
  if (usage.secondary) lines.push(usage.secondary);
  lines.push(...usage.additional);

  if (usage.hasCredits && usage.creditsBalance !== undefined) {
    lines.push({
      id: "credits",
      label: "Credits balance",
      remainingPercent: 0,
    });
  }

  return [
    {
      key: label ? `openai:${label}` : "openai:active",
      provider: "openai",
      ...(label ? { email: label } : {}),
      ...(usage.plan ? { plan: usage.plan } : {}),
      status: usage.limitReached ? "error" : "ok",
      ...(usage.limitReached ? { error: "Usage limit reached" } : {}),
      lines,
    },
  ];
}

function antigravityAccounts(result: Awaited<ReturnType<typeof fetchAntigravityQuota>>): QuotaAccount[] {
  if (!result?.available) return [];

  return result.accounts.map((account) => {
    const key = account.email ?? `antigravity:${account.index}`;
    const lines: QuotaLine[] = account.groups.map((group) => ({
      id: `antigravity:${group.id}`,
      label: group.label,
      remainingPercent: group.remainingPercent,
      ...(group.resetTime ? { resetTime: group.resetTime } : {}),
    }));

    for (const model of account.geminiCli) {
      lines.push({
        id: `gemini-cli:${model.modelId}`,
        label: `Gemini CLI · ${model.modelId}`,
        remainingPercent: model.remainingPercent,
        ...(model.resetTime ? { resetTime: model.resetTime } : {}),
      });
    }

    return {
      key: `antigravity:${key}`,
      provider: "antigravity",
      ...(account.email ? { email: account.email } : {}),
      status: account.status === "ok" ? (account.enabled ? "ok" : "disabled") : account.status,
      ...(account.error ? { error: account.error } : {}),
      lines,
    };
  });
}

export const QuotaPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = (ctx.options ?? {}) as QuotaOptions;

    const collect = async (signal?: AbortSignal): Promise<QuotaReport> => {
      const notes: string[] = [];
      const [antigravity, openai] = await Promise.allSettled([
        fetchAntigravityQuota(ctx.rpc as unknown as RpcCaller, signal),
        resolveCodexCredential(ctx).then(async (resolved) => {
          if (resolved && "error" in resolved) return { note: resolved.error } as const;
          if (!resolved) return { note: "No OpenAI account connected" } as const;
          return { usage: await fetchCodexUsage(resolved.credential, signal), label: resolved.credential.label };
        }),
      ]);

      const accounts: QuotaAccount[] = [];

      if (antigravity.status === "fulfilled" && antigravity.value) {
        accounts.push(...antigravityAccounts(antigravity.value));
        if (!antigravity.value.available && antigravity.value.reason) {
          notes.push(`Antigravity: ${antigravity.value.reason}`);
        }
      } else if (antigravity.status === "rejected") {
        notes.push("Antigravity: the opencode-antigravity-auth plugin did not answer");
      }

      if (openai.status === "fulfilled") {
        if ("note" in openai.value) {
          notes.push(`OpenAI: ${openai.value.note}`);
        } else {
          const codex = codexAccounts(openai.value.usage, openai.value.label);
          if (codex.length === 0) notes.push("OpenAI: no Codex quota available for this account");
          accounts.push(...codex);
        }
      } else {
        notes.push(`OpenAI: ${String(openai.reason)}`);
      }

      return { generatedAt: Date.now(), accounts, notes };
    };

    const registration = await ctx.rpc.register(QuotaRpc, {
      report: async (_input, context) => collect(context.signal),
    });

    if (options.observeCodexHeaders) {
      // Opt-in fallback only. The hook forces the provider onto HTTP transport,
      // so this stays off unless polling is unavailable.
      await ctx.session.hook("http.response", () => {}, { providerID: OPENAI_INTEGRATION });
    }

    return () => registration.dispose();
  },
});

export default QuotaPlugin;
