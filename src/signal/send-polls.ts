import { loadConfig } from "../config/config.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { normalizePollInput, type PollInput } from "../polls.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequestWithRetry } from "./client.js";
import { resolveSignalRpcContext } from "./rpc-context.js";
import type { SignalRpcOpts, SignalSendResult } from "./send.js";

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

type SignalTargetParams = {
  recipient?: string[];
  groupId?: string;
  username?: string[];
};

function parseSignalTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) {
    throw new Error("Signal recipient is required");
  }
  if (value.toLowerCase().startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  const normalized = value.toLowerCase();
  if (normalized.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (normalized.startsWith("username:")) {
    return { type: "username", username: value.slice("username:".length).trim() };
  }
  if (normalized.startsWith("u:")) {
    return { type: "username", username: value };
  }
  return { type: "recipient", recipient: value };
}

function buildSignalTargetParams(target: SignalTarget): SignalTargetParams {
  if (target.type === "recipient") {
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    return { groupId: target.groupId };
  }
  return { username: [target.username] };
}

function normalizePollAuthor(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Signal poll vote requires pollAuthor");
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    throw new Error("Signal poll vote requires pollAuthor");
  }
  if (withoutSignal.toLowerCase().startsWith("uuid:")) {
    const uuid = withoutSignal.slice("uuid:".length).trim();
    if (!uuid) {
      throw new Error("Signal poll vote requires pollAuthor");
    }
    return uuid;
  }
  return withoutSignal;
}

function parsePositiveTimestamp(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Signal ${label} requires a valid positive timestamp`);
  }
  return Math.trunc(value);
}

function normalizeOptionIndices(optionIndices: readonly number[]): number[] {
  const normalized: number[] = [];
  for (const optionIndex of optionIndices) {
    if (!Number.isFinite(optionIndex)) {
      throw new Error("Signal poll vote option indices must be numbers");
    }
    const value = Math.trunc(optionIndex);
    if (value < 0) {
      throw new Error("Signal poll vote option indices must be non-negative");
    }
    normalized.push(value);
  }
  return normalized;
}

export async function sendPollSignal(
  to: string,
  poll: PollInput,
  opts: SignalRpcOpts = {},
): Promise<SignalSendResult> {
  const normalized = normalizePollInput(poll, { maxOptions: 12 });
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildSignalTargetParams(parseSignalTarget(to));

  const params: Record<string, unknown> = {
    ...targetParams,
    question: normalized.question,
    option: normalized.options,
    noMulti: normalized.maxSelections === 1,
  };
  if (account) {
    params.account = account;
  }

  const result = await signalRpcRequestWithRetry<{ timestamp?: number }>("sendPollCreate", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: opts.retry ?? accountInfo.config.retry,
  });
  const timestamp = result?.timestamp;
  recordChannelActivity({
    channel: "signal",
    accountId: accountInfo.accountId,
    direction: "outbound",
    at: timestamp,
  });
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export async function votePollSignal(
  to: string,
  pollTimestamp: number,
  pollAuthor: string,
  optionIndices: readonly number[],
  opts: SignalRpcOpts & { voteCount?: number } = {},
): Promise<void> {
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildSignalTargetParams(parseSignalTarget(to));
  const voteCountRaw = opts.voteCount ?? 1;
  if (!Number.isFinite(voteCountRaw) || voteCountRaw < 1) {
    throw new Error("Signal poll vote requires voteCount >= 1");
  }

  const params: Record<string, unknown> = {
    ...targetParams,
    pollTimestamp: parsePositiveTimestamp(pollTimestamp, "poll vote"),
    pollAuthor: normalizePollAuthor(pollAuthor),
    option: normalizeOptionIndices(optionIndices),
    voteCount: Math.trunc(voteCountRaw),
  };
  if (account) {
    params.account = account;
  }

  await signalRpcRequestWithRetry("sendPollVote", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: opts.retry ?? accountInfo.config.retry,
  });
  recordChannelActivity({
    channel: "signal",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });
}

export async function terminatePollSignal(
  to: string,
  pollTimestamp: number,
  opts: SignalRpcOpts = {},
): Promise<void> {
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildSignalTargetParams(parseSignalTarget(to));
  const params: Record<string, unknown> = {
    ...targetParams,
    pollTimestamp: parsePositiveTimestamp(pollTimestamp, "poll termination"),
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequestWithRetry("sendPollTerminate", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    retry: opts.retry ?? accountInfo.config.retry,
  });
  recordChannelActivity({
    channel: "signal",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });
}
