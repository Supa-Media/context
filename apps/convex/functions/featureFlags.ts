/**
 * The staff console's Features tab: each feature flag's mode (off, a list, everyone), the people and tester groups
 * on its list, and the tester groups themselves (decided by the owner, 2026-11-08;
 * `docs/decisions/app-and-console/feature-flags.md`). Every function but `myFlags` is staff only and every change is
 * audited. The ids, with their expiry dates, are `packages/shared/src/flags.cjs`; reading a flag is
 * `lib/featureFlags.ts`.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { mutation } from "./lib/rowWatch/mutations";
import { requireAdmin, type AdminActor } from "./lib/admin";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { toConvexError } from "./lib/adminFns/errors";
import { getAuthUserId } from "./lib/signedIn";
import { FLAGS, FLAG_DUE_DAYS, daysLeft, isFlagId, todayOf } from "@context/shared/src/flags.cjs";
import { flagIds, flagsFor } from "./lib/featureFlags";
import { describePerson, personNamed } from "./lib/featureFlagPeople";

const modeValidator = v.union(v.literal("off"), v.literal("people"), v.literal("everyone"));
const personValidator = v.object({ userId: v.id("users"), name: v.string() });
const groupRef = v.object({ groupId: v.id("testerGroups"), name: v.string(), size: v.number() });


async function staff(ctx: QueryCtx): Promise<AdminActor> {
  try {
    return await requireAdmin(ctx);
  } catch (error) {
    throw toConvexError(error);
  }
}

function refuse(message: string): never {
  throw new ConvexError({ code: "INVALID_ARGUMENT", message });
}

/**
 * Write the change into the person objects it touches, at once (`functions/flagObjects.ts`): these people, or every
 * switched person when a flag goes to or from everyone. The hourly reconcile catches any push that fails.
 */
async function pushTo(ctx: MutationCtx, who: Id<"users">[] | "everyone"): Promise<void> {
  if (who === "everyone") await ctx.scheduler.runAfter(0, internal.functions.flagObjects.reconcile, { all: true });
  else if (who.length > 0) await ctx.scheduler.runAfter(0, internal.functions.flagObjects.pushPeople, { userIds: [...new Set(who)] });
}

/** Everyone on a flag's list, by name or through a group. */
async function listedOn(ctx: QueryCtx, flagId: string): Promise<Id<"users">[]> {
  const ids: Id<"users">[] = [];
  for (const row of await ctx.db.query("featureFlagPeople").withIndex("by_flag", (q) => q.eq("flagId", flagId)).collect()) ids.push(row.userId);
  for (const link of await ctx.db.query("featureFlagGroups").withIndex("by_flag", (q) => q.eq("flagId", flagId)).collect()) ids.push(...(await membersOf(ctx, link.groupId)));
  return ids;
}

async function membersOf(ctx: QueryCtx, groupId: Id<"testerGroups">): Promise<Id<"users">[]> {
  return (await ctx.db.query("testerGroupPeople").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect()).map((row) => row.userId);
}

function knownFlag(flagId: string): void {
  if (!isFlagId(flagId)) refuse("There is no such flag.");
}


