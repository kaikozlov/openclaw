import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./monitor/event-handler.test-harness.js";

const capturedContexts: MsgContext[] = [];
const dispatchInboundMessageMock = vi.fn(async ({ ctx }) => {
  capturedContexts.push(ctx as MsgContext);
  return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
});

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: dispatchInboundMessageMock,
  dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
  dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("signal event handler quote context", () => {
  it("propagates quote id/body/sender into inbound context", async () => {
    capturedContexts.length = 0;
    dispatchInboundMessageMock.mockClear();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
      }),
    );

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000200,
        dataMessage: {
          message: "reply message",
          quote: {
            id: 1700000000100,
            authorNumber: "+1 (555) 000-8888",
            text: "original message",
          },
        },
      }),
    );

    await flush();
    const context = capturedContexts.at(-1);
    expect(context).toBeTruthy();
    expect(context?.ReplyToId).toBe("1700000000100");
    expect(context?.ReplyToBody).toBe("original message");
    expect(context?.ReplyToSender).toBe("+15550008888");
    expect(context?.ReplyToIsQuote).toBe(true);
  });

  it("falls back to quote authorUuid when phone author is unavailable", async () => {
    capturedContexts.length = 0;
    dispatchInboundMessageMock.mockClear();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
      }),
    );

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000300,
        dataMessage: {
          message: "reply with uuid quote author",
          quote: {
            id: "1700000000200",
            authorUuid: "123e4567-e89b-12d3-a456-426614174000",
            text: "quoted body",
          },
        },
      }),
    );

    await flush();
    const context = capturedContexts.at(-1);
    expect(context).toBeTruthy();
    expect(context?.ReplyToId).toBe("1700000000200");
    expect(context?.ReplyToSender).toBe("uuid:123e4567-e89b-12d3-a456-426614174000");
    expect(context?.ReplyToBody).toBe("quoted body");
    expect(context?.ReplyToIsQuote).toBe(true);
  });
});
