/**
 * Tex machines lent to group chats: the machine's owner attaches it to a chat its own person is in, the chat's people
 * may run jobs on it, and it stops when its owner leaves the chat, revokes it, or its workspace is deleted
 * (`docs/decisions/texting-assistant/machines.md`). Every value here is fake, and the repository is public.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import {
  type TestConvex,
  addMember,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  setupTest,
} from "./fixtures.helpers";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const GRANT = `tmg_${"x".repeat(40)}`;

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

/** A machine row, as a claim or a register would leave it: active, owned by `ownerId`, in `workspaceId`. */
async function insertMachine(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  ownerId: Id<"users">,
  name = "a-laptop",
): Promise<Id<"texMachines">> {
  const hashedGrant = await hashToken(`${GRANT}-${name}-${ownerId}-${workspaceId}`);
  return await t.run((ctx) =>
    ctx.db.insert("texMachines", {
      workspaceId,
      ownerId,
      name,
      os: "macos",
      publicKey: "A".repeat(43),
      hashedGrant,
      status: "active",
      createdAt: Date.now(),
    }),
  );
}

/** A group chat with these people in it, as `textGroups` holds one. */
async function insertChat(t: TestConvex, groupKey: string, homeUsers: Id<"users">[]): Promise<void> {
  await t.run((ctx) => ctx.db.insert("textGroups", { groupKey, homeUsers, lastSeenAt: 1 }));
}

async function setHomeUsers(t: TestConvex, groupKey: string, homeUsers: Id<"users">[]): Promise<void> {
  await t.run(async (ctx) => {
    const chat = await ctx.db
      .query("textGroups")
      .withIndex("by_key", (q) => q.eq("groupKey", groupKey))
      .unique();
    await ctx.db.patch(chat!._id, { homeUsers });
  });
}

async function attach(t: TestConvex, userId: Id<"users">, machineId: Id<"texMachines">, groupKey = KEY_A) {
  return await t.mutation(internal.functions.texMachineChats.attachTexMachineToChat, { userId, machineId, groupKey });
}

async function detach(t: TestConvex, userId: Id<"users">, machineId: Id<"texMachines">, groupKey = KEY_A) {
  return await t.mutation(internal.functions.texMachineChats.detachTexMachineFromChat, { userId, machineId, groupKey });
}

async function listed(t: TestConvex, groupKey = KEY_A) {
  return await t.query(internal.functions.texMachineChats.texMachinesForChat, { groupKey });
}

async function attachmentRows(t: TestConvex, machineId?: Id<"texMachines">) {
  return await t.run(async (ctx) => {
    if (machineId === undefined) return await ctx.db.query("texMachineChats").collect();
    return await ctx.db
      .query("texMachineChats")
      .withIndex("by_machine", (q) => q.eq("machineId", machineId))
      .collect();
  });
}

/**
 * Alice owns a personal workspace and a shared one, and her chat with bob and carol. Bob is an editor of the shared
 * workspace and owns a computer in it; alice is that workspace's owner, but not the computer's.
 */
async function aChat() {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const carol = await createUser(t, "carol@example.invalid");
  const alfa = await createWorkspace(t, alice, "alfa", { displayName: "Alice" });
  const team = await createWorkspace(t, alice, "household", { displayName: "Household", kind: "shared" });
  await addMember(t, team, bob, "editor", alice);
  await insertChat(t, KEY_A, [alice, bob, carol]);
  const aliceMachine = await insertMachine(t, alfa, alice);
  const bobMachine = await insertMachine(t, team, bob, "bob-desk");
  return { t, alice, bob, carol, alfa, team, aliceMachine, bobMachine };
}

