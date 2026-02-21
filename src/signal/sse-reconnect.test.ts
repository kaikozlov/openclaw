import { describe, expect, it, vi } from "vitest";

const streamSignalEventsMock = vi.fn();
const computeBackoffMock = vi.fn(() => 1);
const sleepWithAbortMock = vi.fn(async () => {});

vi.mock("./client.js", () => ({
  streamSignalEvents: streamSignalEventsMock,
}));

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: computeBackoffMock,
  sleepWithAbort: sleepWithAbortMock,
}));

describe("runSignalSseLoop idle watchdog", () => {
  it("reconnects after prolonged idle periods", async () => {
    const { runSignalSseLoop } = await import("./sse-reconnect.js");
    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as const;
    let callCount = 0;
    streamSignalEventsMock.mockImplementation(async ({ abortSignal }) => {
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((_resolve, reject) => {
          abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return;
      }
      abortController.abort();
    });

    await runSignalSseLoop({
      baseUrl: "http://signal.local",
      abortSignal: abortController.signal,
      runtime: runtime as never,
      idleTimeoutMs: 10,
      onEvent: vi.fn(),
    });

    expect(streamSignalEventsMock).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("idle timeout"));
    const connectionLostLogs = runtime.log.mock.calls.filter((call) =>
      String(call[0]).toLowerCase().includes("connection lost"),
    );
    expect(connectionLostLogs).toHaveLength(0);
  });

  it("resets idle timer when events are received", async () => {
    const { runSignalSseLoop } = await import("./sse-reconnect.js");
    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as const;
    streamSignalEventsMock.mockImplementationOnce(async ({ onEvent }) => {
      onEvent({ event: "receive", data: "{}" });
      abortController.abort();
    });

    await runSignalSseLoop({
      baseUrl: "http://signal.local",
      abortSignal: abortController.signal,
      runtime: runtime as never,
      idleTimeoutMs: 1000,
      onEvent: vi.fn(),
    });

    const idleLogs = runtime.log.mock.calls.filter((call) =>
      String(call[0]).toLowerCase().includes("idle timeout"),
    );
    expect(idleLogs).toHaveLength(0);
  });
});
