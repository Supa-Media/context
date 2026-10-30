/**
 * The people half of vault sharing (the vault sharing boards, 2026-10-17):
 * who a key can be given to in a workspace, the names its people, groups and
 * AIs are shown by, and the `@names` each person reaches, which decide a key
 * given to a group. Reads of the control plane only; no key is opened here.
 *
 * The `@names` are the same set the gateway checks a grant against
 * (`grantedNamesFor`, carried on a session as `grantedGroups`), so a key given
 * to a group reaches exactly the people a note pointed at that group does.
 */

import { getAuthUserId } from "./lib/signedIn";
import { v } from "convex/values";
import { internalQuery, query, type QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { MAX_GROUPS_PER_WORKSPACE, resolveGroupMembers } from "./groups";
import { grantedNamesFor } from "./lib/grantedNames";
import { groupLabelOf } from "./lib/names";
import { getMembership } from "./lib/workspaceAuth";
import { MAX_MEMBERS_RETURNED } from "./lib/workspaces/constants";

const roleValidator = v.union(v.literal("owner"), v.literal("editor"), v.literal("member"));

async function membersOf(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_MEMBERS_RETURNED);
}

async function handleOf(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const row = await ctx.db
    .query("names")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return row?.name ?? null;
}

/** A person as the vault shows them: their name, else their handle, else the start of their email. */
async function personOf(ctx: QueryCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  const handle = await handleOf(ctx, userId);
  const email = typeof user?.email === "string" ? user.email : null;
  const name = (typeof user?.name === "string" && user.name.trim()) || handle || (email ? email.split("@")[0] : "Someone");
  return { name, handle };
}

/** The `@names` one person reaches in one workspace, with the `@`. */
export const accessNames = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.array(v.string()),
  handler: async (ctx, args) => (await grantedNamesFor(ctx, args.workspaceId, args.userId)).map((name) => `@${name}`),
});

/** Every member's `@names`, for working out who still has a key after it is taken back. */
export const everyonesAccessNames = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.record(v.string(), v.array(v.string())),
  handler: async (ctx, args) => {
    const out: Record<string, string[]> = {};
    for (const member of await membersOf(ctx, args.workspaceId)) {
      out[String(member.userId)] = (await grantedNamesFor(ctx, args.workspaceId, member.userId)).map((name) => `@${name}`);
    }
    return out;
  },
});

/** Whether `userId` is a member, and whether `group` (`@name`) is one of this workspace's groups. */
export const shareTarget = internalQuery({
  args: { workspaceId: v.id("workspaces"), to: v.string() },
  returns: v.union(v.literal("person"), v.literal("group"), v.literal("everyone"), v.null()),
  handler: async (ctx, args) => {
    if (args.to === "*") return "everyone";
    if (args.to.startsWith("@")) {
      const group = await ctx.db
        .query("workspaceGroups")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .take(MAX_GROUPS_PER_WORKSPACE);
      return group.some((row) => `@${row.name}` === args.to) ? "group" : null;
    }
    const userId = ctx.db.normalizeId("users", args.to);
    if (userId === null) return null;
    return (await getMembership(ctx, args.workspaceId, userId)) === null ? null : "person";
  },
});

const labelsValidator = v.object({
  people: v.record(v.string(), v.object({ name: v.string(), handle: v.union(v.string(), v.null()) })),
  groups: v.record(v.string(), v.object({ label: v.string(), count: v.number() })),
  members: v.number(),
});
export type VaultLabels = typeof labelsValidator.type;

/** The names a key's people, groups and AIs' people are shown by, and how many people the workspace has. */
export const labels = internalQuery({
  args: { workspaceId: v.id("workspaces"), userIds: v.array(v.string()), groups: v.array(v.string()) },
  returns: labelsValidator,
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    const people: VaultLabels["people"] = {};
    for (const raw of [...new Set(args.userIds)].slice(0, 400)) {
      const userId = ctx.db.normalizeId("users", raw);
      if (userId !== null) people[raw] = await personOf(ctx, userId);
    }
    const groups: VaultLabels["groups"] = {};
    if (args.groups.length > 0) {
      const rows = await ctx.db
        .query("workspaceGroups")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .take(MAX_GROUPS_PER_WORKSPACE);
      for (const row of rows) {
        if (!args.groups.includes(`@${row.name}`)) continue;
        const live = await resolveGroupMembers(ctx, args.workspaceId, row._id);
        groups[`@${row.name}`] = { label: groupLabelOf(workspace?.slug ?? "", row.name), count: live.length };
      }
    }
    return { people, groups, members: (await membersOf(ctx, args.workspaceId)).length };
  },
});

/**
 * Who the signed-in person can give a key to in this workspace: its members,
 * its groups (owners only, as groups are listed to owners only), and the
 * whole workspace. A personal workspace has nobody to give to.
 */
export const vaultShareChoices = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      workspace: v.object({ handle: v.string(), kind: v.union(v.literal("personal"), v.literal("shared")) }),
      people: v.array(
        v.object({ userId: v.string(), name: v.string(), handle: v.union(v.string(), v.null()), role: roleValidator, isMe: v.boolean() }),
      ),
      groups: v.array(v.object({ to: v.string(), label: v.string(), count: v.number() })),
      members: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const membership = await getMembership(ctx, args.workspaceId, userId);
    const workspace = await ctx.db.get(args.workspaceId);
    if (membership === null || workspace === null) return null;
    const members = await membersOf(ctx, args.workspaceId);
    const people = [];
    for (const member of members) {
      const person = await personOf(ctx, member.userId);
      people.push({ userId: String(member.userId), ...person, role: member.role, isMe: member.userId === userId });
    }
    const groups = [];
    if (membership.role === "owner") {
      const rows = await ctx.db
        .query("workspaceGroups")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .take(MAX_GROUPS_PER_WORKSPACE);
      for (const row of rows) {
        const live = await resolveGroupMembers(ctx, args.workspaceId, row._id);
        groups.push({ to: `@${row.name}`, label: groupLabelOf(workspace.slug, row.name), count: live.length });
      }
    }
    return {
      workspace: { handle: workspace.slug, kind: workspace.kind },
      people: people.sort((a, b) => a.name.localeCompare(b.name)),
      groups: groups.sort((a, b) => a.label.localeCompare(b.label)),
      members: members.length,
    };
  },
});

/** "personal" or "shared": only a shared workspace's keys can be given to anybody. */
export const workspaceKind = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.literal("personal"), v.literal("shared"), v.null()),
  handler: async (ctx, args) => (await ctx.db.get(args.workspaceId))?.kind ?? null,
});

/** A workspace's handle, without the `@`, for the move's audit lines. */
export const workspaceHandle = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => (await ctx.db.get(args.workspaceId))?.slug ?? null,
});
