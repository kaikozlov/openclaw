import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";

const handleDiscordAction = vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } }));
const handleTelegramAction = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const sendReactionSignal = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const removeReactionSignal = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const editMessageSignal = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const deleteMessageSignal = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
const sendStickerSignal = vi.fn(async (..._args: unknown[]) => ({
  messageId: "1700000000999",
  timestamp: 1700000000999,
}));
const listStickerPacksSignal = vi.fn(
  async (..._args: unknown[]): Promise<Array<{ packId: string; title?: string }>> => [],
);
const handleSlackAction = vi.fn(async (..._args: unknown[]) => ({ details: { ok: true } }));

vi.mock("../../../agents/tools/discord-actions.js", () => ({
  handleDiscordAction,
}));

vi.mock("../../../agents/tools/telegram-actions.js", () => ({
  handleTelegramAction,
}));

vi.mock("../../../signal/send-reactions.js", () => ({
  sendReactionSignal,
  removeReactionSignal,
}));

vi.mock("../../../signal/send.js", () => ({
  editMessageSignal,
  deleteMessageSignal,
  sendStickerSignal,
  listStickerPacksSignal,
}));

vi.mock("../../../agents/tools/slack-actions.js", () => ({
  handleSlackAction,
}));

const { discordMessageActions } = await import("./discord.js");
const { handleDiscordMessageAction } = await import("./discord/handle-action.js");
const { telegramMessageActions } = await import("./telegram.js");
const { signalMessageActions } = await import("./signal.js");
const { createSlackActions } = await import("../slack.actions.js");

function telegramCfg(): OpenClawConfig {
  return { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
}

function slackHarness() {
  const cfg = { channels: { slack: { botToken: "tok" } } } as OpenClawConfig;
  const actions = createSlackActions("slack");
  return { cfg, actions };
}

type SlackActionInput = Parameters<
  NonNullable<ReturnType<typeof createSlackActions>["handleAction"]>
>[0];

async function runSlackAction(
  action: SlackActionInput["action"],
  params: SlackActionInput["params"],
) {
  const { cfg, actions } = slackHarness();
  await actions.handleAction?.({
    channel: "slack",
    action,
    cfg,
    params,
  });
  return { cfg, actions };
}

function expectFirstSlackAction(expected: Record<string, unknown>) {
  const [params] = handleSlackAction.mock.calls[0] ?? [];
  expect(params).toMatchObject(expected);
}

function expectModerationActions(actions: string[]) {
  expect(actions).toContain("timeout");
  expect(actions).toContain("kick");
  expect(actions).toContain("ban");
}

async function expectSlackSendRejected(params: Record<string, unknown>, error: RegExp) {
  const { cfg, actions } = slackHarness();
  await expect(
    actions.handleAction?.({
      channel: "slack",
      action: "send",
      cfg,
      params,
    }),
  ).rejects.toThrow(error);
  expect(handleSlackAction).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("discord message actions", () => {
  it("lists channel and upload actions by default", async () => {
    const cfg = { channels: { discord: { token: "d0" } } } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("emoji-upload");
    expect(actions).toContain("sticker-upload");
    expect(actions).toContain("channel-create");
  });

  it("respects disabled channel actions", async () => {
    const cfg = {
      channels: { discord: { token: "d0", actions: { channels: false } } },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("channel-create");
  });

  it("lists moderation actions when per-account config enables them", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            vime: { token: "d1", actions: { moderation: true } },
          },
        },
      },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expectModerationActions(actions);
  });

  it("lists moderation when one account enables and another omits", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { token: "d1", actions: { moderation: true } },
            chat: { token: "d2" },
          },
        },
      },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expectModerationActions(actions);
  });

  it("omits moderation when all accounts omit it", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            ops: { token: "d1" },
            chat: { token: "d2" },
          },
        },
      },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    // moderation defaults to false, so without explicit true it stays hidden
    expect(actions).not.toContain("timeout");
    expect(actions).not.toContain("kick");
    expect(actions).not.toContain("ban");
  });

  it("inherits top-level channel gate when account overrides moderation only", () => {
    const cfg = {
      channels: {
        discord: {
          actions: { channels: false },
          accounts: {
            vime: { token: "d1", actions: { moderation: true } },
          },
        },
      },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("timeout");
    expect(actions).not.toContain("channel-create");
  });

  it("allows account to explicitly re-enable top-level disabled channels", () => {
    const cfg = {
      channels: {
        discord: {
          actions: { channels: false },
          accounts: {
            vime: { token: "d1", actions: { moderation: true, channels: true } },
          },
        },
      },
    } as OpenClawConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("timeout");
    expect(actions).toContain("channel-create");
  });
});

