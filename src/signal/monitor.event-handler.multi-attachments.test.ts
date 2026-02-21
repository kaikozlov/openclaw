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
const recordChannelActivityMock = vi.fn();

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: dispatchInboundMessageMock,
  dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
  dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

vi.mock("../infra/channel-activity.js", () => ({
  recordChannelActivity: (...args: unknown[]) => recordChannelActivityMock(...args),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("signal event handler multi-attachment handling", () => {
  it("preserves all inbound attachments as media paths/types in order", async () => {
    capturedContexts.length = 0;
    dispatchInboundMessageMock.mockClear();
    recordChannelActivityMock.mockClear();
    const { createSignalEventHandler } = await import("./monitor/event-handler.js");
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        ignoreAttachments: false,
        fetchAttachment: vi.fn(async ({ attachment }) => ({
          path: `/tmp/${attachment.id}.bin`,
          contentType: attachment.contentType ?? undefined,
        })),
        cfg: {
          messages: { inbound: { debounceMs: 0 } },
          channels: { signal: { dmPolicy: "open", allowFrom: ["*"] } },
        },
      }),
    );

    await handler(
      createSignalReceiveEvent({
        timestamp: 1700000000123,
        dataMessage: {
          message: "",
          attachments: [
            { id: "a1", contentType: "image/png" },
            { id: "a2", contentType: "video/mp4" },
          ],
        },
      }),
    );

    await flush();
    const context = capturedContexts.at(-1);
    expect(context).toBeTruthy();
    expect(context?.MediaPath).toBe("/tmp/a1.bin");
    expect(context?.MediaPaths).toEqual(["/tmp/a1.bin", "/tmp/a2.bin"]);
    expect(context?.MediaTypes).toEqual(["image/png", "video/mp4"]);
    expect(String(context?.RawBody ?? "")).toContain("<media:image>");
    expect(String(context?.RawBody ?? "")).toContain("<media:video>");
    expect(recordChannelActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "signal",
        direction: "inbound",
      }),
    );
  });
});
