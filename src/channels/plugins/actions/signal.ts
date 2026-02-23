import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../../agents/tools/common.js";
import { listEnabledSignalAccounts, resolveSignalAccount } from "../../../signal/accounts.js";
import { resolveSignalReactionLevel } from "../../../signal/reaction-level.js";
import { sendReactionSignal, removeReactionSignal } from "../../../signal/send-reactions.js";
import {
  deleteMessageSignal,
  editMessageSignal,
  listStickerPacksSignal,
  sendStickerSignal,
} from "../../../signal/send.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";

const providerId = "signal";
const GROUP_PREFIX = "group:";

function readSignalRecipientParam(params: Record<string, unknown>): string {
  return (
    readStringParam(params, "recipient") ??
    readStringParam(params, "to", {
      required: true,
      label: "recipient (phone number, UUID, or group)",
    })
  );
}

function normalizeSignalReactionRecipient(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return withoutSignal;
  }
  if (withoutSignal.toLowerCase().startsWith("uuid:")) {
    return withoutSignal.slice("uuid:".length).trim();
  }
  return withoutSignal;
}

function resolveSignalReactionTarget(raw: string): { recipient?: string; groupId?: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (!withoutSignal) {
    return {};
  }
  if (withoutSignal.toLowerCase().startsWith(GROUP_PREFIX)) {
    const groupId = withoutSignal.slice(GROUP_PREFIX.length).trim();
    return groupId ? { groupId } : {};
  }
  return { recipient: normalizeSignalReactionRecipient(withoutSignal) };
}