describe("handleDiscordMessageAction", () => {
  it("forwards context accountId for send", async () => {
    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        accountId: "ops",
        to: "channel:123",
        content: "hi",
      }),
      expect.any(Object),
      expect.objectContaining({ mediaLocalRoots: undefined }),
    );
  });

  it("forwards legacy embeds for send", async () => {
    const embeds = [{ title: "Legacy", description: "Use components v2." }];

    await handleDiscordMessageAction({
      action: "send",
      params: {
        to: "channel:123",
        message: "hi",
        embeds,
      },
      cfg: {} as OpenClawConfig,
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:123",
        content: "hi",
        embeds,
      }),
      expect.any(Object),
      expect.objectContaining({ mediaLocalRoots: undefined }),
    );
  });

  it("falls back to params accountId when context missing", async () => {
    await handleDiscordMessageAction({
      action: "poll",
      params: {
        to: "channel:123",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
        accountId: "marve",
      },
      cfg: {} as OpenClawConfig,
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "poll",
        accountId: "marve",
        to: "channel:123",
        question: "Ready?",
        answers: ["Yes", "No"],
      }),
      expect.any(Object),
      expect.objectContaining({ mediaLocalRoots: undefined }),
    );
  });

  it("forwards accountId for thread replies", async () => {
    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        channelId: "123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "threadReply",
        accountId: "ops",
        channelId: "123",
        content: "hi",
      }),
      expect.any(Object),
    );
  });

  it("accepts threadId for thread replies (tool compatibility)", async () => {
    await handleDiscordMessageAction({
      action: "thread-reply",
      params: {
        // The `message` tool uses `threadId`.
        threadId: "999",
        // Include a conflicting channelId to ensure threadId takes precedence.
        channelId: "123",
        message: "hi",
      },
      cfg: {} as OpenClawConfig,
      accountId: "ops",
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "threadReply",
        accountId: "ops",
        channelId: "999",
        content: "hi",
      }),
      expect.any(Object),
    );
  });

  it("forwards thread-create message as content", async () => {
    await handleDiscordMessageAction({
      action: "thread-create",
      params: {
        to: "channel:123456789",
        threadName: "Forum thread",
        message: "Initial forum post body",
      },
      cfg: {} as OpenClawConfig,
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "threadCreate",
        channelId: "123456789",
        name: "Forum thread",
        content: "Initial forum post body",
      }),
      expect.any(Object),
      expect.objectContaining({ mediaLocalRoots: undefined }),
    );
  });

  it("forwards thread edit fields for channel-edit", async () => {
    await handleDiscordMessageAction({
      action: "channel-edit",
      params: {
        channelId: "123456789",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      },
      cfg: {} as OpenClawConfig,
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channelEdit",
        channelId: "123456789",
        archived: true,
        locked: false,
        autoArchiveDuration: 1440,
      }),
      expect.any(Object),
    );
  });

  it("uses trusted requesterSenderId for moderation and ignores params senderUserId", async () => {
    await handleDiscordMessageAction({
      action: "timeout",
      params: {
        guildId: "guild-1",
        userId: "user-2",
        durationMin: 5,
        senderUserId: "spoofed-admin-id",
      },
      cfg: {} as OpenClawConfig,
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    expect(handleDiscordAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "timeout",
        guildId: "guild-1",
        userId: "user-2",
        durationMinutes: 5,
        senderUserId: "trusted-sender-id",
      }),
      expect.any(Object),
    );
  });
});

