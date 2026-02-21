import { logVerbose, shouldLogVerbose } from "../globals.js";
import type { BackoffPolicy } from "../infra/backoff.js";
import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import type { RuntimeEnv } from "../runtime.js";
import { type SignalSseEvent, streamSignalEvents } from "./client.js";

const DEFAULT_RECONNECT_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
};
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

type RunSignalSseLoopParams = {
  baseUrl: string;
  account?: string;
  abortSignal?: AbortSignal;
  runtime: RuntimeEnv;
  onEvent: (event: SignalSseEvent) => void;
  policy?: Partial<BackoffPolicy>;
  idleTimeoutMs?: number;
};

export async function runSignalSseLoop({
  baseUrl,
  account,
  abortSignal,
  runtime,
  onEvent,
  policy,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
}: RunSignalSseLoopParams) {
  const reconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...policy,
  };
  let reconnectAttempts = 0;
  let consecutiveIdleTimeouts = 0;

  const logReconnectVerbose = (message: string) => {
    if (!shouldLogVerbose()) {
      return;
    }
    logVerbose(message);
  };
  const logIdleReconnect = () => {
    const timeoutMs = Math.trunc(idleTimeoutMs);
    if (consecutiveIdleTimeouts === 1 || consecutiveIdleTimeouts % 10 === 0) {
      runtime.log?.(
        `Signal SSE idle timeout (${timeoutMs}ms), reconnecting stream...` +
          (consecutiveIdleTimeouts > 1 ? ` [x${consecutiveIdleTimeouts}]` : ""),
      );
      return;
    }
    logReconnectVerbose(
      `Signal SSE idle timeout (${timeoutMs}ms), reconnecting stream [x${consecutiveIdleTimeouts}]`,
    );
  };

  while (!abortSignal?.aborted) {
    const streamAbortController = new AbortController();
    const abortStream = () => {
      streamAbortController.abort();
    };
    abortSignal?.addEventListener("abort", abortStream, { once: true });
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdleTimer = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const resetIdleTimer = () => {
      if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
        return;
      }
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        streamAbortController.abort();
      }, Math.trunc(idleTimeoutMs));
    };
    try {
      resetIdleTimer();
      await streamSignalEvents({
        baseUrl,
        account,
        abortSignal: streamAbortController.signal,
        onEvent: (event) => {
          reconnectAttempts = 0;
          consecutiveIdleTimeouts = 0;
          resetIdleTimer();
          onEvent(event);
        },
      });
      clearIdleTimer();
      abortSignal?.removeEventListener("abort", abortStream);
      if (abortSignal?.aborted) {
        return;
      }
      if (idleTimedOut) {
        consecutiveIdleTimeouts += 1;
        logIdleReconnect();
      } else {
        consecutiveIdleTimeouts = 0;
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      if (idleTimedOut) {
        logReconnectVerbose(`Signal SSE reconnect in ${delayMs / 1000}s after idle timeout...`);
      } else {
        logReconnectVerbose(`Signal SSE stream ended, reconnecting in ${delayMs / 1000}s...`);
      }
      await sleepWithAbort(delayMs, abortSignal);
    } catch (err) {
      clearIdleTimer();
      abortSignal?.removeEventListener("abort", abortStream);
      if (abortSignal?.aborted) {
        return;
      }
      if (idleTimedOut) {
        consecutiveIdleTimeouts += 1;
        logIdleReconnect();
      } else {
        consecutiveIdleTimeouts = 0;
        runtime.error?.(`Signal SSE stream error: ${String(err)}`);
      }
      reconnectAttempts += 1;
      const delayMs = computeBackoff(reconnectPolicy, reconnectAttempts);
      if (idleTimedOut) {
        logReconnectVerbose(
          `Signal SSE connection lost after idle timeout, reconnecting in ${delayMs / 1000}s...`,
        );
      } else {
        runtime.log?.(`Signal SSE connection lost, reconnecting in ${delayMs / 1000}s...`);
      }
      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch (sleepErr) {
        if (abortSignal?.aborted) {
          return;
        }
        throw sleepErr;
      }
    }
  }
}
