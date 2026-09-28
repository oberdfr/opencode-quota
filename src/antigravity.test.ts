import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAntigravityQuota, type RpcCaller } from "./antigravity.ts";

/**
 * The quota RPC is a hop into another plugin, so a call that never settles would
 * hold the report open with no way to tell it apart from a slow read. These tests
 * pin the three outcomes that has to produce: an answer, a failure, and a bounded
 * wait.
 */

const RESULT = {
  available: true,
  accounts: [
    {
      index: 0,
      status: "ok" as const,
      enabled: true,
      groups: [],
      geminiCli: [],
    },
  ],
};

function callerReturning(response: () => Promise<unknown>): RpcCaller {
  return (() => ({ quota: () => response() })) as unknown as RpcCaller;
}

describe("fetchAntigravityQuota", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result when the other plugin answers", async () => {
    const rpc = callerReturning(() => Promise.resolve(RESULT));

    await expect(fetchAntigravityQuota(rpc)).resolves.toEqual(RESULT);
  });

  it("propagates a failure so the report can note it", async () => {
    const rpc = callerReturning(() => Promise.reject(new Error("no such method")));

    await expect(fetchAntigravityQuota(rpc)).rejects.toThrow("no such method");
  });

  it("reports unavailability instead of waiting forever", async () => {
    vi.useFakeTimers();
    const rpc = callerReturning(() => new Promise(() => {}));

    const pending = fetchAntigravityQuota(rpc);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toEqual({
      available: false,
      reason: "opencode-antigravity-auth no answer within 30s",
      accounts: [],
    });
  });

  it("stays quiet about a call the caller aborted", async () => {
    const controller = new AbortController();
    const rpc = callerReturning(() => Promise.reject(new Error("aborted")));
    controller.abort();

    // A cancelled request is not a failure worth reporting.
    await expect(fetchAntigravityQuota(rpc, controller.signal)).resolves.toBeUndefined();
  });
});
