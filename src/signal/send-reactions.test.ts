import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";

const rpcMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "default",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequestWithRetry: (...args: unknown[]) => rpcMock(...args),
}));

describe("sendReactionSignal", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 123, results: [{ type: "SUCCESS" }] });
  });

  it("requires targetAuthor for direct chats", async () => {
    await expect(sendReactionSignal("+15551230000", 123, "🔥")).rejects.toThrow(
      /targetAuthor is required for direct reactions/i,
    );
    expect(rpcMock).toHaveBeenCalledTimes(0);
  });

  it("uses explicit targetAuthor for direct chats", async () => {
    await sendReactionSignal("+15551230000", 123, "🔥", {
      targetAuthor: "+15551230000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.groupIds).toBeUndefined();
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params).not.toHaveProperty("recipient");
    expect(params).not.toHaveProperty("groupId");
  });

  it("uses explicit targetAuthor for uuid dms", async () => {
    await sendReactionSignal("uuid:123e4567-e89b-12d3-a456-426614174000", 123, "🔥", {
      targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(params.recipients).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
    expect(params.groupIds).toBeUndefined();
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params).not.toHaveProperty("recipient");
    expect(params).not.toHaveProperty("groupId");
  });

  it("uses groupIds array and maps targetAuthorUuid", async () => {
    await sendReactionSignal("", 123, "✅", {
      groupId: "group-id",
      targetAuthorUuid: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipients).toBeUndefined();
    expect(params.groupIds).toEqual(["group-id"]);
    expect(params.targetAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
  });

  it("requires targetAuthor for direct removals", async () => {
    await expect(removeReactionSignal("+15551230000", 456, "❌")).rejects.toThrow(
      /targetAuthor is required for direct reaction removal/i,
    );
    expect(rpcMock).toHaveBeenCalledTimes(0);
  });

  it("uses explicit targetAuthor for direct removals", async () => {
    await removeReactionSignal("+15551230000", 456, "❌", {
      targetAuthor: "+15551230000",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(params.recipients).toEqual(["+15551230000"]);
    expect(params.targetAuthor).toBe("+15551230000");
    expect(params.remove).toBe(true);
  });

  it("propagates RPC errors without fallback retries", async () => {
    rpcMock.mockRejectedValueOnce(new Error("request failed"));
    await expect(
      sendReactionSignal("+15551230000", 789, "✅", { targetAuthor: "+15551230000" }),
    ).rejects.toThrow(/request failed/i);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("throws when direct recipient results are non-success", async () => {
    const failedResult = {
      timestamp: 123,
      results: [{ type: "UNREGISTERED_FAILURE", recipientAddress: { number: "+15551230000" } }],
    };
    rpcMock.mockResolvedValueOnce(failedResult);

    await expect(
      sendReactionSignal("+15551230000", 123, "✅", { targetAuthor: "+15551230000" }),
    ).rejects.toThrow(/sendReaction failed/i);
  });
});