describe("telegramMessageActions", () => {
  it("excludes sticker actions when not enabled", () => {
    const cfg = telegramCfg();
    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];
    expect(actions).not.toContain("sticker");
    expect(actions).not.toContain("sticker-search");
  });

  it("allows media-only sends and passes asVoice", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "send",
      params: {
        to: "123",
        media: "https://example.com/voice.ogg",
        asVoice: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "123",
        content: "",
        mediaUrl: "https://example.com/voice.ogg",
        asVoice: true,
      }),
      cfg,
      expect.objectContaining({ mediaLocalRoots: undefined }),
    );
  });

  it("passes silent flag for silent sends", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "send",
      params: {
        to: "456",
        message: "Silent notification test",
        silent: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "456",
        content: "Silent notification test",
        silent: true,
      }),
      cfg,
      expect.objectContaining({ mediaLocalRoots: undefined }),
    );
  });

  it("maps edit action params into editMessage", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "edit",
      params: {
        chatId: "123",
        messageId: 42,
        message: "Updated",
        buttons: [],
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "editMessage",
        chatId: "123",
        messageId: 42,
        content: "Updated",
        buttons: [],
        accountId: undefined,
      },
      cfg,
      expect.objectContaining({ mediaLocalRoots: undefined }),
    );
  });

  it("rejects non-integer messageId for edit before reaching telegram-actions", async () => {
    const cfg = telegramCfg();
    const handleAction = telegramMessageActions.handleAction;
    if (!handleAction) {
      throw new Error("telegram handleAction unavailable");
    }

    await expect(
      handleAction({
        channel: "telegram",
        action: "edit",
        params: {
          chatId: "123",
          messageId: "nope",
          message: "Updated",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow();

    expect(handleTelegramAction).not.toHaveBeenCalled();
  });

  it("lists sticker actions when per-account config enables them", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            media: { botToken: "tok", actions: { sticker: true } },
          },
        },
      },
    } as OpenClawConfig;
    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("sticker");
    expect(actions).toContain("sticker-search");
  });

  it("omits sticker when all accounts omit it", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            a: { botToken: "tok1" },
            b: { botToken: "tok2" },
          },
        },
      },
    } as OpenClawConfig;
    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("sticker");
    expect(actions).not.toContain("sticker-search");
  });

  it("inherits top-level reaction gate when account overrides sticker only", () => {
    const cfg = {
      channels: {
        telegram: {
          actions: { reactions: false },
          accounts: {
            media: { botToken: "tok", actions: { sticker: true } },
          },
        },
      },
    } as OpenClawConfig;
    const actions = telegramMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("sticker");
    expect(actions).toContain("sticker-search");
    expect(actions).not.toContain("react");
  });

  it("accepts numeric messageId and channelId for reactions", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "react",
      params: {
        channelId: 123,
        messageId: 456,
        emoji: "ok",
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledTimes(1);
    const call = handleTelegramAction.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("missing telegram action call");
    }
    const callPayload = call as Record<string, unknown>;
    expect(callPayload.action).toBe("react");
    expect(String(callPayload.chatId)).toBe("123");
    expect(String(callPayload.messageId)).toBe("456");
    expect(callPayload.emoji).toBe("ok");
  });

  it("accepts snake_case message_id for reactions", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "react",
      params: {
        channelId: 123,
        message_id: "456",
        emoji: "ok",
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledTimes(1);
    const call = handleTelegramAction.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("missing telegram action call");
    }
    const callPayload = call as Record<string, unknown>;
    expect(callPayload.action).toBe("react");
    expect(String(callPayload.chatId)).toBe("123");
    expect(String(callPayload.messageId)).toBe("456");
  });

  it("falls back to toolContext.currentMessageId for reactions when messageId is omitted", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "react",
      params: {
        chatId: "123",
        emoji: "ok",
      },
      cfg,
      accountId: undefined,
      toolContext: { currentMessageId: "9001" },
    });

    expect(handleTelegramAction).toHaveBeenCalledTimes(1);
    const call = handleTelegramAction.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("missing telegram action call");
    }
    const callPayload = call as Record<string, unknown>;
    expect(callPayload.action).toBe("react");
    expect(String(callPayload.messageId)).toBe("9001");
  });

  it("forwards missing reaction messageId to telegram-actions for soft-fail handling", async () => {
    const cfg = telegramCfg();

    await expect(
      telegramMessageActions.handleAction?.({
        channel: "telegram",
        action: "react",
        params: {
          chatId: "123",
          emoji: "ok",
        },
        cfg,
        accountId: undefined,
      }),
    ).resolves.toBeDefined();

    expect(handleTelegramAction).toHaveBeenCalledTimes(1);
    const call = handleTelegramAction.mock.calls[0]?.[0];
    if (!call) {
      throw new Error("missing telegram action call");
    }
    const callPayload = call as Record<string, unknown>;
    expect(callPayload.action).toBe("react");
    expect(callPayload.messageId).toBeUndefined();
  });

  it("maps topic-create params into createForumTopic", async () => {
    const cfg = telegramCfg();

    await telegramMessageActions.handleAction?.({
      channel: "telegram",
      action: "topic-create",
      params: {
        to: "telegram:group:-1001234567890:topic:271",
        name: "Build Updates",
      },
      cfg,
      accountId: undefined,
    });

    expect(handleTelegramAction).toHaveBeenCalledWith(
      {
        action: "createForumTopic",
        chatId: "telegram:group:-1001234567890:topic:271",
        name: "Build Updates",
        iconColor: undefined,
        iconCustomEmojiId: undefined,
        accountId: undefined,
      },
      cfg,
      expect.objectContaining({ mediaLocalRoots: undefined }),
    );
  });
});

