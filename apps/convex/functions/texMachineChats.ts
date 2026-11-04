/**
 * A person's own computer lent to a Tex group chat they are in
 * (docs/decisions/texting-assistant/machines.md). A group's grant reaches only
 * its shared workspace, so a computer in its owner's personal workspace is
 * reached through this lending: only its own owner lends it, only while they
 * are one of the chat's people, and revoking the computer takes every lending
 * with it (`revokeMachineAs`).
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { internalMutation } from "./lib/rowWatch/mutations";
import { CHAT_GROUP_KEY_PATTERN, TEX_MACHINE_CHAT_LIMIT } from "./lib/texMachineRules";
import { texMachineRefusal } from "./texMachines";
import { handleFor } from "./texPage";

/** The chat's people, or `null` when no chat has this key. A key that is not even well formed names no chat. */
async function chatPeopleFor(ctx: QueryCtx, groupKey: string): Promise<Id<"users">[] | null> {
  if (!CHAT_GROUP_KEY_PATTERN.test(groupKey)) return null;
  const chat = await ctx.db
    .query("textGroups")
    .withIndex("by_key", (q) => q.eq("groupKey", groupKey))
    .unique();
  if (chat === null) return null;
  return chat.homeUsers ?? [];
}

/**
 * Lend a machine to a chat. Only the machine's owner may, and only when the owner is one of the chat's people. Lending
 * the same machine to the same chat again returns the existing row unchanged.
 */
async function attachMachineToChat(
  ctx: MutationCtx,
  args: { userId: Id<"users">; machineId: Id<"texMachines">; groupKey: string },
): Promise<{ attached: true; workspaceId: Id<"workspaces"> }> {
  const machine = await ctx.db.get(args.machineId);
  if (machine === null || machine.status !== "active" || machine.ownerId !== args.userId) {
    throw texMachineRefusal("MACHINE_NOT_FOUND");
  }
  const people = await chatPeopleFor(ctx, args.groupKey);
  if (people === null || !people.includes(args.userId)) throw texMachineRefusal("CHAT_NOT_FOUND");

  const lentHere = await ctx.db
    .query("texMachineChats")
    .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
    .collect();
  if (lentHere.some((row) => row.groupKey === args.groupKey)) {
    return { attached: true, workspaceId: machine.workspaceId };
  }
  const attachedToChat = await ctx.db
    .query("texMachineChats")
    .withIndex("by_group", (q) => q.eq("groupKey", args.groupKey))
    .take(TEX_MACHINE_CHAT_LIMIT);
  if (attachedToChat.length >= TEX_MACHINE_CHAT_LIMIT) throw texMachineRefusal("TOO_MANY_MACHINES");

  await ctx.db.insert("texMachineChats", {
    groupKey: args.groupKey,
    machineId: machine._id,
    workspaceId: machine.workspaceId,
    ownerId: args.userId,
    createdAt: Date.now(),
  });
  await recordAudit(ctx, {
    workspaceId: machine.workspaceId,
    actorUserId: args.userId,
    action: "tex_machine.attached",
    details: { os: machine.os },
  });
  return { attached: true, workspaceId: machine.workspaceId };
}

/** Take a machine back out of a chat. Only the machine's owner may. Idempotent: a chat it is not in detaches nothing. */
async function detachMachineFromChat(
  ctx: MutationCtx,
  args: { userId: Id<"users">; machineId: Id<"texMachines">; groupKey: string },
): Promise<{ detached: boolean }> {
  const machine = await ctx.db.get(args.machineId);
  if (machine === null || machine.ownerId !== args.userId) throw texMachineRefusal("MACHINE_NOT_FOUND");
  const rows = await ctx.db
    .query("texMachineChats")
    .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
    .collect();
  const matching = rows.filter((row) => row.groupKey === args.groupKey);
  for (const row of matching) await ctx.db.delete(row._id);
  if (matching.length === 0) return { detached: false };
  await recordAudit(ctx, {
    workspaceId: machine.workspaceId,
    actorUserId: args.userId,
    action: "tex_machine.detached",
    details: { os: machine.os },
  });
  return { detached: true };
}