function parseSignalMessageTimestamp(raw: string): number {
  const timestamp = Number.parseInt(raw, 10);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid messageId: ${raw}. Expected numeric timestamp.`);
  }
  return timestamp;
}

function isSignalActionEnabled(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string;
  action: "reactions" | "editMessage" | "deleteMessage" | "stickers";
  defaultValue?: boolean;
}) {
  const actionConfig = resolveSignalAccount({ cfg: params.cfg, accountId: params.accountId }).config
    .actions;
  return createActionGate(actionConfig)(params.action, params.defaultValue);
}

function parseSignalStickerParams(params: Record<string, unknown>): {
  packId: string;
  stickerId: number;
} {
  const stickerIds = readStringArrayParam(params, "stickerId");
  const packIdParam = readStringParam(params, "packId");
  const stickerIdParam = readNumberParam(params, "stickerNum", {
    integer: true,
  });
  const firstSticker = stickerIds?.[0]?.trim();
  if (firstSticker?.includes(":")) {
    const [packIdRaw, stickerIdRaw] = firstSticker.split(":", 2);
    const packId = packIdRaw?.trim();
    const stickerId = Number.parseInt(stickerIdRaw?.trim() ?? "", 10);
    if (!packId || !Number.isFinite(stickerId) || stickerId < 0) {
      throw new Error("Signal stickerId must be in packId:stickerId format.");
    }
    return { packId, stickerId };
  }
  const packId = packIdParam?.trim();
  if (!packId) {
    throw new Error("Signal sticker requires packId or stickerId=packId:stickerId.");
  }
  const stickerId =
    stickerIdParam ??
    (() => {
      if (!firstSticker) {
        return Number.NaN;
      }
      const parsed = Number.parseInt(firstSticker, 10);
      return parsed;
    })();
  if (!Number.isFinite(stickerId) || stickerId < 0) {
    throw new Error("Signal sticker requires a non-negative sticker ID.");
  }
  return {
    packId,
    stickerId: Math.trunc(stickerId),
  };
}

export const signalMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    const accounts = listEnabledSignalAccounts(cfg);
    if (accounts.length === 0) {
      return [];
    }
    const configuredAccounts = accounts.filter((account) => account.configured);
    if (configuredAccounts.length === 0) {
      return [];
    }

    const actions = new Set<ChannelMessageActionName>(["send"]);

    const reactionsEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("reactions"),
    );
    if (reactionsEnabled) {
      actions.add("react");
    }
    const editEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("editMessage"),
    );
    if (editEnabled) {
      actions.add("edit");
    }
    const deleteEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("deleteMessage"),
    );
    if (deleteEnabled) {
      actions.add("delete");
    }
    const stickerEnabled = configuredAccounts.some((account) =>
      createActionGate(account.config.actions)("stickers", false),
    );
    if (stickerEnabled) {
      actions.add("sticker");
      actions.add("sticker-search");
    }

    return Array.from(actions);
  },
  supportsAction: ({ action }) =>
    action === "react" ||
    action === "edit" ||
    action === "delete" ||
    action === "unsend" ||
    action === "sticker" ||
    action === "sticker-search",

  handleAction: async ({ action, params, cfg, accountId, requesterSenderId, toolContext }) => {
    const resolvedAccountId = accountId ?? undefined;

    if (action === "send") {
      throw new Error("Send should be handled by outbound, not actions handler.");
    }

    if (action === "react") {
      // Check reaction level first
      const reactionLevelInfo = resolveSignalReactionLevel({
        cfg,
        accountId: resolvedAccountId,
      });
      if (!reactionLevelInfo.agentReactionsEnabled) {
        throw new Error(
          `Signal agent reactions disabled (reactionLevel="${reactionLevelInfo.level}"). ` +
            `Set channels.signal.reactionLevel to "minimal" or "extensive" to enable.`,
        );
      }

      // Also check the action gate for backward compatibility
      if (!isSignalActionEnabled({ cfg, accountId: resolvedAccountId, action: "reactions" })) {
        throw new Error("Signal reactions are disabled via actions.reactions.");
      }

      const recipientRaw = readSignalRecipientParam(params);
      const target = resolveSignalReactionTarget(recipientRaw);
      if (!target.recipient && !target.groupId) {
        throw new Error("recipient or group required");
      }

      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId (timestamp)",
      });
      const fromMe = params.fromMe === true;
      let targetAuthor = readStringParam(params, "targetAuthor");
      const targetAuthorUuid = readStringParam(params, "targetAuthorUuid");
      const requesterAuthor = requesterSenderId
        ? normalizeSignalReactionRecipient(requesterSenderId)
        : undefined;
      const currentInboundMessageId =
        typeof toolContext?.currentThreadTs === "string" ? toolContext.currentThreadTs.trim() : "";
      const shouldUseRequesterAuthorFallback =
        Boolean(requesterAuthor) &&
        (!currentInboundMessageId || currentInboundMessageId === messageId.trim());
      if (!targetAuthor && !targetAuthorUuid && fromMe) {
        const accountNumber = resolveSignalAccount({
          cfg,
          accountId: resolvedAccountId,
        }).config.account;
        targetAuthor = accountNumber ? normalizeSignalReactionRecipient(accountNumber) : undefined;
      }
      if (!targetAuthor && !targetAuthorUuid && shouldUseRequesterAuthorFallback) {
        targetAuthor = requesterAuthor;
      }
      if (target.groupId && !targetAuthor && !targetAuthorUuid) {
        throw new Error(
          "targetAuthor or targetAuthorUuid required for group reactions. Use inbound sender_id/SenderId for the message author (or fromMe=true for your own message); do not guess.",
        );
      }
      if (!target.groupId && !targetAuthor && !targetAuthorUuid) {
        throw new Error(
          "targetAuthor or targetAuthorUuid required for direct Signal reactions. Use inbound sender_id/SenderId for the message author, or --from-me for your own messages; do not guess.",
        );
      }

      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;

      const timestamp = parseSignalMessageTimestamp(messageId);

      if (remove) {
        if (!emoji) {
          throw new Error("Emoji required to remove reaction.");
        }
        await removeReactionSignal(target.recipient ?? "", timestamp, emoji, {
          accountId: resolvedAccountId,
          groupId: target.groupId,
          targetAuthor,
          targetAuthorUuid,
        });
        return jsonResult({ ok: true, removed: emoji });
      }

      if (!emoji) {
        throw new Error("Emoji required to add reaction.");
      }
      await sendReactionSignal(target.recipient ?? "", timestamp, emoji, {
        accountId: resolvedAccountId,
        groupId: target.groupId,
        targetAuthor,
        targetAuthorUuid,
      });
      return jsonResult({ ok: true, added: emoji });
    }

    if (action === "edit") {
      if (!isSignalActionEnabled({ cfg, accountId: resolvedAccountId, action: "editMessage" })) {
        throw new Error("Signal edit is disabled via actions.editMessage.");
      }
      const recipient = readSignalRecipientParam(params);
      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId (timestamp)",
      });
      const content = readStringParam(params, "message", {
        required: true,
        allowEmpty: false,
      });
      const timestamp = parseSignalMessageTimestamp(messageId);
      await editMessageSignal(recipient, content, timestamp, {
        accountId: resolvedAccountId,
      });
      return jsonResult({ ok: true, edited: true, messageId });
    }

    if (action === "delete" || action === "unsend") {
      if (!isSignalActionEnabled({ cfg, accountId: resolvedAccountId, action: "deleteMessage" })) {
        throw new Error("Signal delete is disabled via actions.deleteMessage.");
      }
      const recipient = readSignalRecipientParam(params);
      const messageId = readStringParam(params, "messageId", {
        required: true,
        label: "messageId (timestamp)",
      });
      const timestamp = parseSignalMessageTimestamp(messageId);
      await deleteMessageSignal(recipient, timestamp, {
        accountId: resolvedAccountId,
      });
      return jsonResult({ ok: true, deleted: true, messageId });
    }

    if (action === "sticker") {
      if (
        !isSignalActionEnabled({
          cfg,
          accountId: resolvedAccountId,
          action: "stickers",
          defaultValue: false,
        })
      ) {
        throw new Error("Signal sticker actions are disabled via actions.stickers.");
      }
      const recipient = readSignalRecipientParam(params);
      const { packId, stickerId } = parseSignalStickerParams(params);
      const result = await sendStickerSignal(recipient, packId, stickerId, {
        accountId: resolvedAccountId,
      });
      return jsonResult({
        ok: true,
        messageId: result.messageId,
        timestamp: result.timestamp,
        packId,
        stickerId,
      });
    }

    if (action === "sticker-search") {
      if (
        !isSignalActionEnabled({
          cfg,
          accountId: resolvedAccountId,
          action: "stickers",
          defaultValue: false,
        })
      ) {
        throw new Error("Signal sticker actions are disabled via actions.stickers.");
      }
      const query = readStringParam(params, "query");
      const limit = readNumberParam(params, "limit", { integer: true });
      const normalizedQuery = query?.trim().toLowerCase();
      const packs = await listStickerPacksSignal({
        accountId: resolvedAccountId,
      });
      const filtered = normalizedQuery
        ? packs.filter((pack) => {
            const fields = [
              typeof pack.packId === "string" ? pack.packId : "",
              typeof pack.id === "string" ? pack.id : "",
              typeof pack.title === "string" ? pack.title : "",
              typeof pack.author === "string" ? pack.author : "",
            ]
              .join(" ")
              .toLowerCase();
            return fields.includes(normalizedQuery);
          })
        : packs;
      const capped =
        typeof limit === "number" && limit > 0 ? filtered.slice(0, Math.trunc(limit)) : filtered;
      return jsonResult({ ok: true, packs: capped });
    }

    throw new Error(`Action ${action} not supported for ${providerId}.`);
  },
};
