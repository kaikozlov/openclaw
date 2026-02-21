import {
  applyAccountNameToChannelSection,
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  listSignalAccountIds,
  looksLikeSignalTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeE164,
  normalizeSignalMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveDefaultSignalAccountId,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveSignalAccount,
  setAccountEnabledInConfigSection,
  signalOnboardingAdapter,
  SignalConfigSchema,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type ResolvedSignalAccount,
} from "openclaw/plugin-sdk";
import { getSignalRuntime } from "./runtime.js";

const signalMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => getSignalRuntime().channel.signal.messageActions?.listActions?.(ctx) ?? [],
  supportsAction: (ctx) =>
    getSignalRuntime().channel.signal.messageActions?.supportsAction?.(ctx) ?? false,
  handleAction: async (ctx) => {
    const ma = getSignalRuntime().channel.signal.messageActions;
    if (!ma?.handleAction) {
      throw new Error("Signal message actions not available");
    }
    return ma.handleAction(ctx);
  },
};

const meta = getChatChannelMeta("signal");

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

function clampDirectoryLimit(limit?: number | null): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return undefined;
  }
  return Math.trunc(limit);
}

function applyDirectoryQueryAndLimit<T extends { id: string; name?: string }>(
  entries: T[],
  query?: string | null,
  limit?: number | null,
): T[] {
  const q = query?.trim().toLowerCase();
  const filtered = q
    ? entries.filter((entry) => {
        const id = entry.id.toLowerCase();
        const name = entry.name?.toLowerCase() ?? "";
        return id.includes(q) || name.includes(q);
      })
    : entries;
  const capped = clampDirectoryLimit(limit);
  return capped ? filtered.slice(0, capped) : filtered;
}