export const attachTexMachineToChat = internalMutation({
  args: { userId: v.id("users"), machineId: v.id("texMachines"), groupKey: v.string() },
  returns: v.object({ attached: v.literal(true), workspaceId: v.id("workspaces") }),
  handler: async (ctx, args): Promise<{ attached: true; workspaceId: Id<"workspaces"> }> => {
    return await attachMachineToChat(ctx, args);
  },
});

export const detachTexMachineFromChat = internalMutation({
  args: { userId: v.id("users"), machineId: v.id("texMachines"), groupKey: v.string() },
  returns: v.object({ detached: v.boolean() }),
  handler: async (ctx, args): Promise<{ detached: boolean }> => {
    return await detachMachineFromChat(ctx, args);
  },
});

/** The gateway's attach, for ids it passes as text: a malformed id is the same refusal as an unknown one. */
export const attachTexMachineToChatAs = internalMutation({
  args: { userId: v.string(), machineId: v.string(), groupKey: v.string() },
  handler: async (ctx, args): Promise<{ attached: true; workspaceId: Id<"workspaces"> }> => {
    const userId = ctx.db.normalizeId("users", args.userId);
    const machineId = ctx.db.normalizeId("texMachines", args.machineId);
    if (userId === null || machineId === null) throw texMachineRefusal("MACHINE_NOT_FOUND");
    return await attachMachineToChat(ctx, { userId, machineId, groupKey: args.groupKey });
  },
});

/** The gateway's detach, for ids it passes as text. */
export const detachTexMachineFromChatAs = internalMutation({
  args: { userId: v.string(), machineId: v.string(), groupKey: v.string() },
  handler: async (ctx, args): Promise<{ detached: boolean }> => {
    const userId = ctx.db.normalizeId("users", args.userId);
    const machineId = ctx.db.normalizeId("texMachines", args.machineId);
    if (userId === null || machineId === null) throw texMachineRefusal("MACHINE_NOT_FOUND");
    return await detachMachineFromChat(ctx, { userId, machineId, groupKey: args.groupKey });
  },
});

/**
 * The machines a chat may run jobs on: each lent machine that is still active, whose owner is still one of the chat's
 * people. Empty for a chat that does not exist. Never the grant's hash.
 */
export const texMachinesForChat = internalQuery({
  args: { groupKey: v.string() },
  returns: v.array(
    v.object({ machineId: v.id("texMachines"), workspaceId: v.id("workspaces"), ownerId: v.id("users") }),
  ),
  handler: async (ctx, args) => {
    const people = await chatPeopleFor(ctx, args.groupKey);
    if (people === null) return [];
    const rows = await ctx.db
      .query("texMachineChats")
      .withIndex("by_group", (q) => q.eq("groupKey", args.groupKey))
      .take(TEX_MACHINE_CHAT_LIMIT);
    const lent: { machineId: Id<"texMachines">; workspaceId: Id<"workspaces">; ownerId: Id<"users"> }[] = [];
    for (const row of rows) {
      const machine = await ctx.db.get(row.machineId);
      if (machine === null || machine.status !== "active" || !people.includes(machine.ownerId)) continue;
      lent.push({ machineId: machine._id, workspaceId: machine.workspaceId, ownerId: machine.ownerId });
    }
    return lent;
  },
});

/**
 * The people of a chat, with their ids and handles, for its own member choosing who may use their computer there
 * ("Ava and Bo, not the rest"): a rule names people by id. Null unless `userId` is one of the chat's people.
 */
export const chatPeopleAs = internalQuery({
  args: { userId: v.string(), groupKey: v.string() },
  handler: async (ctx, args): Promise<{ userId: Id<"users">; handle: string }[] | null> => {
    const userId = ctx.db.normalizeId("users", args.userId);
    if (userId === null) return null;
    const people = await chatPeopleFor(ctx, args.groupKey);
    if (people === null || !people.includes(userId)) return null;
    return await Promise.all(people.slice(0, 64).map(async (id) => ({ userId: id, handle: await handleFor(ctx, id) })));
  },
});
