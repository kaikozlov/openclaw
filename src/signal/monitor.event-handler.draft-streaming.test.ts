import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./monitor/event-handler.test-harness.js";

const dispatchInboundMessageMock = vi.fn();
const createSignalDraftStreamMock = vi.fn();

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: (...args: unknown[]) => dispatchInboundMessageMock(...args),
  dispatchInboundMessageWithDispatcher: (...args: unknown[]) => dispatchInboundMessageMock(...args),
  dispatchInboundMessageWithBufferedDispatcher: (...args: unknown[]) =>
    dispatchInboundMessageMock(...args),
}));

vi.mock("./draft-stream.js", () => ({
  createSignalDraftStream: (...args: unknown[]) => createSignalDraftStreamMock(...args),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

function createDraftStreamStub(timestamp = 1700000001111) {
  return {
    update: vi.fn(),
    flush: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceNewMessage: vi.fn(),
    messageTimestamp: vi.fn(() => timestamp),
  };
}

describe("signal event handler draft streaming", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
    createSignalDraftStreamMock.mockReset();
  });

  it("uses draft streaming callbacks and edits the first final delivery", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "draft answer   " });
      dispatcher.sendFinalReply({ text: "final answer" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(createSignalDraftStreamMock).toHaveBeenCalledTimes(1);
    const dispatchArgs = dispatchInboundMessageMock.mock.calls[0]?.[0] as {
      replyOptions?: { disableBlockStreaming?: boolean };
    };
    expect(dispatchArgs.replyOptions?.disableBlockStreaming).toBe(true);
    expect(draftStream.update).toHaveBeenCalledWith("draft answer");
    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(draftStream.stop).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        editTimestamp: 1700000001111,
      }),
    );
  });

  it("does not split draft stream on reasoning end before final delivery", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "draft answer" });
      await replyOptions?.onReasoningEnd?.();
      dispatcher.sendFinalReply({ text: "final answer" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        editTimestamp: 1700000001111,
      }),
    );
  });

  it("reuses draft edit timestamp for multiple final payloads in one assistant turn", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "draft answer" });
      dispatcher.sendFinalReply({ text: "short final" });
      dispatcher.sendFinalReply({ text: "full final with more detail" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 2 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        editTimestamp: 1700000001111,
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        editTimestamp: 1700000001111,
      }),
    );
  });

  it("skips regressive shorter final edits when preview already has longer text", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "full final text with tail" });
      dispatcher.sendFinalReply({ text: "full final text with tail" });
      dispatcher.sendFinalReply({ text: "full final text" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 2 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "full final text with tail" })],
        editTimestamp: 1700000001111,
      }),
    );
  });

  it("keeps draft edit path intact across tool-result delivery", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "draft before tool" });
      dispatcher.sendToolResult({ text: "tool output" });
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onPartialReply?.({ text: "draft after tool" });
      dispatcher.sendFinalReply({ text: "final answer after tool" });
      return { queuedFinal: true, counts: { tool: 1, block: 0, final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "tool output" })],
      }),
    );
    expect(deliverReplies.mock.calls[0]?.[0]).not.toHaveProperty("editTimestamp");
    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "final answer after tool" })],
        editTimestamp: 1700000001111,
      }),
    );
  });

  it("forces a new draft message only after a preview-finalized assistant turn", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "first draft" });
      dispatcher.sendFinalReply({ text: "first final" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onPartialReply?.({ text: "second draft" });
      dispatcher.sendFinalReply({ text: "second final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 2 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledTimes(2);
  });

  it("falls back to a normal send and clears preview when preview-finalize edit fails", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async (params?: { editTimestamp?: number }) => {
      if (typeof params?.editTimestamp === "number") {
        throw new Error("edit failed");
      }
    });
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "draft answer" });
      dispatcher.sendFinalReply({ text: "final answer" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        editTimestamp: 1700000001111,
      }),
    );
    expect(deliverReplies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "final answer" })],
      }),
    );
    expect(deliverReplies.mock.calls[1]?.[0]).not.toHaveProperty("editTimestamp");
  });

  it("clears preview before final media sends", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "draft answer" });
      dispatcher.sendFinalReply({ text: "final with media", mediaUrl: "/tmp/pic.png" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "final with media" })],
      }),
    );
    expect(deliverReplies.mock.calls[0]?.[0]).not.toHaveProperty("editTimestamp");
  });

  it("clears trailing unfinalized preview even when an earlier final was delivered", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "first draft" });
      dispatcher.sendFinalReply({ text: "first final" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onPartialReply?.({ text: "what" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("skips draft streaming when blockStreaming is enabled", async () => {
    dispatchInboundMessageMock.mockImplementation(async ({ replyOptions }) => {
      expect(replyOptions?.onPartialReply).toBeUndefined();
      expect(replyOptions?.disableBlockStreaming).toBe(false);
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    const deliverReplies = vi.fn(async () => {});

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: true,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(createSignalDraftStreamMock).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("clears draft message when no final reply is delivered", async () => {
    const draftStream = createDraftStreamStub(1700000001111);
    createSignalDraftStreamMock.mockReturnValue(draftStream);
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: false,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(draftStream.stop).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("injects replyToAuthor for replies targeting the current inbound message", async () => {
    const deliverReplies = vi.fn(async () => {});
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({
        text: "quoted",
        replyToId: "1700000000000",
      });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: true,
        deliverReplies,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
        },
      }),
    );

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "quoted",
            replyToId: "1700000000000",
            replyToAuthor: "+15550001111",
          }),
        ],
      }),
    );
  });

  it("injects replyToAuthor for explicit reply ids using cached inbound author", async () => {
    const deliverReplies = vi.fn(async () => {});
    let dispatchCount = 0;
    dispatchInboundMessageMock.mockImplementation(async ({ dispatcher }) => {
      dispatchCount += 1;
      if (dispatchCount === 1) {
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }
      dispatcher.sendFinalReply({
        text: "quoted",
        replyToId: "1700000000000",
      });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        blockStreaming: true,
        deliverReplies,
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000000,
        dataMessage: {
          timestamp: 1700000000000,
          message: "first",
        },
      }),
    );
    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000001000,
        dataMessage: {
          timestamp: 1700000001000,
          message: "second",
        },
      }),
    );

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "quoted",
            replyToId: "1700000000000",
            replyToAuthor: "+15550001111",
          }),
        ],
      }),
    );
  });
});
