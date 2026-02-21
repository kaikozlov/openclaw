import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import type { OutboundRetryConfig } from "../config/types.base.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { mediaKindFromMime } from "../media/constants.js";
import { resolveOutboundAttachmentFromUrl } from "../media/outbound-attachment.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest, signalRpcRequestWithRetry } from "./client.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalMentionRange = {
  start: number;
  length: number;
  recipient: string;
};

export type SignalStickerPack = {
  packId?: string;
  id?: string;
  title?: string;
  author?: string;
  installed?: boolean;
  [key: string]: unknown;
};

export type SignalSendOpts = {
  baseUrl?: string;
  account?: string;
  accountId?: string;
  retry?: OutboundRetryConfig;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
  mentions?: SignalMentionRange[];
  quoteTimestamp?: number;
  quoteAuthor?: string;
  quoteMessage?: string;
  previewUrl?: string;
  previewTitle?: string;
  previewDescription?: string;
  previewImage?: string;
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
};

export type SignalRpcOpts = Pick<
  SignalSendOpts,
  "baseUrl" | "account" | "accountId" | "timeoutMs" | "retry"
>;

export type SignalReceiptType = "read" | "viewed";

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

function parseTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) {
    throw new Error("Signal recipient is required");
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  const normalized = value.toLowerCase();
  if (normalized.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (normalized.startsWith("username:")) {
    return {
      type: "username",
      username: value.slice("username:".length).trim(),
    };
  }
  if (normalized.startsWith("u:")) {
    return { type: "username", username: value.trim() };
  }
  return { type: "recipient", recipient: value };
}

type SignalTargetParams = {
  recipient?: string[];
  groupId?: string;
  username?: string[];
};

type SignalTargetAllowlist = {
  recipient?: boolean;
  group?: boolean;
  username?: boolean;
};

function resolveSignalMaxBytes(params: {
  opts: SignalSendOpts;
  cfg: ReturnType<typeof loadConfig>;
  accountInfo: ReturnType<typeof resolveSignalAccount>;
}): number {
  const { opts, cfg, accountInfo } = params;
  if (typeof opts.maxBytes === "number") {
    return opts.maxBytes;
  }
  if (typeof accountInfo.config.mediaMaxMb === "number") {
    return accountInfo.config.mediaMaxMb * 1024 * 1024;
  }
  if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") {
    return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
  }
  return 8 * 1024 * 1024;
}