describe("signalMessageActions", () => {
  it("returns no actions when no configured accounts exist", () => {
    const cfg = {} as OpenClawConfig;
    expect(signalMessageActions.listActions?.({ cfg }) ?? []).toEqual([]);
  });

  it("hides react when reactions are disabled", () => {
    const cfg = {
      channels: {
        signal: {
          account: "+15550001111",
          actions: { reactions: false, editMessage: false, deleteMessage: false },
        },
      },
    } as OpenClawConfig;
    expect(signalMessageActions.listActions?.({ cfg }) ?? []).toEqual(["send"]);
  });

  it("enables react when at least one account allows reactions", () => {
    const cfg = {
      channels: {
        signal: {
          actions: { reactions: false },
          accounts: {
            work: { account: "+15550001111", actions: { reactions: true } },
          },
        },
      },
    } as OpenClawConfig;
    expect(signalMessageActions.listActions?.({ cfg }) ?? []).toEqual([
      "send",
      "react",
      "edit",
      "delete",
    ]);
  });

  it("lists sticker actions when enabled on at least one account", () => {
    const cfg = {
      channels: {
        signal: {
          actions: { stickers: false },
          accounts: {
            work: { account: "+15550001111", actions: { stickers: true } },
          },
        },
      },
    } as OpenClawConfig;

    expect(signalMessageActions.listActions?.({ cfg }) ?? []).toEqual([
      "send",
      "react",
      "edit",
      "delete",
      "sticker",
      "sticker-search",
    ]);
  });

  it("skips send for plugin dispatch", () => {
    expect(signalMessageActions.supportsAction?.({ action: "send" })).toBe(false);
    expect(signalMessageActions.supportsAction?.({ action: "react" })).toBe(true);
    expect(signalMessageActions.supportsAction?.({ action: "edit" })).toBe(true);
    expect(signalMessageActions.supportsAction?.({ action: "delete" })).toBe(true);
    expect(signalMessageActions.supportsAction?.({ action: "unsend" })).toBe(true);
    expect(signalMessageActions.supportsAction?.({ action: "sticker" })).toBe(true);
    expect(signalMessageActions.supportsAction?.({ action: "sticker-search" })).toBe(true);
    expect(signalMessageActions.supportsAction?.({ action: "poll" })).toBe(false);
  });

  it("blocks reactions when action gate is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as OpenClawConfig;
    const handleAction = signalMessageActions.handleAction;
    if (!handleAction) {
      throw new Error("signal handleAction unavailable");
    }

    await expect(
      handleAction({
        channel: "signal",
        action: "react",
        params: { to: "+15550001111", messageId: "123", emoji: "✅" },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.reactions/);
  });

  it("uses account-level actions when enabled", async () => {
    const cfg = {
      channels: {
        signal: {
          actions: { reactions: false },
          accounts: {
            work: { account: "+15550001111", actions: { reactions: true } },
          },
        },
      },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "react",
      params: { to: "+15550001111", messageId: "123", emoji: "👍" },
      cfg,
      accountId: "work",
      requesterSenderId: "+15550001111",
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("+15550001111", 123, "👍", {
      accountId: "work",
      targetAuthor: "+15550001111",
      targetAuthorUuid: undefined,
    });
  });

  it("uses requesterSenderId fallback only when reacting to current inbound message", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "react",
      params: { to: "+15550001111", messageId: "123", emoji: "👍" },
      cfg,
      accountId: undefined,
      requesterSenderId: "+15550001111",
      toolContext: { currentThreadTs: "123" },
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("+15550001111", 123, "👍", {
      accountId: undefined,
      targetAuthor: "+15550001111",
      targetAuthorUuid: undefined,
    });
  });

  it("does not use requesterSenderId fallback when messageId differs from current inbound message", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction?.({
        channel: "signal",
        action: "react",
        params: { to: "+15550002222", messageId: "999", emoji: "👍" },
        cfg,
        accountId: undefined,
        requesterSenderId: "+15550001111",
        toolContext: { currentThreadTs: "123" },
      }),
    ).rejects.toThrow(/targetAuthor|from-me/i);
  });

  it("normalizes uuid recipients", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "react",
      params: {
        recipient: "uuid:123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "🔥",
      },
      cfg,
      accountId: undefined,
      requesterSenderId: "uuid:123e4567-e89b-12d3-a456-426614174000",
    });

    expect(sendReactionSignal).toHaveBeenCalledWith(
      "123e4567-e89b-12d3-a456-426614174000",
      123,
      "🔥",
      {
        accountId: undefined,
        targetAuthor: "123e4567-e89b-12d3-a456-426614174000",
        targetAuthorUuid: undefined,
      },
    );
  });

  it("requires targetAuthor for direct reactions outside inbound context", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction?.({
        channel: "signal",
        action: "react",
        params: {
          to: "+15550001111",
          messageId: "123",
          emoji: "🔥",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/targetAuthor|from-me/i);
  });

  it("uses account author for direct reactions when fromMe is true", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "react",
      params: {
        to: "+15550002222",
        messageId: "123",
        emoji: "🔥",
        fromMe: true,
      },
      cfg,
      accountId: undefined,
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("+15550002222", 123, "🔥", {
      accountId: undefined,
      targetAuthor: "+15550001111",
      targetAuthorUuid: undefined,
    });
  });

  it("requires targetAuthor for group reactions", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;
    const handleAction = signalMessageActions.handleAction;
    if (!handleAction) {
      throw new Error("signal handleAction unavailable");
    }

    await expect(
      handleAction({
        channel: "signal",
        action: "react",
        params: { to: "signal:group:group-id", messageId: "123", emoji: "✅" },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/targetAuthor/);
  });

  it("passes groupId and targetAuthor for group reactions", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "react",
      params: {
        to: "signal:group:group-id",
        targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
        messageId: "123",
        emoji: "✅",
      },
      cfg,
      accountId: undefined,
    });

    expect(sendReactionSignal).toHaveBeenCalledWith("", 123, "✅", {
      accountId: undefined,
      groupId: "group-id",
      targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
      targetAuthorUuid: undefined,
    });
  });

  it("edits a Signal message when edit action is enabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { editMessage: true } } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "edit",
      params: {
        to: "signal:group:test-group-id",
        messageId: "1700000000100",
        message: "updated body",
      },
      cfg,
      accountId: "default",
    });

    expect(editMessageSignal).toHaveBeenCalledWith(
      "signal:group:test-group-id",
      "updated body",
      1700000000100,
      { accountId: "default" },
    );
  });

  it("blocks edit when actions.editMessage is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { editMessage: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction?.({
        channel: "signal",
        action: "edit",
        params: {
          to: "signal:+15550001111",
          messageId: "1700000000100",
          message: "updated body",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.editMessage/);
    expect(editMessageSignal).not.toHaveBeenCalled();
  });

  it("deletes a Signal message when delete action is enabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { deleteMessage: true } } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "delete",
      params: {
        recipient: "signal:+15550001111",
        messageId: "1700000000200",
      },
      cfg,
      accountId: "default",
    });

    expect(deleteMessageSignal).toHaveBeenCalledWith("signal:+15550001111", 1700000000200, {
      accountId: "default",
    });
  });

  it("supports unsend as an alias for delete", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { deleteMessage: true } } },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "unsend",
      params: {
        to: "signal:+15550001111",
        messageId: "1700000000300",
      },
      cfg,
      accountId: undefined,
    });

    expect(deleteMessageSignal).toHaveBeenCalledWith("signal:+15550001111", 1700000000300, {
      accountId: undefined,
    });
  });

  it("blocks delete when actions.deleteMessage is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { deleteMessage: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction?.({
        channel: "signal",
        action: "delete",
        params: {
          to: "signal:+15550001111",
          messageId: "1700000000200",
        },
        cfg,
        accountId: undefined,
      }),
    ).rejects.toThrow(/actions\.deleteMessage/);
    expect(deleteMessageSignal).not.toHaveBeenCalled();
  });

  it("sends Signal stickers from packId:stickerId values", async () => {
    const cfg = {
      channels: {
        signal: { account: "+15550001111", actions: { stickers: true } },
      },
    } as OpenClawConfig;

    await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "sticker",
      params: {
        to: "signal:group:test-group-id",
        stickerId: ["pack-abc:7"],
      },
      cfg,
      accountId: "default",
    });

    expect(sendStickerSignal).toHaveBeenCalledWith("signal:group:test-group-id", "pack-abc", 7, {
      accountId: "default",
    });
  });

  it("lists sticker packs via sticker-search", async () => {
    listStickerPacksSignal.mockResolvedValueOnce([
      { packId: "pack-abc", title: "Cats" },
      { packId: "pack-def", title: "Dogs" },
    ]);
    const cfg = {
      channels: {
        signal: { account: "+15550001111", actions: { stickers: true } },
      },
    } as OpenClawConfig;

    const result = await signalMessageActions.handleAction?.({
      channel: "signal",
      action: "sticker-search",
      params: {
        query: "cat",
      },
      cfg,
      accountId: undefined,
    });

    expect(listStickerPacksSignal).toHaveBeenCalledWith({
      accountId: undefined,
    });
    const details = result?.details as { packs?: Array<{ packId: string }> } | undefined;
    expect(details?.packs).toEqual([{ packId: "pack-abc", title: "Cats" }]);
  });
});

