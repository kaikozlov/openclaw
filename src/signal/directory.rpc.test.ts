import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSignalContacts, listSignalGroups, updateContactSignal } from "./directory.js";
import {
  addGroupMemberSignal,
  joinGroupSignal,
  listGroupMembersSignal,
  quitGroupSignal,
  removeGroupMemberSignal,
  updateGroupSignal,
} from "./groups.js";

const rpcMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({}),
  };
});

vi.mock("./accounts.js", () => ({
  resolveSignalAccount: () => ({
    accountId: "default",
    enabled: true,
    baseUrl: "http://signal.local",
    configured: true,
    config: { account: "+15550001111" },
  }),
}));

vi.mock("./client.js", () => ({
  signalRpcRequestWithRetry: (...args: unknown[]) => rpcMock(...args),
}));

describe("signal directory and group RPC methods", () => {
  beforeEach(() => {
    rpcMock.mockReset().mockResolvedValue(undefined);
  });

  it("lists groups via listGroups", async () => {
    rpcMock.mockResolvedValueOnce([{ id: "group-a", name: "Alpha" }]);
    const groups = await listSignalGroups({}, { detailed: true });

    expect(rpcMock).toHaveBeenCalledWith("listGroups", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.account).toBe("+15550001111");
    expect(params.detailed).toBe(true);
    expect(groups).toEqual([{ id: "group-a", name: "Alpha" }]);
  });

  it("lists contacts via listContacts", async () => {
    rpcMock.mockResolvedValueOnce([{ number: "+15550002222", name: "Ada" }]);
    const contacts = await listSignalContacts();

    expect(rpcMock).toHaveBeenCalledWith("listContacts", expect.any(Object), expect.any(Object));
    expect(contacts).toEqual([{ number: "+15550002222", name: "Ada" }]);
  });

  it("updates contacts via updateContact", async () => {
    await updateContactSignal("signal:+15550002222", "Ada Lovelace");

    expect(rpcMock).toHaveBeenCalledWith("updateContact", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.recipient).toBe("+15550002222");
    expect(params.name).toBe("Ada Lovelace");
  });

  it("lists members from detailed listGroups payloads", async () => {
    rpcMock.mockResolvedValueOnce([
      {
        id: "group-a",
        members: [
          { number: "+15550003333", name: "Bob" },
          { uuid: "123e4567-e89b-12d3-a456-426614174000", name: "Cat" },
        ],
      },
    ]);

    const members = await listGroupMembersSignal("signal:group:group-a");

    expect(rpcMock).toHaveBeenCalledWith("listGroups", expect.any(Object), expect.any(Object));
    expect(members).toEqual([
      { number: "+15550003333", name: "Bob" },
      { uuid: "123e4567-e89b-12d3-a456-426614174000", name: "Cat" },
    ]);
  });

  it("updates groups via updateGroup", async () => {
    await updateGroupSignal("group-a", {
      name: "Renamed",
      addMembers: ["+15550004444"],
      removeMembers: ["uuid:123e4567-e89b-12d3-a456-426614174000"],
    });

    expect(rpcMock).toHaveBeenCalledWith("updateGroup", expect.any(Object), expect.any(Object));
    const params = rpcMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params.groupId).toBe("group-a");
    expect(params.name).toBe("Renamed");
    expect(params.addMembers).toEqual(["+15550004444"]);
    expect(params.removeMembers).toEqual(["123e4567-e89b-12d3-a456-426614174000"]);
  });

  it("adds and removes members through updateGroup", async () => {
    await addGroupMemberSignal("group-a", "+15550005555");
    await removeGroupMemberSignal("group-a", "uuid:123e4567-e89b-12d3-a456-426614174001");

    expect(rpcMock).toHaveBeenNthCalledWith(
      1,
      "updateGroup",
      expect.any(Object),
      expect.any(Object),
    );
    expect(rpcMock.mock.calls[0]?.[1]).toMatchObject({
      groupId: "group-a",
      addMembers: ["+15550005555"],
    });
    expect(rpcMock).toHaveBeenNthCalledWith(
      2,
      "updateGroup",
      expect.any(Object),
      expect.any(Object),
    );
    expect(rpcMock.mock.calls[1]?.[1]).toMatchObject({
      groupId: "group-a",
      removeMembers: ["123e4567-e89b-12d3-a456-426614174001"],
    });
  });

  it("joins and quits groups", async () => {
    await joinGroupSignal("https://signal.group/#CjQ...");
    await quitGroupSignal("signal:group:group-a");

    expect(rpcMock).toHaveBeenNthCalledWith(1, "joinGroup", expect.any(Object), expect.any(Object));
    expect(rpcMock.mock.calls[0]?.[1]).toMatchObject({
      uri: "https://signal.group/#CjQ...",
    });
    expect(rpcMock).toHaveBeenNthCalledWith(2, "quitGroup", expect.any(Object), expect.any(Object));
    expect(rpcMock.mock.calls[1]?.[1]).toMatchObject({
      groupId: "group-a",
    });
  });
});