function normalizeDirectoryGroupId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSignal = trimmed.replace(/^signal:/i, "").trim();
  if (withoutSignal.toLowerCase().startsWith("group:")) {
    return withoutSignal.slice("group:".length).trim();
  }
  return withoutSignal;
}

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  id: "signal",
  meta: {
    ...meta,
  },
  onboarding: signalOnboardingAdapter,
  pairing: {
    idLabel: "signalNumber",
    normalizeAllowEntry: (entry) => entry.replace(/^signal:/i, ""),
    notifyApproval: async ({ id }) => {
      await getSignalRuntime().channel.signal.sendMessageSignal(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    reply: true,
    unsend: true,
    polls: true,
    groupManagement: true,
  },
  agentPrompt: {
    messageToolHints: () => [
      "- Signal reactions require message author targeting. Use `action=react` with `messageId`, `emoji`, and `targetAuthor` (or `targetAuthorUuid`).",
      "- Reacting to the current user message: set `targetAuthor` to inbound sender id (`sender_id`/`SenderId`) when available.",
      "- Reacting to your own Signal message: set `fromMe=true` (or set `targetAuthor` to the account number). Do not guess authors.",
      "- Signal edit/delete actions require a concrete target `messageId` (numeric timestamp). If you do not have one, ask the user for it.",
    ],
  },
  actions: signalMessageActions,
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.signal"] },
  configSchema: buildChannelConfigSchema(SignalConfigSchema),
  config: {
    listAccountIds: (cfg) => listSignalAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSignalAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveSignalAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
        .filter(Boolean),
    resolveDefaultTo: ({ cfg, accountId }) =>
      resolveSignalAccount({ cfg, accountId }).config.defaultTo?.trim() || undefined,
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.signal?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.signal.accounts.${resolvedAccountId}.`
        : "channels.signal.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("signal"),
        normalizeEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim()),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.signal !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Signal groups: groupPolicy="open" allows any member to trigger the bot. Set channels.signal.groupPolicy="allowlist" + channels.signal.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  messaging: {
    normalizeTarget: normalizeSignalMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeSignalTargetId,
      hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>",
    },
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveSignalAccount({ cfg, accountId });
      const id = account.config.account?.trim();
      if (!id) {
        return null;
      }
      return {
        kind: "user",
        id,
        ...(account.name ? { name: account.name } : {}),
      };
    },
    listPeers: async ({ accountId, query, limit }) => {
      const contacts = await getSignalRuntime().channel.signal.listSignalContacts({
        accountId: accountId ?? undefined,
      });
      const entries = contacts
        .map((contact) => {
          const number = typeof contact.number === "string" ? normalizeE164(contact.number) : "";
          const uuid = typeof contact.uuid === "string" ? contact.uuid.trim() : "";
          const id = number || (uuid ? `uuid:${uuid}` : "");
          if (!id) {
            return null;
          }
          const name = typeof contact.name === "string" ? contact.name.trim() : "";
          return {
            kind: "user" as const,
            id,
            ...(name ? { name } : {}),
            raw: contact,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return applyDirectoryQueryAndLimit(entries, query, limit);
    },
    listGroups: async ({ accountId, query, limit }) => {
      const groups = await getSignalRuntime().channel.signal.listSignalGroups(
        {
          accountId: accountId ?? undefined,
        },
        { detailed: false },
      );
      const entries = groups
        .map((group) => {
          const groupId = typeof group.id === "string" ? group.id.trim() : "";
          if (!groupId) {
            return null;
          }
          const name = typeof group.name === "string" ? group.name.trim() : "";
          return {
            kind: "group" as const,
            id: `group:${groupId}`,
            ...(name ? { name } : {}),
            raw: group,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return applyDirectoryQueryAndLimit(entries, query, limit);
    },
    listGroupMembers: async ({ accountId, groupId, limit }) => {
      const members = await getSignalRuntime().channel.signal.listGroupMembersSignal(
        normalizeDirectoryGroupId(groupId),
        {
          accountId: accountId ?? undefined,
        },
      );
      const entries = members
        .map((member) => {
          const number = typeof member.number === "string" ? normalizeE164(member.number) : "";
          const uuid = typeof member.uuid === "string" ? member.uuid.trim() : "";
          const id = number || (uuid ? `uuid:${uuid}` : "");
          if (!id) {
            return null;
          }
          const name = typeof member.name === "string" ? member.name.trim() : "";
          return {
            kind: "user" as const,
            id,
            ...(name ? { name } : {}),
            raw: member,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      return applyDirectoryQueryAndLimit(entries, undefined, limit);
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "signal",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (
        !input.signalNumber &&
        !input.httpUrl &&
        !input.httpHost &&
        !input.httpPort &&
        !input.cliPath
      ) {
        return "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "signal",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "signal",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            signal: {
              ...next.channels?.signal,
              enabled: true,
              ...(input.signalNumber ? { account: input.signalNumber } : {}),
              ...(input.cliPath ? { cliPath: input.cliPath } : {}),
              ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
              ...(input.httpHost ? { httpHost: input.httpHost } : {}),
              ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          signal: {
            ...next.channels?.signal,
            enabled: true,
            accounts: {
              ...next.channels?.signal?.accounts,
              [accountId]: {
                ...next.channels?.signal?.accounts?.[accountId],
                enabled: true,
                ...(input.signalNumber ? { account: input.signalNumber } : {}),
                ...(input.cliPath ? { cliPath: input.cliPath } : {}),
                ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
                ...(input.httpHost ? { httpHost: input.httpHost } : {}),
                ...(input.httpPort ? { httpPort: Number(input.httpPort) } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getSignalRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    pollMaxOptions: 12,
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, replyToAuthor }) => {
      const send = deps?.sendSignal ?? getSignalRuntime().channel.signal.sendMessageSignal;
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      });
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
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps, replyToId, replyToAuthor }) => {
      const send = deps?.sendSignal ?? getSignalRuntime().channel.signal.sendMessageSignal;
      const maxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: ({ cfg, accountId }) =>
          cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ??
          cfg.channels?.signal?.mediaMaxMb,
        accountId,
      });
      const quoteTimestamp = parseSignalQuoteTimestamp(replyToId);
      const result = await send(to, text, {
        mediaUrl,
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
    sendPoll: async ({ to, poll, accountId }) =>
      await getSignalRuntime().channel.signal.sendPollSignal(to, poll, {
        accountId: accountId ?? undefined,
      }),
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const baseUrl = account.baseUrl;
      return await getSignalRuntime().channel.signal.probeSignal(baseUrl, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      baseUrl: account.baseUrl,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      return getSignalRuntime().channel.signal.monitorSignalProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
      });
    },
  },
};
