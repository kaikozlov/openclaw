import { chunkText } from "../../../auto-reply/chunk.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import { sendPollSignal } from "../../../signal/send-polls.js";
import { sendMessageSignal } from "../../../signal/send.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { createScopedChannelMediaMaxBytesResolver } from "./direct-text-media.js";

const resolveSignalMaxBytes = createScopedChannelMediaMaxBytesResolver("signal");

function parseSignalQuoteTimestamp(raw?: string | null): number | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.trunc(parsed);
}

function resolveSignalSendContext(params: {
  cfg: Parameters<typeof resolveSignalMaxBytes>[0]["cfg"];
  accountId?: string | null;
  deps?: OutboundSendDeps;
  replyToId?: string | null;
  replyToAuthor?: string | null;
}): {
  send: typeof sendMessageSignal;
  baseOpts: {
    maxBytes?: number;
    accountId?: string;
    quoteTimestamp?: number;
    quoteAuthor?: string;
  };
} {
  const send = params.deps?.sendSignal ?? sendMessageSignal;
  const maxBytes = resolveSignalMaxBytes({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const quoteTimestamp = parseSignalQuoteTimestamp(params.replyToId);
  return {
    send,
    baseOpts: {
      maxBytes,
      accountId: params.accountId ?? undefined,
      ...(quoteTimestamp && params.replyToAuthor
        ? {
            quoteTimestamp,
            quoteAuthor: params.replyToAuthor,
          }
        : {}),
    },
  };
}

export const signalOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, replyToAuthor }) => {
    const { send, baseOpts } = resolveSignalSendContext({
      cfg,
      accountId,
      deps,
      replyToId,
      replyToAuthor,
    });
    const result = await send(to, text, {
      ...baseOpts,
    });
    return { channel: "signal", ...result };
  },
  sendMedia: async ({
    cfg,
    to,
    text,
    mediaUrl,
    mediaLocalRoots,
    accountId,
    deps,
    replyToId,
    replyToAuthor,
  }) => {
    const { send, baseOpts } = resolveSignalSendContext({
      cfg,
      accountId,
      deps,
      replyToId,
      replyToAuthor,
    });
    const result = await send(to, text, {
      mediaUrl,
      mediaLocalRoots,
      ...baseOpts,
    });
    return { channel: "signal", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollSignal(to, poll, {
      accountId: accountId ?? undefined,
    }),
};
