import { describe, expect, it, vi } from "vitest";
import { createSignalDraftStream } from "./draft-stream.js";

type DraftStreamParams = Parameters<typeof createSignalDraftStream>[0];
type DraftSendFn = NonNullable<DraftStreamParams["send"]>;
type DraftEditFn = NonNullable<DraftStreamParams["edit"]>;
type DraftRemoveFn = NonNullable<DraftStreamParams["remove"]>;
type DraftWarnFn = NonNullable<DraftStreamParams["warn"]>;

function createDraftStreamHarness(
  params: {
    maxChars?: number;
    maxPreviewEdits?: number;
    send?: DraftSendFn;
    edit?: DraftEditFn;
    remove?: DraftRemoveFn;
    warn?: DraftWarnFn;
  } = {},
) {
  const send =
    params.send ??
    vi.fn<DraftSendFn>(async () => ({
      messageId: "1700000000001",
      timestamp: 1700000000001,
    }));
  const edit =
    params.edit ??
    vi.fn<DraftEditFn>(async () => ({
      messageId: "1700000000001",
      timestamp: 1700000000001,
    }));
  const remove = params.remove ?? vi.fn<DraftRemoveFn>(async () => {});
  const warn = params.warn ?? vi.fn<DraftWarnFn>();
  const stream = createSignalDraftStream({
    target: "signal:+15550002222",
    throttleMs: 250,
    maxChars: params.maxChars,
    maxPreviewEdits: params.maxPreviewEdits,
    send,
    edit,
    remove,
    warn,
  });
  return { stream, send, edit, remove, warn };
}

describe("createSignalDraftStream", () => {
  it("sends the first update and edits subsequent updates", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    stream.update("hello world");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("signal:+15550002222", "hello world", 1700000000001, {
      baseUrl: undefined,
      account: undefined,
      accountId: undefined,
      maxBytes: undefined,
      textMode: "plain",
      textStyles: undefined,
    });
    expect(stream.messageTimestamp()).toBe(1700000000001);
  });

  it("does not send duplicate text", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("same");
    await stream.flush();
    stream.update("same");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
  });

  it("skips regressive shorter prefix edits", async () => {
    const { stream, send, edit } = createDraftStreamHarness();

    stream.update("hello world");
    await stream.flush();
    stream.update("hello");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    expect(stream.messageTimestamp()).toBe(1700000000001);
  });

  it("supports forceNewMessage for subsequent assistant messages", async () => {
    const send = vi
      .fn<DraftSendFn>()
      .mockResolvedValueOnce({ messageId: "1700000000001", timestamp: 1700000000001 })
      .mockResolvedValueOnce({ messageId: "1700000000002", timestamp: 1700000000002 });
    const { stream, edit } = createDraftStreamHarness({ send });

    stream.update("first");
    await stream.flush();
    stream.forceNewMessage();
    stream.update("second");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(edit).not.toHaveBeenCalled();
    expect(stream.messageTimestamp()).toBe(1700000000002);
  });

  it("stops when text exceeds max chars", async () => {
    const { stream, send, edit, warn } = createDraftStreamHarness({ maxChars: 5 });

    stream.update("123456");
    await stream.flush();
    stream.update("ok");
    await stream.flush();

    expect(send).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("clear deletes preview message when one exists", async () => {
    const { stream, remove } = createDraftStreamHarness();

    stream.update("hello");
    await stream.flush();
    await stream.clear();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("signal:+15550002222", 1700000000001, {
      baseUrl: undefined,
      account: undefined,
      accountId: undefined,
    });
    expect(stream.messageTimestamp()).toBeUndefined();
  });

  it("stops preview edits after max preview edit budget is reached", async () => {
    const { stream, send, edit, warn } = createDraftStreamHarness({ maxPreviewEdits: 1 });

    stream.update("first");
    await stream.flush();
    stream.update("second");
    await stream.flush();
    stream.update("third");
    await stream.flush();

    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "signal stream preview stopped (max preview edits reached: 1)",
    );
    expect(stream.messageTimestamp()).toBe(1700000000001);
  });
});
