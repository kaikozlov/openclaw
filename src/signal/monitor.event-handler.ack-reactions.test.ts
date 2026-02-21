import { describe, expect, it, vi } from "vitest";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./monitor/event-handler.test-harness.js";

const dispatchInboundMessageMock = vi.fn();
const sendReactionSignalMock = vi.fn(async () => ({ ok: true }));
const removeReactionSignalMock = vi.fn(async () => ({ ok: true }));

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: dispatchInboundMessageMock,
  dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
  dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
}));

vi.mock("../signal/send-reactions.js", () => ({
  sendReactionSignal: sendReactionSignalMock,
  removeReactionSignal: removeReactionSignalMock,
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("signal event handler ack reactions", () => {
  it("sends and removes ack reaction for direct messages when enabled", async () => {
    dispatchInboundMessageMock.mockReset();
    sendReactionSignalMock.mockClear();
    removeReactionSignalMock.mockClear();
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            inbound: { debounceMs: 0 },
            ackReaction: "👀",
            ackReactionScope: "direct",
            removeAckAfterReply: true,
          },
          channels: {
            signal: {
              dmPolicy: "open",
              allowFrom: ["*"],
              reactionLevel: "ack",
            },
          },
        },
      }),
    );

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000000,
        dataMessage: { message: "hi" },
      }),
    );
    await flush();

    expect(sendReactionSignalMock).toHaveBeenCalledWith("+15550001111", 1700000000000, "👀", {
      accountId: "default",
      targetAuthor: "+15550001111",
    });
    expect(removeReactionSignalMock).toHaveBeenCalledWith("+15550001111", 1700000000000, "👀", {
      accountId: "default",
      targetAuthor: "+15550001111",
    });
  });

  it("does not send ack reaction when reactionLevel does not enable ack", async () => {
    dispatchInboundMessageMock.mockReset();
    sendReactionSignalMock.mockClear();
    removeReactionSignalMock.mockClear();
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            inbound: { debounceMs: 0 },
            ackReaction: "👀",
            ackReactionScope: "direct",
            removeAckAfterReply: true,
          },
          channels: {
            signal: {
              dmPolicy: "open",
              allowFrom: ["*"],
              reactionLevel: "minimal",
            },
          },
        },
      }),
    );

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000000,
        dataMessage: { message: "hi" },
      }),
    );
    await flush();

    expect(sendReactionSignalMock).not.toHaveBeenCalled();
    expect(removeReactionSignalMock).not.toHaveBeenCalled();
  });

  it("keeps ack reaction when no final reply is queued", async () => {
    dispatchInboundMessageMock.mockReset();
    sendReactionSignalMock.mockClear();
    removeReactionSignalMock.mockClear();
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            inbound: { debounceMs: 0 },
            ackReaction: "👀",
            ackReactionScope: "direct",
            removeAckAfterReply: true,
          },
          channels: {
            signal: {
              dmPolicy: "open",
              allowFrom: ["*"],
              reactionLevel: "ack",
            },
          },
        },
      }),
    );

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000000,
        dataMessage: { message: "hi" },
      }),
    );
    await flush();

    expect(sendReactionSignalMock).toHaveBeenCalledTimes(1);
    expect(removeReactionSignalMock).not.toHaveBeenCalled();
  });

  it("sends group ack reactions when scope is group-all", async () => {
    dispatchInboundMessageMock.mockReset();
    sendReactionSignalMock.mockClear();
    removeReactionSignalMock.mockClear();
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            inbound: { debounceMs: 0 },
            ackReaction: "👀",
            ackReactionScope: "group-all",
            removeAckAfterReply: false,
          },
          channels: {
            signal: {
              dmPolicy: "open",
              allowFrom: ["*"],
              groupPolicy: "open",
              reactionLevel: "ack",
            },
          },
        },
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550003333",
        timestamp: 1700000001000,
        dataMessage: {
          message: "hi group",
          groupInfo: { groupId: "group-1", groupName: "Group One" },
        },
      }),
    );
    await flush();

    expect(sendReactionSignalMock).toHaveBeenCalledWith("", 1700000001000, "👀", {
      accountId: "default",
      groupId: "group-1",
      targetAuthor: "+15550003333",
    });
  });

  it("does not send ack reactions when scope is off", async () => {
    dispatchInboundMessageMock.mockReset();
    sendReactionSignalMock.mockClear();
    removeReactionSignalMock.mockClear();
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: {
            inbound: { debounceMs: 0 },
            ackReaction: "👀",
            // Undefined uses default "group-mentions", which should not ACK in direct chats.
            removeAckAfterReply: true,
          },
          channels: {
            signal: {
              dmPolicy: "open",
              allowFrom: ["*"],
              reactionLevel: "ack",
            },
          },
        },
      }),
    );

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000000,
        dataMessage: { message: "hi" },
      }),
    );
    await flush();

    expect(sendReactionSignalMock).not.toHaveBeenCalled();
    expect(removeReactionSignalMock).not.toHaveBeenCalled();
  });
});