/** Every flag on the list with its mode, expiry and list; every tester group; and ids with rows but no flag. */
export const listFlags = query({
  args: {},
  returns: v.object({
    today: v.string(),
    flags: v.array(
      v.object({
        id: v.string(),
        label: v.string(),
        description: v.string(),
        added: v.string(),
        expires: v.string(),
        daysLeft: v.number(),
        due: v.boolean(),
        mode: modeValidator,
        updatedAt: v.union(v.number(), v.null()),
        people: v.array(personValidator),
        groups: v.array(groupRef),
      }),
    ),
    groups: v.array(v.object({ groupId: v.id("testerGroups"), name: v.string(), people: v.array(personValidator) })),
    retired: v.array(v.object({ id: v.string(), rows: v.number() })),
  }),
  handler: async (ctx) => {
    await staff(ctx);
    const today = todayOf();
    const modes = await ctx.db.query("featureFlags").collect();
    const named = await ctx.db.query("featureFlagPeople").collect();
    const linked = await ctx.db.query("featureFlagGroups").collect();
    const groupRows = await ctx.db.query("testerGroups").collect();
    const groups = [];
    for (const group of groupRows.sort((a, b) => a.name.localeCompare(b.name))) {
      const members = await ctx.db.query("testerGroupPeople").withIndex("by_group", (q) => q.eq("groupId", group._id)).collect();
      groups.push({ groupId: group._id, name: group.name, people: await Promise.all(members.map((m) => describePerson(ctx, m.userId))) });
    }
    const flags = [];
    for (const id of flagIds()) {
      const flag = FLAGS[id]!;
      const row = modes.find((r) => r.flagId === id);
      const left = daysLeft(flag, today);
      flags.push({
        id,
        label: flag.label,
        description: flag.description,
        added: flag.added,
        expires: flag.expires,
        daysLeft: left,
        due: left <= FLAG_DUE_DAYS,
        mode: row?.mode ?? ("off" as const),
        updatedAt: row?.updatedAt ?? null,
        people: await Promise.all(named.filter((r) => r.flagId === id).map((r) => describePerson(ctx, r.userId))),
        groups: groups
          .filter((g) => linked.some((r) => r.flagId === id && r.groupId === g.groupId))
          .map((g) => ({ groupId: g.groupId, name: g.name, size: g.people.length })),
      });
    }
    const known = new Set(flagIds());
    const counts = new Map<string, number>();
    for (const r of [...modes, ...named, ...linked]) if (!known.has(r.flagId)) counts.set(r.flagId, (counts.get(r.flagId) ?? 0) + 1);
    return { today, flags, groups, retired: [...counts].sort().map(([id, rows]) => ({ id, rows })) };
  },
});

/** Set one flag's mode. */
export const setFlagMode = mutation({
  args: { flagId: v.string(), mode: modeValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    knownFlag(args.flagId);
    const row = await ctx.db.query("featureFlags").withIndex("by_flag", (q) => q.eq("flagId", args.flagId)).first();
    const was = row?.mode ?? "off";
    const fields = { mode: args.mode, updatedAt: Date.now(), updatedBy: actor.userId };
    if (row === null) await ctx.db.insert("featureFlags", { flagId: args.flagId, ...fields });
    else await ctx.db.patch(row._id, fields);
    await recordAdminAudit(ctx, actor, "flag.mode_set", args.flagId, { mode: args.mode });
    if (was !== args.mode) await pushTo(ctx, was === "everyone" || args.mode === "everyone" ? "everyone" : await listedOn(ctx, args.flagId));
    return null;
  },
});

/** Put a person on a flag's list, by handle, email or phone. */
export const addFlagPerson = mutation({
  args: { flagId: v.string(), who: v.string() },
  returns: personValidator,
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    knownFlag(args.flagId);
    const userId = (await personNamed(ctx, args.who)) ?? refuse("Nobody has that handle, email or phone.");
    const held = await ctx.db
      .query("featureFlagPeople")
      .withIndex("by_flag_user", (q) => q.eq("flagId", args.flagId).eq("userId", userId))
      .first();
    if (held === null) {
      await ctx.db.insert("featureFlagPeople", { flagId: args.flagId, userId, addedAt: Date.now(), addedBy: actor.userId });
      await recordAdminAudit(ctx, actor, "flag.person_added", args.flagId);
      await pushTo(ctx, [userId]);
    }
    return await describePerson(ctx, userId);
  },
});