describe("attaching a machine to a chat", () => {
  test("the owner attaches her computer, and the chat's people are lent it", async () => {
    const { t, alice, alfa, aliceMachine } = await aChat();
    const result = await attach(t, alice, aliceMachine);
    expect(result).toEqual({ attached: true, workspaceId: alfa });

    expect(await listed(t)).toEqual([{ machineId: aliceMachine, workspaceId: alfa, ownerId: alice }]);
  });

  test("the audit records the attach by its os, and never the chat's key", async () => {
    const { t, alice, aliceMachine } = await aChat();
    await attach(t, alice, aliceMachine);
    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const attached = events.filter((row) => row.action === "tex_machine.attached");
    expect(attached).toHaveLength(1);
    expect(attached[0].details).toEqual({ os: "macos" });
    expect(JSON.stringify(events)).not.toContain(KEY_A);
  });

  test("the workspace owner cannot attach a computer her member owns, and the refusal says only not found", async () => {
    const { t, alice, bobMachine } = await aChat();
    const error = await captureError(() => attach(t, alice, bobMachine));
    expect(errorCode(error)).toBe("MACHINE_NOT_FOUND");
    expect(await attachmentRows(t)).toHaveLength(0);
  });

  test("an editor cannot attach a computer someone else owns", async () => {
    const { t, bob, aliceMachine } = await aChat();
    const error = await captureError(() => attach(t, bob, aliceMachine));
    expect(errorCode(error)).toBe("MACHINE_NOT_FOUND");
    expect(await attachmentRows(t)).toHaveLength(0);
  });

  test("someone who is not in the chat cannot attach, even to their own computer", async () => {
    const { t, alice, bob, alfa } = await aChat();
    const outsider = await createUser(t, "outsider@example.invalid");
    const outsiderMachine = await insertMachine(t, alfa, outsider);
    expect(errorCode(await captureError(() => attach(t, outsider, outsiderMachine)))).toBe("CHAT_NOT_FOUND");
    // The owner is not in this chat either: a chat with other people in it is not hers to lend into.
    await insertChat(t, KEY_B, [bob]);
    const aliceMachine = await insertMachine(t, alfa, alice, "second");
    expect(errorCode(await captureError(() => attach(t, alice, aliceMachine, KEY_B)))).toBe("CHAT_NOT_FOUND");
    expect(await attachmentRows(t)).toHaveLength(0);
  });

  test("an unknown chat and a key that is not well formed are both chat not found", async () => {
    const { t, alice, aliceMachine } = await aChat();
    expect(errorCode(await captureError(() => attach(t, alice, aliceMachine, "c".repeat(64))))).toBe("CHAT_NOT_FOUND");
    expect(errorCode(await captureError(() => attach(t, alice, aliceMachine, "NOT-A-KEY")))).toBe("CHAT_NOT_FOUND");
    expect(errorCode(await captureError(() => attach(t, alice, aliceMachine, KEY_A.toUpperCase())))).toBe("CHAT_NOT_FOUND");
  });

  test("a revoked machine cannot be attached", async () => {
    const { t, alice, aliceMachine } = await aChat();
    await t.run((ctx) => ctx.db.patch(aliceMachine, { status: "revoked", revokedAt: Date.now() }));
    expect(errorCode(await captureError(() => attach(t, alice, aliceMachine)))).toBe("MACHINE_NOT_FOUND");
  });

  test("attaching the same machine to the same chat again returns the row unchanged, and audits once", async () => {
    const { t, alice, alfa, aliceMachine } = await aChat();
    const first = await attach(t, alice, aliceMachine);
    const second = await attach(t, alice, aliceMachine);
    expect(second).toEqual(first);
    expect(second).toEqual({ attached: true, workspaceId: alfa });
    expect(await attachmentRows(t, aliceMachine)).toHaveLength(1);
    const events = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(events.filter((row) => row.action === "tex_machine.attached")).toHaveLength(1);
  });

  test("a chat holds at most ten machines: the eleventh is refused, and one already there re-attaches", async () => {
    const { t, alice, alfa } = await aChat();
    const machines: Id<"texMachines">[] = [];
    for (let i = 0; i < 11; i += 1) machines.push(await insertMachine(t, alfa, alice, `laptop-${i}`));
    for (const machineId of machines.slice(0, 10)) await attach(t, alice, machineId);

    expect(errorCode(await captureError(() => attach(t, alice, machines[10])))).toBe("TOO_MANY_MACHINES");
    expect(await listed(t)).toHaveLength(10);
    // A machine already in the chat is not a new one, so it is not refused at the cap.
    await expect(attach(t, alice, machines[0])).resolves.toEqual({ attached: true, workspaceId: alfa });
  });
});

