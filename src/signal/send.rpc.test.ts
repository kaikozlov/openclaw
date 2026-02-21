import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendPollSignal, terminatePollSignal, votePollSignal } from "./send-polls.js";
import {
  deleteMessageSignal,
  editMessageSignal,
  listStickerPacksSignal,
  sendMessageSignal,
  sendStickerSignal,
} from "./send.js";

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
  signalRpcRequest: (...args: unknown[]) => rpcMock(...args),
  signalRpcRequestWithRetry: (...args: unknown[]) => rpcMock(...args),
}));

describe("signal send RPC methods", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue({ timestamp: 1700000000001 });
  });

  it("sends markdown text through the send RPC method", async () => {
    await sendMessageSignal("signal:+15550002222", "**hi**");

    expect(rpcMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipient).toEqual(["+15550002222"]);
    expect(params.message).toBe("hi");
    expect(Array.isArray(params["text-style"])).toBe(true);
  });

  it("edits an existing message by passing editTimestamp to send RPC", async () => {
    await editMessageSignal("signal:+15550002222", "_updated_", 1700000000000);

    expect(rpcMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.editTimestamp).toBe(1700000000000);
    expect(params.recipient).toEqual(["+15550002222"]);
    expect(params.message).toBe("updated");
  });

  it("passes quote reply params when quoteTimestamp and quoteAuthor are provided", async () => {
    await sendMessageSignal("signal:group:test-group-id", "reply body", {
      quoteTimestamp: 1700000000123,
      quoteAuthor: "signal:uuid:123e4567-e89b-12d3-a456-426614174000",
      quoteMessage: "original text",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("test-group-id");
    expect(params.quoteTimestamp).toBe(1700000000123);
    expect(params.quoteAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params.quoteMessage).toBe("original text");
  });

  it("passes link preview params when previewUrl is provided", async () => {
    await sendMessageSignal("signal:+15550002222", "link body", {
      previewUrl: "https://example.com/post",
      previewTitle: "Example title",
      previewDescription: "Example description",
      previewImage: "https://example.com/preview.png",
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.previewUrl).toBe("https://example.com/post");
    expect(params.previewTitle).toBe("Example title");
    expect(params.previewDescription).toBe("Example description");
    expect(params.previewImage).toBe("https://example.com/preview.png");
  });

  it("passes mention ranges as mention params", async () => {
    await sendMessageSignal("signal:+15550002222", "Hi @Ada", {
      textMode: "plain",
      mentions: [
        {
          start: 3,
          length: 4,
          recipient: "uuid:123e4567-e89b-12d3-a456-426614174000",
        },
      ],
    });

    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.mention).toEqual(["3:4:123e4567-e89b-12d3-a456-426614174000"]);
  });

  it("rejects invalid edit timestamps", async () => {
    await expect(editMessageSignal("signal:+15550002222", "text", 0)).rejects.toThrow(
      "Signal edit requires a valid editTimestamp",
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("deletes a message with remoteDelete", async () => {
    await deleteMessageSignal("signal:group:test-group-id", 1700000000000);

    expect(rpcMock).toHaveBeenCalledWith("remoteDelete", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("test-group-id");
    expect(params.targetTimestamp).toBe(1700000000000);
  });

  it("sends stickers with packId:stickerId params", async () => {
    await sendStickerSignal("signal:group:test-group-id", "pack-abc", 7);

    expect(rpcMock).toHaveBeenCalledWith("send", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("test-group-id");
    expect(params.sticker).toBe("pack-abc:7");
  });

  it("lists sticker packs", async () => {
    rpcMock.mockResolvedValueOnce({
      stickerPacks: [{ packId: "pack-abc", title: "Cats" }],
    });

    const packs = await listStickerPacksSignal();

    expect(rpcMock).toHaveBeenCalledWith("listStickerPacks", expect.anything(), expect.any(Object));
    expect(packs).toEqual([{ packId: "pack-abc", title: "Cats" }]);
  });

  it("creates Signal polls via sendPollCreate", async () => {
    await sendPollSignal("signal:group:test-group-id", {
      question: "Ready?",
      options: ["Yes", "No"],
      maxSelections: 1,
    });

    expect(rpcMock).toHaveBeenCalledWith("sendPollCreate", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("test-group-id");
    expect(params.question).toBe("Ready?");
    expect(params.option).toEqual(["Yes", "No"]);
    expect(params.noMulti).toBe(true);
  });

  it("sends multi-select polls with noMulti=false", async () => {
    await sendPollSignal("signal:+15550002222", {
      question: "Pick two",
      options: ["A", "B", "C"],
      maxSelections: 2,
    });

    expect(rpcMock).toHaveBeenCalledWith("sendPollCreate", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipient).toEqual(["+15550002222"]);
    expect(params.noMulti).toBe(false);
  });

  it("votes on Signal polls via sendPollVote", async () => {
    await votePollSignal(
      "signal:+15550002222",
      1700000000123,
      "signal:uuid:123e4567-e89b-12d3-a456-426614174000",
      [0, 2],
      { voteCount: 3 },
    );

    expect(rpcMock).toHaveBeenCalledWith("sendPollVote", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipient).toEqual(["+15550002222"]);
    expect(params.pollTimestamp).toBe(1700000000123);
    expect(params.pollAuthor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(params.option).toEqual([0, 2]);
    expect(params.voteCount).toBe(3);
  });

  it("terminates Signal polls via sendPollTerminate", async () => {
    await terminatePollSignal("signal:group:test-group-id", 1700000000222);

    expect(rpcMock).toHaveBeenCalledWith(
      "sendPollTerminate",
      expect.any(Object),
      expect.any(Object),
    );
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("test-group-id");
    expect(params.pollTimestamp).toBe(1700000000222);
  });
});