export const removeFlagPerson = mutation({
  args: { flagId: v.string(), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    const rows = await ctx.db
      .query("featureFlagPeople")
      .withIndex("by_flag_user", (q) => q.eq("flagId", args.flagId).eq("userId", args.userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length > 0) {
      await recordAdminAudit(ctx, actor, "flag.person_removed", args.flagId);
      await pushTo(ctx, [args.userId]);
    }
    return null;
  },
});

/** Put a tester group on a flag's list. */
export const addFlagGroup = mutation({
  args: { flagId: v.string(), groupId: v.id("testerGroups") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    knownFlag(args.flagId);
    const group = (await ctx.db.get(args.groupId)) ?? refuse("There is no such group.");
    const held = await ctx.db
      .query("featureFlagGroups")
      .withIndex("by_flag_group", (q) => q.eq("flagId", args.flagId).eq("groupId", args.groupId))
      .first();
    if (held === null) {
      await ctx.db.insert("featureFlagGroups", { flagId: args.flagId, groupId: args.groupId, addedAt: Date.now(), addedBy: actor.userId });
      await recordAdminAudit(ctx, actor, "flag.group_added", args.flagId, { group: group.name });
      await pushTo(ctx, await membersOf(ctx, args.groupId));
    }
    return null;
  },
});

export const removeFlagGroup = mutation({
  args: { flagId: v.string(), groupId: v.id("testerGroups") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    const rows = await ctx.db
      .query("featureFlagGroups")
      .withIndex("by_flag_group", (q) => q.eq("flagId", args.flagId).eq("groupId", args.groupId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length > 0) {
      await recordAdminAudit(ctx, actor, "flag.group_removed", args.flagId);
      await pushTo(ctx, await membersOf(ctx, args.groupId));
    }
    return null;
  },
});

/** Make a tester group. Names are unique, ignoring case and spaces at the ends. */
export const createTesterGroup = mutation({
  args: { name: v.string() },
  returns: v.id("testerGroups"),
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    const name = args.name.trim().replace(/\s+/g, " ");
    if (name === "" || name.length > 60) refuse("A group's name is 1 to 60 characters.");
    for (const group of await ctx.db.query("testerGroups").collect()) {
      if (group.name.toLowerCase() === name.toLowerCase()) refuse("There is already a group with that name.");
    }
    const groupId = await ctx.db.insert("testerGroups", { name, createdAt: Date.now(), createdBy: actor.userId });
    await recordAdminAudit(ctx, actor, "group.created", name);
    return groupId;
  },
});

/** Delete a tester group, its people and its place on every flag's list. */
export const deleteTesterGroup = mutation({
  args: { groupId: v.id("testerGroups") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    const group = await ctx.db.get(args.groupId);
    if (group === null) return null;
    const members = await membersOf(ctx, args.groupId);
    await removeGroupRows(ctx, args.groupId);
    await ctx.db.delete(args.groupId);
    await recordAdminAudit(ctx, actor, "group.deleted", group.name);
    await pushTo(ctx, members);
    return null;
  },
});

async function removeGroupRows(ctx: MutationCtx, groupId: Id<"testerGroups">): Promise<void> {
  for (const row of await ctx.db.query("testerGroupPeople").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect()) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("featureFlagGroups").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect()) await ctx.db.delete(row._id);
}

/** Put a person in a tester group, by handle, email or phone. */
export const addGroupPerson = mutation({
  args: { groupId: v.id("testerGroups"), who: v.string() },
  returns: personValidator,
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    const group = (await ctx.db.get(args.groupId)) ?? refuse("There is no such group.");
    const userId = (await personNamed(ctx, args.who)) ?? refuse("Nobody has that handle, email or phone.");
    const held = await ctx.db
      .query("testerGroupPeople")
      .withIndex("by_group_user", (q) => q.eq("groupId", args.groupId).eq("userId", userId))
      .first();
    if (held === null) {
      await ctx.db.insert("testerGroupPeople", { groupId: args.groupId, userId, addedAt: Date.now(), addedBy: actor.userId });
      await recordAdminAudit(ctx, actor, "group.person_added", group.name);
      await pushTo(ctx, [userId]);
    }
    return await describePerson(ctx, userId);
  },
});

export const removeGroupPerson = mutation({
  args: { groupId: v.id("testerGroups"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    const group = await ctx.db.get(args.groupId);
    const rows = await ctx.db
      .query("testerGroupPeople")
      .withIndex("by_group_user", (q) => q.eq("groupId", args.groupId).eq("userId", args.userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length > 0) {
      await recordAdminAudit(ctx, actor, "group.person_removed", group?.name ?? "deleted group");
      await pushTo(ctx, [args.userId]);
    }
    return null;
  },
});

/** Delete every row of an id no longer on the list: a flag launched or removed in code. */
export const clearRetiredFlag = mutation({
  args: { flagId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const actor = await staff(ctx);
    if (isFlagId(args.flagId)) refuse("That flag is still on the list. Launch or remove it in code first.");
    let cleared = 0;
    for (const table of ["featureFlags", "featureFlagPeople", "featureFlagGroups"] as const) {
      for (const row of await ctx.db.query(table).withIndex("by_flag", (q) => q.eq("flagId", args.flagId)).collect()) {
        await ctx.db.delete(row._id);
        cleared += 1;
      }
    }
    await recordAdminAudit(ctx, actor, "flag.cleared", args.flagId, { rows: cleared });
    return cleared;
  },
});

/** The signed-in person's flags, for the app (`useFlag`). Nobody signed in has none. */
export const myFlags = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return userId === null ? [] : await flagsFor(ctx, userId);
  },
});