describe("slack actions adapter", () => {
  it("forwards threadId for read", async () => {
    await runSlackAction("read", {
      channelId: "C1",
      threadId: "171234.567",
    });

    expectFirstSlackAction({
      action: "readMessages",
      channelId: "C1",
      threadId: "171234.567",
    });
  });

  it("forwards normalized limit for emoji-list", async () => {
    await runSlackAction("emoji-list", {
      limit: "2.9",
    });

    expectFirstSlackAction({
      action: "emojiList",
      limit: 2,
    });
  });

  it("forwards blocks JSON for send", async () => {
    await runSlackAction("send", {
      to: "channel:C1",
      message: "",
      blocks: JSON.stringify([{ type: "divider" }]),
    });

    expectFirstSlackAction({
      action: "sendMessage",
      to: "channel:C1",
      content: "",
      blocks: [{ type: "divider" }],
    });
  });

  it("forwards blocks arrays for send", async () => {
    await runSlackAction("send", {
      to: "channel:C1",
      message: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
    });

    expectFirstSlackAction({
      action: "sendMessage",
      to: "channel:C1",
      content: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
    });
  });

  it("rejects invalid blocks JSON for send", async () => {
    await expectSlackSendRejected(
      {
        to: "channel:C1",
        message: "",
        blocks: "{bad-json",
      },
      /blocks must be valid JSON/i,
    );
  });

  it("rejects empty blocks arrays for send", async () => {
    await expectSlackSendRejected(
      {
        to: "channel:C1",
        message: "",
        blocks: "[]",
      },
      /at least one block/i,
    );
  });

  it("rejects send when both blocks and media are provided", async () => {
    await expectSlackSendRejected(
      {
        to: "channel:C1",
        message: "",
        media: "https://example.com/image.png",
        blocks: JSON.stringify([{ type: "divider" }]),
      },
      /does not support blocks with media/i,
    );
  });

  it("forwards blocks JSON for edit", async () => {
    await runSlackAction("edit", {
      channelId: "C1",
      messageId: "171234.567",
      message: "",
      blocks: JSON.stringify([{ type: "divider" }]),
    });

    expectFirstSlackAction({
      action: "editMessage",
      channelId: "C1",
      messageId: "171234.567",
      content: "",
      blocks: [{ type: "divider" }],
    });
  });

  it("forwards blocks arrays for edit", async () => {
    await runSlackAction("edit", {
      channelId: "C1",
      messageId: "171234.567",
      message: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
    });

    expectFirstSlackAction({
      action: "editMessage",
      channelId: "C1",
      messageId: "171234.567",
      content: "",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "updated" } }],
    });
  });

  it("rejects edit when both message and blocks are missing", async () => {
    const { cfg, actions } = slackHarness();

    await expect(
      actions.handleAction?.({
        channel: "slack",
        action: "edit",
        cfg,
        params: {
          channelId: "C1",
          messageId: "171234.567",
          message: "",
        },
      }),
    ).rejects.toThrow(/edit requires message or blocks/i);
    expect(handleSlackAction).not.toHaveBeenCalled();
  });
});
