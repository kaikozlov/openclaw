import { describe, expect, it, vi } from "vitest";

const listSignalContacts = vi.fn(
  async (): Promise<Array<{ number?: string; uuid?: string; name?: string }>> => [],
);
const listSignalGroups = vi.fn(async (): Promise<Array<{ id?: string; name?: string }>> => []);
const listGroupMembersSignal = vi.fn(
  async (): Promise<Array<{ number?: string; uuid?: string; name?: string }>> => [],
);

vi.mock("./runtime.js", () => ({
  getSignalRuntime: () => ({
    channel: {
      signal: {
        messageActions: {
          listActions: () => [],
          supportsAction: () => false,
          handleAction: vi.fn(),
        },
        sendMessageSignal: vi.fn(),
        sendPollSignal: vi.fn(),
        probeSignal: vi.fn(),
        monitorSignalProvider: vi.fn(),
        listSignalContacts,
        listSignalGroups,
        listGroupMembersSignal,
      },
      text: {
        chunkText: (text: string) => [text],
      },
    },
  }),
}));

const { signalPlugin } = await import("./channel.js");

describe("signal plugin directory adapter", () => {
  it("advertises groupManagement capability", () => {
    expect(signalPlugin.capabilities.groupManagement).toBe(true);
  });

  it("exposes signal-specific message tool hints", () => {
    const hints = signalPlugin.agentPrompt?.messageToolHints?.({
      cfg: {},
      accountId: "default",
    });
    expect(hints).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Signal reactions require message author targeting"),
        expect.stringContaining("sender_id"),
        expect.stringContaining("fromMe=true"),
        expect.stringContaining("Do not guess authors"),
        expect.stringContaining("edit/delete actions require a concrete target `messageId`"),
      ]),
    );
  });

  it("maps contacts to directory peers", async () => {
    listSignalContacts.mockResolvedValueOnce([
      { number: "+1 (555) 000-1111", name: "Ada" },
      { uuid: "123e4567-e89b-12d3-a456-426614174000", name: "Bob" },
    ]);

    const peers = await signalPlugin.directory?.listPeers?.({
      cfg: {},
      accountId: "default",
      query: "ada",
      limit: 5,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });

    expect(peers).toEqual([
      {
        kind: "user",
        id: "+15550001111",
        name: "Ada",
        raw: { number: "+1 (555) 000-1111", name: "Ada" },
      },
    ]);
  });

  it("maps groups and members to directory entries", async () => {
    listSignalGroups.mockResolvedValueOnce([
      { id: "group-a", name: "Alpha Team" },
      { id: "group-b", name: "Beta Team" },
    ]);
    listGroupMembersSignal.mockResolvedValueOnce([
      { number: "+15550002222", name: "Cat" },
      { uuid: "123e4567-e89b-12d3-a456-426614174999", name: "Dog" },
    ]);

    const groups = await signalPlugin.directory?.listGroups?.({
      cfg: {},
      accountId: "default",
      query: "team",
      limit: 10,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });
    const members = await signalPlugin.directory?.listGroupMembers?.({
      cfg: {},
      accountId: "default",
      groupId: "signal:group:group-a",
      limit: 10,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
    });

    expect(groups).toEqual([
      {
        kind: "group",
        id: "group:group-a",
        name: "Alpha Team",
        raw: { id: "group-a", name: "Alpha Team" },
      },
      {
        kind: "group",
        id: "group:group-b",
        name: "Beta Team",
        raw: { id: "group-b", name: "Beta Team" },
      },
    ]);
    expect(members).toEqual([
      {
        kind: "user",
        id: "+15550002222",
        name: "Cat",
        raw: { number: "+15550002222", name: "Cat" },
      },
      {
        kind: "user",
        id: "uuid:123e4567-e89b-12d3-a456-426614174999",
        name: "Dog",
        raw: { uuid: "123e4567-e89b-12d3-a456-426614174999", name: "Dog" },
      },
    ]);
  });
});
