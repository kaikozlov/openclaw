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

describe("signal event handler poll context", () => {
  it("propagates poll create payloads into RawBody", async () => {
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
        timestamp: 1700000001000,
        dataMessage: {
          pollCreate: {
            question: "Where should we deploy?",
            allowMultiple: false,
            options: ["us-east", "eu-west"],
          },
        },
      }),
    );

    await flush();
    const context = capturedContexts.at(-1);
    expect(context).toBeTruthy();
    expect(context?.RawBody).toContain("signal_poll_create");
    expect(context?.RawBody).toContain("Where should we deploy?");
    expect(context?.RawBody).toContain("us-east");
  });

  it("propagates poll vote payloads into RawBody", async () => {
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
        timestamp: 1700000002000,
        dataMessage: {
          pollVote: {
            authorNumber: "+1 (555) 000-3333",
            targetSentTimestamp: 1700000001111,
            optionIndexes: [0, 1],
            voteCount: 2,
          },
        },
      }),
    );

    await flush();
    const context = capturedContexts.at(-1);
    expect(context).toBeTruthy();
    expect(context?.RawBody).toContain("signal_poll_vote");
    expect(context?.RawBody).toContain("poll:1700000001111");
    expect(context?.RawBody).toContain("+15550003333");
    expect(context?.RawBody).toContain("voteCount: 2");
  });

  it("propagates poll terminate payloads into RawBody", async () => {
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
        timestamp: 1700000003000,
        dataMessage: {
          pollTerminate: {
            targetSentTimestamp: 1700000001111,
          },
        },
      }),
    );

    await flush();
    const context = capturedContexts.at(-1);
    expect(context).toBeTruthy();
    expect(context?.RawBody).toContain("signal_poll_terminate");
    expect(context?.RawBody).toContain("poll:1700000001111");
  });
});