async function buildSignalSendRpcPayload(params: {
  to: string;
  text: string;
  opts: SignalSendOpts;
  extraParams?: Record<string, unknown>;
}): Promise<{
  baseUrl: string;
  timeoutMs?: number;
  retry?: OutboundRetryConfig;
  accountId: string;
  params: Record<string, unknown>;
}> {
  const cfg = loadConfig();
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: params.opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(params.opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(params.to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  const maxBytes = resolveSignalMaxBytes({ opts: params.opts, cfg, accountInfo });

  let message = params.text ?? "";
  let messageFromPlaceholder = false;
  let textStyles: SignalTextStyleRange[] = [];
  const textMode = params.opts.textMode ?? "markdown";

  let attachments: string[] | undefined;
  if (params.opts.mediaUrl?.trim()) {
    const resolved = await resolveOutboundAttachmentFromUrl(params.opts.mediaUrl.trim(), maxBytes, {
      localRoots: params.opts.mediaLocalRoots,
    });
    attachments = [resolved.path];
    const kind = mediaKindFromMime(resolved.contentType ?? undefined);
    if (!message && kind) {
      // Avoid sending an empty body when only attachments exist.
      message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
      messageFromPlaceholder = true;
    }
  }

  if (message.trim() && !messageFromPlaceholder) {
    if (textMode === "plain") {
      textStyles = params.opts.textStyles ?? [];
    } else {
      const tableMode = resolveMarkdownTableMode({
        cfg,
        channel: "signal",
        accountId: accountInfo.accountId,
      });
      const formatted = markdownToSignalText(message, { tableMode });
      message = formatted.text;
      textStyles = formatted.styles;
    }
  }

  if (!message.trim() && (!attachments || attachments.length === 0)) {
    throw new Error("Signal send requires text or media");
  }

  const rpcParams: Record<string, unknown> = { message, ...targetParams };
  if (textStyles.length > 0) {
    rpcParams["text-style"] = textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }
  if (account) {
    rpcParams.account = account;
  }
  if (attachments && attachments.length > 0) {
    rpcParams.attachments = attachments;
  }
  const mentionRanges = buildSignalMentionParams(params.opts.mentions);
  if (mentionRanges.length > 0) {
    rpcParams.mention = mentionRanges;
  }
  if (params.extraParams) {
    Object.assign(rpcParams, params.extraParams);
  }
  const quoteAuthor = normalizeSignalQuoteAuthor(params.opts.quoteAuthor);
  if (
    Number.isFinite(params.opts.quoteTimestamp) &&
    (params.opts.quoteTimestamp ?? 0) > 0 &&
    quoteAuthor
  ) {
    rpcParams.quoteTimestamp = Math.trunc(params.opts.quoteTimestamp ?? 0);
    rpcParams.quoteAuthor = quoteAuthor;
    if (params.opts.quoteMessage?.trim()) {
      rpcParams.quoteMessage = params.opts.quoteMessage.trim();
    }
  }
  if (params.opts.previewUrl?.trim()) {
    rpcParams.previewUrl = params.opts.previewUrl.trim();
    if (params.opts.previewTitle?.trim()) {
      rpcParams.previewTitle = params.opts.previewTitle.trim();
    }
    if (params.opts.previewDescription?.trim()) {
      rpcParams.previewDescription = params.opts.previewDescription.trim();
    }
    if (params.opts.previewImage?.trim()) {
      rpcParams.previewImage = params.opts.previewImage.trim();
    }
  }

  return {
    baseUrl,
    timeoutMs: params.opts.timeoutMs,
    retry: params.opts.retry ?? accountInfo.config.retry,
    accountId: accountInfo.accountId,
    params: rpcParams,
  };
}

function buildTargetParams(
  target: SignalTarget,
  allow: SignalTargetAllowlist,
): SignalTargetParams | null {
  if (target.type === "recipient") {
    if (!allow.recipient) {
      return null;
    }
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    if (!allow.group) {
      return null;
    }
    return { groupId: target.groupId };
  }
  if (target.type === "username") {
    if (!allow.username) {
      return null;
    }
    return { username: [target.username] };
  }
  return null;
}

function normalizeSignalQuoteAuthor(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return undefined;
  }
  if (withoutSignal.toLowerCase().startsWith("uuid:")) {
    const uuid = withoutSignal.slice("uuid:".length).trim();
    return uuid || undefined;
  }
  return withoutSignal;
}

function buildSignalMentionParams(mentions?: SignalMentionRange[]): string[] {
  if (!mentions?.length) {
    return [];
  }
  return mentions.map((mention, index) => {
    if (!Number.isFinite(mention.start) || mention.start < 0) {
      throw new Error(`Signal mention ${index} has an invalid start`);
    }
    if (!Number.isFinite(mention.length) || mention.length <= 0) {
      throw new Error(`Signal mention ${index} has an invalid length`);
    }
    const recipient = normalizeSignalMentionRecipient(mention.recipient, index);
    return `${Math.trunc(mention.start)}:${Math.trunc(mention.length)}:${recipient}`;
  });
}

function normalizeSignalMentionRecipient(raw: string, index: number): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Signal mention ${index} recipient is required`);
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    throw new Error(`Signal mention ${index} recipient is required`);
  }
  if (withoutSignal.toLowerCase().startsWith("uuid:")) {
    const uuid = withoutSignal.slice("uuid:".length).trim();
    if (!uuid) {
      throw new Error(`Signal mention ${index} recipient is required`);
    }
    return uuid;
  }
  return withoutSignal;
}

function validateSignalStickerInput(
  packId: string,
  stickerId: number,
): {
  packId: string;
  stickerId: number;
} {
  const normalizedPackId = packId.trim();
  if (!normalizedPackId) {
    throw new Error("Signal sticker send requires packId");
  }
  if (!Number.isFinite(stickerId) || stickerId < 0) {
    throw new Error("Signal sticker send requires a non-negative stickerId");
  }
  return {
    packId: normalizedPackId,
    stickerId: Math.trunc(stickerId),
  };
}

function normalizeStickerPackList(result: unknown): SignalStickerPack[] {
  if (Array.isArray(result)) {
    return result as SignalStickerPack[];
  }
  if (!result || typeof result !== "object") {
    return [];
  }
  const packs = (result as { stickerPacks?: unknown }).stickerPacks;
  if (Array.isArray(packs)) {
    return packs as SignalStickerPack[];
  }
  return [];
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts = {},
): Promise<SignalSendResult> {
  const request = await buildSignalSendRpcPayload({
    to,
    text,
    opts,
  });
  const result = await signalRpcRequestWithRetry<{ timestamp?: number }>("send", request.params, {
    baseUrl: request.baseUrl,
    timeoutMs: request.timeoutMs,
    retry: request.retry,
  });
  const timestamp = result?.timestamp;
  recordChannelActivity({
    channel: "signal",
    accountId: request.accountId,
    direction: "outbound",
    at: timestamp,
  });
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export async function editMessageSignal(
  to: string,
  text: string,
  editTimestamp: number,
  opts: SignalSendOpts = {},
): Promise<SignalSendResult> {
  if (!Number.isFinite(editTimestamp) || editTimestamp <= 0) {
    throw new Error("Signal edit requires a valid editTimestamp");
  }
  const request = await buildSignalSendRpcPayload({
    to,
    text,
    opts,
    extraParams: { editTimestamp },
  });
  const result = await signalRpcRequestWithRetry<{ timestamp?: number }>("send", request.params, {
    baseUrl: request.baseUrl,
    timeoutMs: request.timeoutMs,
    retry: request.retry,
  });
  const timestamp = result?.timestamp;
  recordChannelActivity({
    channel: "signal",
    accountId: request.accountId,
    direction: "outbound",
    at: timestamp,
  });
  return {
    messageId: timestamp ? String(timestamp) : String(editTimestamp),
    timestamp,
  };
}

export async function deleteMessageSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts = {},
): Promise<void> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    throw new Error("Signal delete requires a valid targetTimestamp");
  }
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  const params: Record<string, unknown> = {
    targetTimestamp,
    ...targetParams,
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequestWithRetry("remoteDelete", params, {
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

export async function sendStickerSignal(
  to: string,
  packId: string,
  stickerId: number,
  opts: SignalRpcOpts = {},
): Promise<SignalSendResult> {
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  const sticker = validateSignalStickerInput(packId, stickerId);
  const params: Record<string, unknown> = {
    ...targetParams,
    sticker: `${sticker.packId}:${sticker.stickerId}`,
  };
  if (account) {
    params.account = account;
  }
  const result = await signalRpcRequestWithRetry<{ timestamp?: number }>("send", params, {
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

export async function listStickerPacksSignal(
  opts: SignalRpcOpts = {},
): Promise<SignalStickerPack[]> {
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const result = await signalRpcRequestWithRetry(
    "listStickerPacks",
    account ? { account } : undefined,
    {
      baseUrl,
      timeoutMs: opts.timeoutMs,
      retry: opts.retry ?? accountInfo.config.retry,
    },
  );
  return normalizeStickerPackList(result);
}

export async function sendTypingSignal(
  to: string,
  opts: SignalRpcOpts & { stop?: boolean } = {},
): Promise<boolean> {
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = { ...targetParams };
  if (account) {
    params.account = account;
  }
  if (opts.stop) {
    params.stop = true;
  }
  await signalRpcRequest("sendTyping", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}

export async function sendReadReceiptSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts & { type?: SignalReceiptType } = {},
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
    type: opts.type ?? "read",
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("sendReceipt", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}
