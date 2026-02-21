import { resolveAckReaction, resolveHumanDelayConfig } from "../../agents/identity.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { buildMentionRegexes, matchesMentionPatterns } from "../../auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  removeAckReactionAfterReply,
  shouldAckReaction as shouldAckReactionGate,
} from "../../channels/ack-reactions.js";
import { resolveControlCommandGate } from "../../channels/command-gating.js";
import { logAckFailure, logInboundDrop, logTypingFailure } from "../../channels/logging.js";
import { resolveMentionGatingWithBypass } from "../../channels/mention-gating.js";
import { normalizeSignalMessagingTarget } from "../../channels/plugins/normalize/signal.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { resolveChannelGroupRequireMention } from "../../config/group-policy.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { normalizeE164 } from "../../utils.js";
import { createSignalDraftStream, type SignalDraftStream } from "../draft-stream.js";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  isSignalSenderAllowed,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
} from "../identity.js";
import { resolveSignalReactionLevel } from "../reaction-level.js";
import { removeReactionSignal, sendReactionSignal } from "../send-reactions.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import type { SignalEventHandlerDeps, SignalReceivePayload } from "./event-handler.types.js";
import { renderSignalMentions } from "./mentions.js";
export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  const inboundDebounceMs = resolveInboundDebounceMs({ cfg: deps.cfg, channel: "signal" });
  const EDIT_MESSAGE_CACHE_MAX = 500;
  const editMessageBodyCache = new Map<string, string>();
  const messageAuthorCache = new Map<string, string>();

  const buildEditCacheKey = (conversationId: string, timestamp: number) =>
    `signal:${deps.accountId}:${conversationId}:${timestamp}`;

  const readCachedMessageBody = (conversationId: string, timestamp: number) => {
    const key = buildEditCacheKey(conversationId, timestamp);
    const cached = editMessageBodyCache.get(key);
    if (cached == null) {
      return undefined;
    }
    // LRU touch
    editMessageBodyCache.delete(key);
    editMessageBodyCache.set(key, cached);
    return cached;
  };

  const writeCachedMessageBody = (conversationId: string, timestamp: number, body: string) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0 || !body.trim()) {
      return;
    }
    const key = buildEditCacheKey(conversationId, timestamp);
    if (editMessageBodyCache.has(key)) {
      editMessageBodyCache.delete(key);
    }
    editMessageBodyCache.set(key, body);
    while (editMessageBodyCache.size > EDIT_MESSAGE_CACHE_MAX) {
      const oldest = editMessageBodyCache.keys().next().value;
      if (!oldest) {
        break;
      }
      editMessageBodyCache.delete(oldest);
    }
  };

  const readCachedMessageAuthor = (conversationId: string, timestamp: number) => {
    const key = buildEditCacheKey(conversationId, timestamp);
    const cached = messageAuthorCache.get(key);
    if (cached == null) {
      return undefined;
    }
    // LRU touch
    messageAuthorCache.delete(key);
    messageAuthorCache.set(key, cached);
    return cached;
  };

  const writeCachedMessageAuthor = (conversationId: string, timestamp: number, author: string) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return;
    }
    const normalized = author.trim();
    if (!normalized) {
      return;
    }
    const key = buildEditCacheKey(conversationId, timestamp);
    if (messageAuthorCache.has(key)) {
      messageAuthorCache.delete(key);
    }
    messageAuthorCache.set(key, normalized);
    while (messageAuthorCache.size > EDIT_MESSAGE_CACHE_MAX) {
      const oldest = messageAuthorCache.keys().next().value;
      if (!oldest) {
        break;
      }
      messageAuthorCache.delete(oldest);
    }
  };

  const parsePositiveTimestamp = (raw: unknown): number | undefined => {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return Math.trunc(raw);
    }
    if (typeof raw === "string") {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.trunc(parsed);
      }
    }
    return undefined;
  };

  const normalizeQuoteSender = (raw?: string | null): string | undefined => {
    const trimmed = raw?.trim();
    if (!trimmed) {
      return undefined;
    }
    const withoutSignalPrefix = trimmed.replace(/^signal:/i, "").trim();
    if (!withoutSignalPrefix) {
      return undefined;
    }
    if (withoutSignalPrefix.toLowerCase().startsWith("uuid:")) {
      return withoutSignalPrefix;
    }
    const normalizedPhone = normalizeE164(withoutSignalPrefix);
    return normalizedPhone ?? withoutSignalPrefix;
  };

  const resolveQuoteSender = (quote: {
    author?: string | null;
    authorNumber?: string | null;
    authorUuid?: string | null;
  }) => {
    const authorNumber = normalizeQuoteSender(quote.authorNumber);
    if (authorNumber) {
      return authorNumber;
    }
    const authorUuid = quote.authorUuid?.trim();
    if (authorUuid) {
      return authorUuid.toLowerCase().startsWith("uuid:") ? authorUuid : `uuid:${authorUuid}`;
    }
    return normalizeQuoteSender(quote.author);
  };

  const resolveSignalQuoteContext = (
    quote:
      | {
          id?: number | string | null;
          author?: string | null;
          authorNumber?: string | null;
          authorUuid?: string | null;
          text?: string | null;
        }
      | null
      | undefined,
  ): {
    replyToId?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote: true;
  } | null => {
    if (!quote) {
      return null;
    }
    const quoteTimestamp = parsePositiveTimestamp(quote.id);
    const replyToId = typeof quoteTimestamp === "number" ? String(quoteTimestamp) : undefined;
    const replyToBody = quote.text?.trim() || undefined;
    const replyToSender = resolveQuoteSender(quote);
    if (!replyToId && !replyToBody && !replyToSender) {
      return null;
    }
    return {
      replyToId,
      replyToBody,
      replyToSender,
      replyToIsQuote: true,
    };
  };

  const buildSignalPollCreateBody = (
    pollCreate?: {
      question?: string | null;
      allowMultiple?: boolean | null;
      options?: Array<string | null> | null;
    } | null,
  ): string | undefined => {
    if (!pollCreate) {
      return undefined;
    }
    const question = pollCreate.question?.trim();
    const options = (pollCreate.options ?? [])
      .map((option) => option?.trim() ?? "")
      .filter(Boolean);
    const mode = pollCreate.allowMultiple === false ? "single" : "multi";
    const summary = [
      `[signal_poll_create mode:${mode}]`,
      question ? `question: ${question}` : null,
      options.length > 0 ? `options: ${options.join(" | ")}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return summary.trim() || undefined;
  };

  const buildSignalPollVoteBody = (
    pollVote?: {
      author?: string | null;
      authorNumber?: string | null;
      authorUuid?: string | null;
      targetSentTimestamp?: number | null;
      optionIndexes?: Array<number | null> | null;
      voteCount?: number | null;
    } | null,
  ): string | undefined => {
    if (!pollVote) {
      return undefined;
    }
    const pollTimestamp = parsePositiveTimestamp(pollVote.targetSentTimestamp);
    const voter = resolveQuoteSender(pollVote);
    const optionIndexes = (pollVote.optionIndexes ?? [])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      .map((value) => Math.trunc(value))
      .join(",");
    const voteCount =
      typeof pollVote.voteCount === "number" && Number.isFinite(pollVote.voteCount)
        ? Math.trunc(pollVote.voteCount)
        : undefined;
    const summary = [
      `[signal_poll_vote${typeof pollTimestamp === "number" ? ` poll:${pollTimestamp}` : ""}]`,
      voter ? `voter: ${voter}` : null,
      optionIndexes ? `options: ${optionIndexes}` : null,
      typeof voteCount === "number" ? `voteCount: ${voteCount}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return summary.trim() || undefined;
  };

  const buildSignalPollTerminateBody = (
    pollTerminate?: {
      targetSentTimestamp?: number | null;
    } | null,
  ): string | undefined => {
    if (!pollTerminate) {
      return undefined;
    }
    const pollTimestamp = parsePositiveTimestamp(pollTerminate.targetSentTimestamp);
    if (typeof pollTimestamp !== "number") {
      return "[signal_poll_terminate]";
    }
    return `[signal_poll_terminate poll:${pollTimestamp}]`;
  };

  const buildSignalStickerBody = (
    sticker?: {
      stickerId?: number | null;
      packId?: string | null;
      emoji?: string | null;
    } | null,
  ): string | undefined => {
    if (!sticker) {
      return undefined;
    }
    const emoji = sticker.emoji?.trim();
    const stickerId =
      typeof sticker.stickerId === "number" && Number.isFinite(sticker.stickerId)
        ? Math.trunc(sticker.stickerId)
        : undefined;
    const packId = sticker.packId?.trim();
    const details = [
      emoji ? `emoji:${emoji}` : null,
      typeof stickerId === "number" ? `id:${stickerId}` : null,
      packId ? `pack:${packId}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return details ? `<media:sticker> ${details}` : "<media:sticker>";
  };

  type SignalInboundEntry = {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    timestamp?: number;
    messageId?: string;
    mediaPath?: string;
    mediaType?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
    commandAuthorized: boolean;
    wasMentioned?: boolean;
    isEdited?: boolean;
    editTargetTimestamp?: number;
    editOriginalBody?: string;
    replyToId?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
    requireMention?: boolean;
    canDetectMention?: boolean;
    shouldBypassMention?: boolean;
  };

  async function handleSignalInboundMessage(entry: SignalInboundEntry) {
    const conversationCacheId = entry.isGroup
      ? `group:${entry.groupId ?? "unknown"}`
      : `direct:${entry.senderPeerId}`;
    const fromLabel = formatInboundFromLabel({
      isGroup: entry.isGroup,
      groupLabel: entry.groupName ?? undefined,
      groupId: entry.groupId ?? "unknown",
      groupFallback: "Group",
      directLabel: entry.senderName,
      directId: entry.senderDisplay,
    });
    const route = resolveAgentRoute({
      cfg: deps.cfg,
      channel: "signal",
      accountId: deps.accountId,
      peer: {
        kind: entry.isGroup ? "group" : "direct",
        id: entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId,
      },
    });
    const storePath = resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = resolveEnvelopeFormatOptions(deps.cfg);
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const agentBodyText =
      entry.isEdited === true
        ? `${entry.bodyText}\n[signal_edit${typeof entry.editTargetTimestamp === "number" ? ` target:${entry.editTargetTimestamp}` : ""}]`
        : entry.bodyText;
    const envelopeBodyText =
      entry.isEdited === true ? `${entry.bodyText}\n(edited)` : entry.bodyText;
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: fromLabel,
      timestamp: entry.timestamp ?? undefined,
      body: envelopeBodyText,
      chatType: entry.isGroup ? "group" : "direct",
      sender: { name: entry.senderName, id: entry.senderDisplay },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? String(entry.groupId ?? "unknown") : undefined;
    if (entry.isGroup && historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        currentMessage: combinedBody,
        formatEntry: (historyEntry) =>
          formatInboundEnvelope({
            channel: "Signal",
            from: fromLabel,
            timestamp: historyEntry.timestamp,
            body: `${historyEntry.body}${
              historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""
            }`,
            chatType: "group",
            senderLabel: historyEntry.sender,
            envelope: envelopeOptions,
          }),
      });
    }
    const signalToRaw = entry.isGroup
      ? `group:${entry.groupId}`
      : `signal:${entry.senderRecipient}`;
    const signalTo = normalizeSignalMessagingTarget(signalToRaw) ?? signalToRaw;
    const inboundHistory =
      entry.isGroup && historyKey && deps.historyLimit > 0
        ? (deps.groupHistories.get(historyKey) ?? []).map((historyEntry) => ({
            sender: historyEntry.sender,
            body: historyEntry.body,
            timestamp: historyEntry.timestamp,
          }))
        : undefined;
    const ctxPayload = finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: agentBodyText,
      InboundHistory: inboundHistory,
      RawBody: entry.bodyText,
      CommandBody: entry.bodyText,
      From: entry.isGroup
        ? `group:${entry.groupId ?? "unknown"}`
        : `signal:${entry.senderRecipient}`,
      To: signalTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: entry.isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      GroupSubject: entry.isGroup ? (entry.groupName ?? undefined) : undefined,
      SenderName: entry.senderName,
      SenderId: entry.senderDisplay,
      Provider: "signal" as const,
      Surface: "signal" as const,
      MessageSid: entry.messageId,
      Timestamp: entry.timestamp ?? undefined,
      IsEdited: entry.isEdited === true ? true : undefined,
      EditTargetTimestamp: entry.editTargetTimestamp,
      EditOriginalBody: entry.editOriginalBody,
      ReplyToId: entry.replyToId,
      ReplyToBody: entry.replyToBody,
      ReplyToSender: entry.replyToSender,
      ReplyToIsQuote: entry.replyToIsQuote === true ? true : undefined,
      MediaPath: entry.mediaPath,
      MediaType: entry.mediaType,
      MediaUrl: entry.mediaPath,
      MediaPaths: entry.mediaPaths,
      MediaTypes: entry.mediaTypes,
      MediaUrls: entry.mediaPaths,
      WasMentioned: entry.isGroup ? entry.wasMentioned === true : undefined,
      CommandAuthorized: entry.commandAuthorized,
      OriginatingChannel: "signal" as const,
      OriginatingTo: signalTo,
    });

    const signalReactionLevel = resolveSignalReactionLevel({
      cfg: deps.cfg,
      accountId: route.accountId,
    });
    const ackReaction = signalReactionLevel.ackEnabled
      ? resolveAckReaction(deps.cfg, route.agentId, {
          channel: "signal",
          accountId: route.accountId,
        })
      : null;
    const removeAckAfterReply = deps.cfg.messages?.removeAckAfterReply ?? false;
    const ackTargetTimestamp =
      typeof entry.timestamp === "number" && entry.timestamp > 0 ? entry.timestamp : null;
    const shouldSendAckReaction =
      Boolean(
        ackReaction &&
        ackTargetTimestamp &&
        shouldAckReactionGate({
          scope: deps.cfg.messages?.ackReactionScope,
          isDirect: !entry.isGroup,
          isGroup: entry.isGroup,
          isMentionableGroup: entry.isGroup,
          requireMention: entry.requireMention === true,
          canDetectMention: entry.canDetectMention === true,
          effectiveWasMentioned: entry.wasMentioned === true,
          shouldBypassMention: entry.shouldBypassMention === true,
        }),
      ) && Boolean(entry.senderRecipient);
    const ackReactionPromise =
      shouldSendAckReaction && ackReaction && ackTargetTimestamp
        ? sendReactionSignal(
            entry.isGroup ? "" : entry.senderRecipient,
            ackTargetTimestamp,
            ackReaction,
            {
              accountId: route.accountId,
              ...(entry.isGroup
                ? { groupId: entry.groupId, targetAuthor: entry.senderRecipient }
                : { targetAuthor: entry.senderRecipient }),
            },
          ).then(
            () => true,
            (err) => {
              logVerbose(
                `signal ack reaction failed for ${entry.isGroup ? `group:${entry.groupId}` : entry.senderRecipient}/${ackTargetTimestamp}: ${String(err)}`,
              );
              return false;
            },
          )
        : null;

    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !entry.isGroup
        ? {
            sessionKey: route.mainSessionKey,
            channel: "signal",
            to: entry.senderRecipient,
            accountId: route.accountId,
          }
        : undefined,
      onRecordError: (err) => {
        logVerbose(`signal: failed updating session meta: ${String(err)}`);
      },
    });

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\\n/g, "\\\\n");
      logVerbose(`signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
    }

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg: deps.cfg,
      agentId: route.agentId,
      channel: "signal",
      accountId: route.accountId,
    });
    const useDraftStreaming = deps.blockStreaming !== true;
    let draftStream: SignalDraftStream | null = null;
    let hasDraftUpdates = false;
    let previewFinalizedByEdit = false;
    let latestPreviewText = "";
    if (useDraftStreaming) {
      draftStream = createSignalDraftStream({
        target: ctxPayload.To,
        baseUrl: deps.baseUrl,
        account: deps.account,
        accountId: deps.accountId,
        maxBytes: deps.mediaMaxBytes,
        maxChars: deps.textLimit,
        throttleMs: 1000,
        log: logVerbose,
        warn: logVerbose,
      });
    }

    const typingCallbacks = createTypingCallbacks({
      start: async () => {
        if (!ctxPayload.To) {
          return;
        }
        await sendTypingSignal(ctxPayload.To, {
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
        });
      },
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "signal",
          target: ctxPayload.To ?? undefined,
          error: err,
        });
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      typingCallbacks,
      deliver: async (payload, info) => {
        const payloadReplyToId = payload.replyToId?.trim();
        const replyToTimestamp = payloadReplyToId
          ? parsePositiveTimestamp(payloadReplyToId)
          : undefined;
        const inferredReplyToAuthor =
          payload.replyToAuthor?.trim() ||
          (payloadReplyToId && payloadReplyToId === entry.messageId
            ? entry.senderRecipient
            : undefined) ||
          (typeof replyToTimestamp === "number"
            ? readCachedMessageAuthor(conversationCacheId, replyToTimestamp)
            : undefined);
        const deliveryPayload = inferredReplyToAuthor
          ? { ...payload, replyToAuthor: inferredReplyToAuthor }
          : payload;
        const isFinal = info.kind === "final";
        const hasMedia =
          Boolean(deliveryPayload.mediaUrl) || (deliveryPayload.mediaUrls?.length ?? 0) > 0;
        const finalText =
          typeof deliveryPayload.text === "string" ? deliveryPayload.text.trimEnd() : "";
        const hasText = finalText.trim().length > 0;
        const previewTimestamp = isFinal ? draftStream?.messageTimestamp() : undefined;
        const canFinalizeViaPreviewEdit =
          isFinal &&
          !hasMedia &&
          !deliveryPayload.isError &&
          hasText &&
          typeof previewTimestamp === "number";

        const deliverNormally = async () =>
          await deps.deliverReplies({
            replies: [deliveryPayload],
            target: ctxPayload.To,
            baseUrl: deps.baseUrl,
            account: deps.account,
            accountId: deps.accountId,
            runtime: deps.runtime,
            maxBytes: deps.mediaMaxBytes,
            textLimit: deps.textLimit,
          });

        if (canFinalizeViaPreviewEdit) {
          const shouldSkipRegressive =
            Boolean(latestPreviewText) &&
            latestPreviewText.startsWith(finalText) &&
            finalText.length < latestPreviewText.length;
          if (shouldSkipRegressive) {
            previewFinalizedByEdit = true;
            hasDraftUpdates = false;
            return;
          }
          try {
            await deps.deliverReplies({
              replies: [deliveryPayload],
              target: ctxPayload.To,
              baseUrl: deps.baseUrl,
              account: deps.account,
              accountId: deps.accountId,
              runtime: deps.runtime,
              maxBytes: deps.mediaMaxBytes,
              textLimit: deps.textLimit,
              editTimestamp: previewTimestamp,
            });
            previewFinalizedByEdit = true;
            hasDraftUpdates = false;
            latestPreviewText = finalText;
            return;
          } catch (err) {
            logVerbose(
              `signal: preview final edit failed; falling back to standard send (${String(err)})`,
            );
            if (draftStream && typeof draftStream.messageTimestamp() === "number") {
              try {
                await draftStream.clear();
              } catch (clearErr) {
                logVerbose(`signal: preview cleanup failed during fallback (${String(clearErr)})`);
              }
            }
            previewFinalizedByEdit = false;
            hasDraftUpdates = false;
            latestPreviewText = "";
            await deliverNormally();
            return;
          }
        }

        if (
          isFinal &&
          draftStream &&
          typeof draftStream.messageTimestamp() === "number" &&
          (hasMedia || deliveryPayload.isError)
        ) {
          try {
            await draftStream.clear();
          } catch (clearErr) {
            logVerbose(`signal: preview cleanup failed before final send (${String(clearErr)})`);
          }
          previewFinalizedByEdit = false;
          hasDraftUpdates = false;
          latestPreviewText = "";
        }

        await deliverNormally();
      },
      onError: (err, info) => {
        deps.runtime.error?.(danger(`signal ${info.kind} reply failed: ${String(err)}`));
      },
    });

    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg: deps.cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        disableBlockStreaming: draftStream
          ? true
          : typeof deps.blockStreaming === "boolean"
            ? !deps.blockStreaming
            : undefined,
        onPartialReply: draftStream
          ? async (payload) => {
              const nextText = payload.text?.trimEnd();
              if (!nextText) {
                return;
              }
              draftStream.update(nextText);
              hasDraftUpdates = true;
              latestPreviewText = nextText;
            }
          : undefined,
        onAssistantMessageStart: draftStream
          ? async () => {
              if (!previewFinalizedByEdit) {
                return;
              }
              draftStream.forceNewMessage();
              hasDraftUpdates = false;
              previewFinalizedByEdit = false;
              latestPreviewText = "";
            }
          : undefined,
        onModelSelected,
      },
    });
    if (draftStream) {
      await draftStream.flush();
      await draftStream.stop();
      const hasUnfinalizedTrailingPreview = hasDraftUpdates && !previewFinalizedByEdit;
      if (hasUnfinalizedTrailingPreview) {
        await draftStream.clear();
        hasDraftUpdates = false;
        latestPreviewText = "";
      }
    }
    markDispatchIdle();
    if (!queuedFinal) {
      if (draftStream) {
        await draftStream.clear();
        latestPreviewText = "";
      }
      if (entry.isGroup && historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: deps.groupHistories,
          historyKey,
          limit: deps.historyLimit,
        });
      }
      return;
    }
    removeAckReactionAfterReply({
      removeAfterReply: removeAckAfterReply,
      ackReactionPromise,
      ackReactionValue: ackReactionPromise && ackReaction ? ackReaction : null,
      remove: async () => {
        if (!ackReaction || !ackTargetTimestamp) {
          return;
        }
        await removeReactionSignal(
          entry.isGroup ? "" : entry.senderRecipient,
          ackTargetTimestamp,
          ackReaction,
          {
            accountId: route.accountId,
            ...(entry.isGroup
              ? { groupId: entry.groupId, targetAuthor: entry.senderRecipient }
              : { targetAuthor: entry.senderRecipient }),
          },
        );
      },
      onError: (err) => {
        logAckFailure({
          log: logVerbose,
          channel: "signal",
          target: `${entry.isGroup ? `group:${entry.groupId}` : entry.senderRecipient}/${ackTargetTimestamp ?? "unknown"}`,
          error: err,
        });
      },
    });
    if (entry.isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
      });
    }
  }

  const inboundDebouncer = createInboundDebouncer<SignalInboundEntry>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `signal:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      if (!entry.bodyText.trim()) {
        return false;
      }
      if (entry.isEdited === true) {
        // Preserve edit metadata as-is; avoid coalescing edited content with unrelated turns.
        return false;
      }
      if (entry.mediaPath || entry.mediaType) {
        return false;
      }
      if ((entry.mediaPaths?.length ?? 0) > 0 || (entry.mediaTypes?.length ?? 0) > 0) {
        return false;
      }
      return !hasControlCommand(entry.bodyText, deps.cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleSignalInboundMessage(last);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.bodyText)
        .filter(Boolean)
        .join("\\n");
      if (!combinedText.trim()) {
        return;
      }
      await handleSignalInboundMessage({
        ...last,
        bodyText: combinedText,
        mediaPath: undefined,
        mediaType: undefined,
        mediaPaths: undefined,
        mediaTypes: undefined,
      });
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
  });

  return async (event: { event?: string; data?: string }) => {
    if (event.event !== "receive" || !event.data) {
      return;
    }

    let payload: SignalReceivePayload | null = null;
    try {
      payload = JSON.parse(event.data) as SignalReceivePayload;
    } catch (err) {
      deps.runtime.error?.(`failed to parse event: ${String(err)}`);
      return;
    }
    if (payload?.exception?.message) {
      deps.runtime.error?.(`receive exception: ${payload.exception.message}`);
    }
    const envelope = payload?.envelope;
    if (!envelope) {
      return;
    }
    if (envelope.syncMessage) {
      return;
    }

    const sender = resolveSignalSender(envelope);
    if (!sender) {
      return;
    }
    if (deps.account && sender.kind === "phone") {
      if (sender.e164 === normalizeE164(deps.account)) {
        return;
      }
    }

    const dataMessage = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const editTargetTimestamp =
      typeof envelope.editMessage?.targetSentTimestamp === "number" &&
      envelope.editMessage.targetSentTimestamp > 0
        ? envelope.editMessage.targetSentTimestamp
        : undefined;
    const isEdited = Boolean(envelope.editMessage);
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;

    // Replace ￼ (object replacement character) with @uuid or @phone from mentions
    // Signal encodes mentions as the object replacement character; hydrate them from metadata first.
    const rawMessage = dataMessage?.message ?? "";
    const normalizedMessage = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const messageText = normalizedMessage.trim();

    const quoteContext = resolveSignalQuoteContext(dataMessage?.quote);
    const quoteText = quoteContext?.replyToBody ?? "";
    const stickerText = buildSignalStickerBody(dataMessage?.sticker);
    const pollText = [
      buildSignalPollCreateBody(dataMessage?.pollCreate),
      buildSignalPollVoteBody(dataMessage?.pollVote),
      buildSignalPollTerminateBody(dataMessage?.pollTerminate),
    ]
      .filter(Boolean)
      .join("\n");
    const hasBodyContent =
      Boolean(messageText || quoteText || pollText || stickerText) ||
      Boolean(!reaction && dataMessage?.attachments?.length);

    if (reaction && !hasBodyContent) {
      if (reaction.isRemove) {
        return;
      } // Ignore reaction removals
      const emojiLabel = reaction.emoji?.trim() || "emoji";
      const senderDisplay = formatSignalSenderDisplay(sender);
      const senderName = envelope.sourceName ?? senderDisplay;
      logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
      const targets = deps.resolveSignalReactionTargets(reaction);
      const shouldNotify = deps.shouldEmitSignalReactionNotification({
        mode: deps.reactionMode,
        account: deps.account,
        targets,
        sender,
        allowlist: deps.reactionAllowlist,
      });
      if (!shouldNotify) {
        return;
      }

      const groupId = reaction.groupInfo?.groupId ?? undefined;
      const groupName = reaction.groupInfo?.groupName ?? undefined;
      const isGroup = Boolean(groupId);
      const senderPeerId = resolveSignalPeerId(sender);
      const route = resolveAgentRoute({
        cfg: deps.cfg,
        channel: "signal",
        accountId: deps.accountId,
        peer: {
          kind: isGroup ? "group" : "direct",
          id: isGroup ? (groupId ?? "unknown") : senderPeerId,
        },
      });
      const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
      const messageId = reaction.targetSentTimestamp
        ? String(reaction.targetSentTimestamp)
        : "unknown";
      const text = deps.buildSignalReactionSystemEventText({
        emojiLabel,
        actorLabel: senderName,
        messageId,
        targetLabel: targets[0]?.display,
        groupLabel,
      });
      const senderId = formatSignalSenderId(sender);
      const contextKey = [
        "signal",
        "reaction",
        "added",
        messageId,
        senderId,
        emojiLabel,
        groupId ?? "",
      ]
        .filter(Boolean)
        .join(":");
      enqueueSystemEvent(text, { sessionKey: route.sessionKey, contextKey });
      return;
    }
    if (!dataMessage) {
      return;
    }

    const senderDisplay = formatSignalSenderDisplay(sender);
    const senderRecipient = resolveSignalRecipient(sender);
    const senderPeerId = resolveSignalPeerId(sender);
    const senderAllowId = formatSignalSenderId(sender);
    if (!senderRecipient) {
      return;
    }
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupId = dataMessage.groupInfo?.groupId ?? undefined;
    const groupName = dataMessage.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const conversationCacheId = isGroup
      ? `group:${groupId ?? "unknown"}`
      : `direct:${senderPeerId}`;
    const editOriginalBody =
      isEdited && typeof editTargetTimestamp === "number"
        ? readCachedMessageBody(conversationCacheId, editTargetTimestamp)
        : undefined;
    const storeAllowFrom =
      deps.dmPolicy === "allowlist"
        ? []
        : await readChannelAllowFromStore("signal").catch(() => []);
    const effectiveDmAllow = [...deps.allowFrom, ...storeAllowFrom];
    const effectiveGroupAllow = [...deps.groupAllowFrom, ...storeAllowFrom];
    const dmAllowed =
      deps.dmPolicy === "open" ? true : isSignalSenderAllowed(sender, effectiveDmAllow);

    if (!isGroup) {
      if (deps.dmPolicy === "disabled") {
        return;
      }
      if (!dmAllowed) {
        if (deps.dmPolicy === "pairing") {
          const senderId = senderAllowId;
          const { code, created } = await upsertChannelPairingRequest({
            channel: "signal",
            id: senderId,
            meta: { name: envelope.sourceName ?? undefined },
          });
          if (created) {
            logVerbose(`signal pairing request sender=${senderId}`);
            try {
              await sendMessageSignal(
                `signal:${senderRecipient}`,
                buildPairingReply({
                  channel: "signal",
                  idLine: senderIdLine,
                  code,
                }),
                {
                  baseUrl: deps.baseUrl,
                  account: deps.account,
                  maxBytes: deps.mediaMaxBytes,
                  accountId: deps.accountId,
                },
              );
            } catch (err) {
              logVerbose(`signal pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(`Blocked signal sender ${senderDisplay} (dmPolicy=${deps.dmPolicy})`);
        }
        return;
      }
    }
    if (isGroup && deps.groupPolicy === "disabled") {
      logVerbose("Blocked signal group message (groupPolicy: disabled)");
      return;
    }
    if (isGroup && deps.groupPolicy === "allowlist") {
      if (effectiveGroupAllow.length === 0) {
        logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        return;
      }
      if (!isSignalSenderAllowed(sender, effectiveGroupAllow)) {
        logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        return;
      }
    }

    const useAccessGroups = deps.cfg.commands?.useAccessGroups !== false;
    const ownerAllowedForCommands = isSignalSenderAllowed(sender, effectiveDmAllow);
    const groupAllowedForCommands = isSignalSenderAllowed(sender, effectiveGroupAllow);
    const hasControlCommandInMessage = hasControlCommand(messageText, deps.cfg);
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveDmAllow.length > 0, allowed: ownerAllowedForCommands },
        { configured: effectiveGroupAllow.length > 0, allowed: groupAllowedForCommands },
      ],
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
    });
    const commandAuthorized = isGroup ? commandGate.commandAuthorized : dmAllowed;
    if (isGroup && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }

    const route = resolveAgentRoute({
      cfg: deps.cfg,
      channel: "signal",
      accountId: deps.accountId,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? (groupId ?? "unknown") : senderPeerId,
      },
    });
    const mentionRegexes = buildMentionRegexes(deps.cfg, route.agentId);
    const wasMentioned = isGroup && matchesMentionPatterns(messageText, mentionRegexes);
    const requireMention =
      isGroup &&
      resolveChannelGroupRequireMention({
        cfg: deps.cfg,
        channel: "signal",
        groupId,
        accountId: deps.accountId,
      });
    const canDetectMention = mentionRegexes.length > 0;
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup,
      requireMention: Boolean(requireMention),
      canDetectMention,
      wasMentioned,
      implicitMention: false,
      hasAnyMention: false,
      allowTextCommands: true,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    });
    const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (isGroup && requireMention && canDetectMention && mentionGate.shouldSkip) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "no mention",
        target: senderDisplay,
      });
      const pendingPlaceholder = (() => {
        if (!dataMessage.attachments?.length) {
          return "";
        }
        // When we're skipping a message we intentionally avoid downloading attachments.
        // Still record a useful placeholder for pending-history context.
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const firstContentType = dataMessage.attachments?.[0]?.contentType;
        const pendingKind = mediaKindFromMime(firstContentType ?? undefined);
        return pendingKind ? `<media:${pendingKind}>` : "<media:attachment>";
      })();
      const pendingBodyText = [messageText, pollText, stickerText]
        .filter(Boolean)
        .join("\n")
        .trim();
      const historyKey = groupId ?? "unknown";
      recordPendingHistoryEntryIfEnabled({
        historyMap: deps.groupHistories,
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: envelope.sourceName ?? senderDisplay,
          body: pendingBodyText || pendingPlaceholder || quoteText,
          timestamp: envelope.timestamp ?? undefined,
          messageId:
            typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
        },
      });
      return;
    }

    const attachments = dataMessage.attachments ?? [];
    const attachmentPlaceholders: string[] = [];
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];

    for (const attachment of attachments) {
      let resolvedMediaType = attachment.contentType ?? undefined;
      if (!deps.ignoreAttachments && attachment.id) {
        try {
          const fetched = await deps.fetchAttachment({
            baseUrl: deps.baseUrl,
            account: deps.account,
            attachment,
            sender: senderRecipient,
            groupId,
            maxBytes: deps.mediaMaxBytes,
          });
          if (fetched) {
            mediaPaths.push(fetched.path);
            resolvedMediaType = fetched.contentType ?? resolvedMediaType;
          }
        } catch (err) {
          deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
        }
      }
      const kind = mediaKindFromMime(resolvedMediaType ?? undefined);
      attachmentPlaceholders.push(kind ? `<media:${kind}>` : "<media:attachment>");
      if (resolvedMediaType?.trim()) {
        mediaTypes.push(resolvedMediaType.trim());
      }
    }

    const mediaPath = mediaPaths[0];
    const mediaType = mediaTypes[0];
    const placeholder = attachmentPlaceholders.join("\n");

    const combinedMessageText = [messageText, pollText, stickerText]
      .filter(Boolean)
      .join("\n")
      .trim();
    const bodyText = combinedMessageText || placeholder || quoteText;
    if (!bodyText) {
      return;
    }

    const receiptTimestamp =
      typeof envelope.timestamp === "number"
        ? envelope.timestamp
        : typeof dataMessage.timestamp === "number"
          ? dataMessage.timestamp
          : undefined;
    if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && receiptTimestamp) {
      try {
        await sendReadReceiptSignal(`signal:${senderRecipient}`, receiptTimestamp, {
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
        });
      } catch (err) {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(err)}`);
      }
    } else if (
      deps.sendReadReceipts &&
      !deps.readReceiptsViaDaemon &&
      !isGroup &&
      !receiptTimestamp
    ) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }

    const cacheTimestamp =
      isEdited && typeof editTargetTimestamp === "number"
        ? editTargetTimestamp
        : typeof dataMessage.timestamp === "number" && dataMessage.timestamp > 0
          ? dataMessage.timestamp
          : typeof envelope.timestamp === "number" && envelope.timestamp > 0
            ? envelope.timestamp
            : undefined;
    if (typeof cacheTimestamp === "number") {
      writeCachedMessageBody(conversationCacheId, cacheTimestamp, bodyText);
      writeCachedMessageAuthor(conversationCacheId, cacheTimestamp, senderRecipient);
    }

    const senderName = envelope.sourceName ?? senderDisplay;
    const messageId =
      typeof receiptTimestamp === "number" && receiptTimestamp > 0
        ? String(receiptTimestamp)
        : undefined;
    recordChannelActivity({
      channel: "signal",
      accountId: deps.accountId,
      direction: "inbound",
      at: receiptTimestamp,
    });
    await inboundDebouncer.enqueue({
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText,
      timestamp: receiptTimestamp,
      messageId,
      mediaPath,
      mediaType,
      mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      commandAuthorized,
      wasMentioned: effectiveWasMentioned,
      isEdited,
      editTargetTimestamp,
      editOriginalBody,
      replyToId: quoteContext?.replyToId,
      replyToBody: quoteContext?.replyToBody,
      replyToSender: quoteContext?.replyToSender,
      replyToIsQuote: quoteContext?.replyToIsQuote,
      requireMention: isGroup ? Boolean(requireMention) : undefined,
      canDetectMention: isGroup ? canDetectMention : undefined,
      shouldBypassMention: isGroup ? mentionGate.shouldBypassMention : undefined,
    });
  };
}