describe("detaching a machine from a chat", () => {
  test("only the owner detaches, and a second detach finds nothing", async () => {
    const { t, alice, bob, aliceMachine } = await aChat();
    await attach(t, alice, aliceMachine);

    expect(errorCode(await captureError(() => detach(t, bob, aliceMachine)))).toBe("MACHINE_NOT_FOUND");
    expect(await listed(t)).toHaveLength(1);

    expect(await detach(t, alice, aliceMachine)).toEqual({ detached: true });
    expect(await listed(t)).toEqual([]);
    expect(await detach(t, alice, aliceMachine)).toEqual({ detached: false });
  });

  test("detaching from one chat leaves the machine's attachment to another chat", async () => {
    const { t, alice, bob, carol, alfa, aliceMachine } = await aChat();
    await insertChat(t, KEY_B, [alice, bob, carol]);
    await attach(t, alice, aliceMachine, KEY_A);
    await attach(t, alice, aliceMachine, KEY_B);

    expect(await detach(t, alice, aliceMachine, KEY_A)).toEqual({ detached: true });
    expect(await listed(t, KEY_A)).toEqual([]);
    expect(await listed(t, KEY_B)).toEqual([{ machineId: aliceMachine, workspaceId: alfa, ownerId: alice }]);
  });
});

describe("listing a chat's machines", () => {
  test("an unknown chat lists nothing", async () => {
    const { t } = await aChat();
    expect(await listed(t, "d".repeat(64))).toEqual([]);
    expect(await listed(t, "not-a-key")).toEqual([]);
  });

  test("a revoked machine is not listed, and revoking it deletes its attachments", async () => {
    const { t, alice, aliceMachine } = await aChat();
    await attach(t, alice, aliceMachine);
    const revoked = await gatewayPost(t, "/gateway/machines/revoke", { machineId: aliceMachine, userId: alice });
    expect(revoked.status).toBe(200);

    expect(await listed(t)).toEqual([]);
    expect(await attachmentRows(t, aliceMachine)).toHaveLength(0);
  });

  test("an owner who leaves the chat stops lending her computer, and her attachment waits for her return", async () => {
    const { t, alice, bob, carol, aliceMachine } = await aChat();
    await attach(t, alice, aliceMachine);

    await setHomeUsers(t, KEY_A, [bob, carol]);
    expect(await listed(t)).toEqual([]);
    expect(await attachmentRows(t, aliceMachine)).toHaveLength(1);

    await setHomeUsers(t, KEY_A, [alice, bob, carol]);
    expect(await listed(t)).toHaveLength(1);
  });

  test("the workspace's deletion takes its machines' attachments with it", async () => {
    const { t, team, bob } = await aChat();
    const teamMachine = await insertMachine(t, team, bob, "household-desk");
    await attach(t, bob, teamMachine);
    expect(await attachmentRows(t, teamMachine)).toHaveLength(1);

    const { finalizeWorkspaceDeletion } = await import("../functions/lib/account/finalizeWorkspaceDeletion");
    await t.run(async (ctx) => await finalizeWorkspaceDeletion(ctx, team));
    expect(await attachmentRows(t)).toHaveLength(0);
  });
});

