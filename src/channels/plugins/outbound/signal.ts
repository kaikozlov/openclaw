import { chunkText } from "../../../auto-reply/chunk.js";
import { sendPollSignal } from "../../../signal/send-polls.js";
import { sendMessageSignal } from "../../../signal/send.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";
import type { ChannelOutboundAdapter } from "../types.js";

function resolveSignalMaxBytes(params: {
  cfg: Parameters<typeof resolveChannelMediaMaxBytes>[0]["cfg"];
  accountId?: string | null;
}) {
  return resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
    accountId: params.accountId,
  });
}

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

export const signalOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId, replyToAuthor }) => {
    const send = deps?.sendSignal ?? sendMessageSignal;
    const maxBytes = resolveSignalMaxBytes({ cfg, accountId });
    const quoteTimestamp = parseSignalQuoteTimestamp(replyToId);
    const result = await send(to, text, {
      maxBytes,
      accountId: accountId ?? undefined,
      ...(quoteTimestamp && replyToAuthor
        ? {
            quoteTimestamp,
            quoteAuthor: replyToAuthor,
          }
        : {}),
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
    const send = deps?.sendSignal ?? sendMessageSignal;
    const maxBytes = resolveSignalMaxBytes({ cfg, accountId });
    const quoteTimestamp = parseSignalQuoteTimestamp(replyToId);
    const result = await send(to, text, {
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
      mediaLocalRoots,
      ...(quoteTimestamp && replyToAuthor
        ? {
            quoteTimestamp,
            quoteAuthor: replyToAuthor,
          }
        : {}),
    });
    return { channel: "signal", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollSignal(to, poll, {
      accountId: accountId ?? undefined,
    }),
};
