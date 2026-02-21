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

describe("signal event handler edit metadata", () => {
  it("marks inbound edited messages and exposes edit target timestamp", async () => {
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
        editMessage: {
          targetSentTimestamp: 1700000000100,
          dataMessage: {
            message: "new body",
          },
        },
      }),
    );

    await flush();
    const context = capturedContexts.at(-1);
    expect(context).toBeTruthy();
    expect(context?.IsEdited).toBe(true);
    expect(context?.EditTargetTimestamp).toBe(1700000000100);
    expect(String(context?.Body ?? "")).toContain("(edited)");
    expect(String(context?.BodyForAgent ?? "")).toContain("[signal_edit target:1700000000100]");
  });

  it("populates EditOriginalBody from cache when target message was seen earlier", async () => {
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
        timestamp: 1700000000100,
        dataMessage: {
          timestamp: 1700000000100,
          message: "original body",
        },
      }),
    );
    await flush();

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000200,
        editMessage: {
          targetSentTimestamp: 1700000000100,
          dataMessage: {
            message: "updated body",
          },
        },
      }),
    );
    await flush();

    const editedContext = capturedContexts.at(-1);
    expect(editedContext).toBeTruthy();
    expect(editedContext?.IsEdited).toBe(true);
    expect(editedContext?.EditTargetTimestamp).toBe(1700000000100);
    expect(editedContext?.EditOriginalBody).toBe("original body");
  });
});