describe("the gateway's chat routes", () => {
  test("attach, list and detach answer with the functions' shapes", async () => {
    const { t, alice, alfa, aliceMachine } = await aChat();
    const attached = await gatewayPost(t, "/gateway/machines/chat/attach", {
      userId: alice,
      machineId: aliceMachine,
      groupKey: KEY_A,
    });
    expect(attached.status).toBe(200);
    expect(await json(attached)).toEqual({ attached: true, workspaceId: alfa });

    const forChat = await gatewayPost(t, "/gateway/machines/for-chat", { groupKey: KEY_A });
    expect(forChat.status).toBe(200);
    expect(await json(forChat)).toEqual({
      machines: [{ machineId: aliceMachine, workspaceId: alfa, ownerId: alice }],
    });

    const detached = await gatewayPost(t, "/gateway/machines/chat/detach", {
      userId: alice,
      machineId: aliceMachine,
      groupKey: KEY_A,
    });
    expect(await json(detached)).toEqual({ detached: true });
  });

  test("a malformed id is the same 404 as an unknown one, and an unknown chat lists nothing", async () => {
    const { t, alice, aliceMachine } = await aChat();
    const malformed = await gatewayPost(t, "/gateway/machines/chat/attach", {
      userId: alice,
      machineId: "not-a-machine",
      groupKey: KEY_A,
    });
    expect(malformed.status).toBe(404);
    expect((await json(malformed)).code).toBe("MACHINE_NOT_FOUND");

    const badUser = await gatewayPost(t, "/gateway/machines/chat/attach", {
      userId: "not-a-user",
      machineId: aliceMachine,
      groupKey: KEY_A,
    });
    expect(badUser.status).toBe(404);
    expect((await json(badUser)).code).toBe("MACHINE_NOT_FOUND");

    const unknownChat = await gatewayPost(t, "/gateway/machines/chat/attach", {
      userId: alice,
      machineId: aliceMachine,
      groupKey: "e".repeat(64),
    });
    expect(unknownChat.status).toBe(404);
    expect((await json(unknownChat)).code).toBe("CHAT_NOT_FOUND");

    const nothing = await gatewayPost(t, "/gateway/machines/for-chat", { groupKey: "e".repeat(64) });
    expect(await json(nothing)).toEqual({ machines: [] });
  });

  test("a chat at its cap answers 409 TOO_MANY_MACHINES, and a missing field is a bad request", async () => {
    const { t, alice, alfa } = await aChat();
    for (let i = 0; i < 10; i += 1) {
      const machineId = await insertMachine(t, alfa, alice, `cap-${i}`);
      await attach(t, alice, machineId);
    }
    const extra = await insertMachine(t, alfa, alice, "one-too-many");
    const refused = await gatewayPost(t, "/gateway/machines/chat/attach", { userId: alice, machineId: extra, groupKey: KEY_A });
    expect(refused.status).toBe(409);
    expect((await json(refused)).code).toBe("TOO_MANY_MACHINES");

    const incomplete = await gatewayPost(t, "/gateway/machines/chat/attach", { userId: alice, machineId: extra });
    expect(incomplete.status).toBe(400);
    const noKey = await gatewayPost(t, "/gateway/machines/for-chat", {});
    expect(noKey.status).toBe(400);
  });
});

describe("a chat's people, for choosing who may use a computer there", () => {
  test("one of the chat's people gets everyone in it with their ids and handles", async () => {
    const { t, alice, bob, carol } = await aChat();
    const answer = await gatewayPost(t, "/gateway/machines/chat/people", { userId: alice, groupKey: KEY_A });
    expect(answer.status).toBe(200);
    const { people } = (await json(answer)) as { people: { userId: string; handle: string }[] };
    expect(people.map((person) => person.userId).sort()).toEqual([alice, bob, carol].sort());
    expect(people.find((person) => person.userId === alice)?.handle).toBe("alfa");
  });

  test("anyone not in the chat learns nothing, the same as for a chat that doesn't exist", async () => {
    const { t, alfa } = await aChat();
    const dave = await createUser(t, "dave@example.invalid");
    const outsider = await gatewayPost(t, "/gateway/machines/chat/people", { userId: dave, groupKey: KEY_A });
    const nowhere = await gatewayPost(t, "/gateway/machines/chat/people", { userId: dave, groupKey: "e".repeat(64) });
    expect(outsider.status).toBe(404);
    expect(await json(outsider)).toEqual(await json(nowhere));
    expect((await gatewayPost(t, "/gateway/machines/chat/people", { userId: alfa, groupKey: KEY_A })).status).toBe(404);
  });
});
