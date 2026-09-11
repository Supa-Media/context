/**
 * Named sets of people, for a folder rule to point at.
 *
 * A privacy rule may name a group — `2-areas/feedback: @supa-leads` — and this
 * is the object behind that name. The split is the whole design and is worth
 * restating where it is implemented:
 *
 * **The manifest holds the reference; the control plane holds the fact.** A
 * name in a file travels with the bucket, stays legible on export, and means
 * nothing on its own. Who is actually in the group lives here, so removing
 * somebody from the workspace closes every folder they could reach at once,
 * without touching a single byte of the customer's storage.
 *
 * ## Two rules everything below is built on
 *
 * 1. **A membership row grants nothing by itself.** `resolveGroupMembers`
 *    intersects group rows with `workspaceMembers`, so a name left behind by
 *    somebody who left is inert. That is what lets the manifest keep a
 *    reference it has no way to check, and it is why a stale row is a tidiness
 *    problem rather than a hole.
 * 2. **The name is assembled, never accepted.** `buildGroupName` derives it
 *    from the workspace's own slug, so `@supa-*` belongs to `supa` structurally
 *    rather than by convention — in a namespace shared with every username,
 *    where `@kola` and `@supa-leads` are the same kind of token to the parser.
 *
 * ## Owner-only, in both directions
 *
 * Reading the groups is owner-only for the reason the note census is: a member
 * who could enumerate them could work out the shape of what is being kept from
 * them. Writing is owner-only because a group is an access control. Absent
 * rather than disabled at the edges — the rule `StorageActions` and
 * `MembersView` already follow.
 */

import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireAuthId } from "@supa-media/convex/auth";
import { requireWorkspaceRole } from "./lib/workspaceAuth";
import { buildGroupName, describeRejection, groupLabelOf } from "./lib/names";

/**
 * How many groups one workspace may hold.
 *
 * A ceiling rather than a policy: every folder rule naming a group is resolved
 * on the read path, so an unbounded list is an unbounded cost on somebody
 * else's request. Generous enough that no real workspace meets it, which is
 * what a ceiling should be.
 */
export const MAX_GROUPS_PER_WORKSPACE = 100;

/** How many people one group may name. Same reasoning as the ceiling above. */
export const MAX_MEMBERS_PER_GROUP = 500;

const groupValidator = v.object({
  groupId: v.id("workspaceGroups"),
  /** The full, slug-prefixed name, as `privacy.md` carries it after the `@`. */
  name: v.string(),
  /** The half a person typed, for showing beside the workspace. */
  label: v.string(),
  createdAt: v.number(),
  members: v.array(
    v.object({
      userId: v.id("users"),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      /**
       * Whether this person is still a member of the workspace.
       *
       * `false` is not an error and not a hole: the intersection means the row
       * reaches nothing. It is surfaced so the console can show it struck
       * through and say why, rather than leaving a name that looks live.
       */
      live: v.boolean(),
    }),
  ),
});

/**
 * The people a group actually reaches, intersected with live membership.
 *
 * **This is the only function that decides what a group means**, and every
 * reader goes through it. A row naming somebody who has left the workspace is
 * dropped here, which is what makes a stale name harmless — and what lets the
 * manifest carry a reference nothing in the bucket can validate.
 */
export async function resolveGroupMembers(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  groupId: Id<"workspaceGroups">,
): Promise<Id<"users">[]> {
  const named = await ctx.db
    .query("workspaceGroupMembers")
    .withIndex("by_group", (q) => q.eq("groupId", groupId))
    .take(MAX_MEMBERS_PER_GROUP);

  const live: Id<"users">[] = [];
  for (const row of named) {
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", workspaceId).eq("userId", row.userId),
      )
      .unique();
    if (membership !== null) live.push(row.userId);
  }
  return live;
}

async function groupOfWorkspace(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  groupId: Id<"workspaceGroups">,
): Promise<Doc<"workspaceGroups">> {
  const group = await ctx.db.get(groupId);
  // Byte-identical to "no such group" for a group in another workspace: the
  // idiom every workspace-scoped read here follows, so a caller cannot use a
  // refusal to learn that an id exists somewhere else.
  if (group === null || group.workspaceId !== workspaceId) {
    throw new Error("GROUP_NOT_FOUND");
  }
  return group;
}

export const listGroups = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(groupValidator),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    const groups = await ctx.db
      .query("workspaceGroups")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_GROUPS_PER_WORKSPACE);

    const rows = [];
    for (const group of groups) {
      const named = await ctx.db
        .query("workspaceGroupMembers")
        .withIndex("by_group", (q) => q.eq("groupId", group._id))
        .take(MAX_MEMBERS_PER_GROUP);
      const live = new Set(
        (await resolveGroupMembers(ctx, args.workspaceId, group._id)).map(String),
      );
      const members = [];
      for (const row of named) {
        const user = await ctx.db.get(row.userId);
        members.push({
          userId: row.userId,
          email: user?.email ?? undefined,
          name: user?.name ?? undefined,
          live: live.has(String(row.userId)),
        });
      }
      rows.push({
        groupId: group._id,
        name: group.name,
        label: groupLabelOf(workspace.slug, group.name),
        createdAt: group.createdAt,
        members,
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const createGroup = mutation({
  args: { workspaceId: v.id("workspaces"), label: v.string() },
  returns: v.object({ groupId: v.id("workspaceGroups"), name: v.string() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    const built = buildGroupName(workspace.slug, args.label);
    if (!built.ok) throw new Error(describeRejection(built.reason));

    // One lookup against the shared namespace, not two. A username, a workspace
    // slug and a group name are one kind of claim here precisely so this cannot
    // race — see the `names` table's own header.
    const taken = await ctx.db
      .query("names")
      .withIndex("by_name", (q) => q.eq("name", built.normalized))
      .unique();
    if (taken !== null) throw new Error("NAME_TAKEN");

    const existing = await ctx.db
      .query("workspaceGroups")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_GROUPS_PER_WORKSPACE);
    if (existing.length >= MAX_GROUPS_PER_WORKSPACE) throw new Error("TOO_MANY_GROUPS");

    const groupId = await ctx.db.insert("workspaceGroups", {
      workspaceId: args.workspaceId,
      name: built.normalized,
      createdBy: userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("names", {
      name: built.normalized,
      kind: "group",
      groupId,
      claimedBy: userId,
      claimedAt: Date.now(),
    });
    return { groupId, name: built.normalized };
  },
});

export const addGroupMember = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    groupId: v.id("workspaceGroups"),
    userId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");
    await groupOfWorkspace(ctx, args.workspaceId, args.groupId);

    // Only somebody already in the workspace may be named. Not a redundant
    // check against the intersection: naming a stranger would put a row in the
    // owner's list that reaches nothing and reads as though it does, and the
    // way to give somebody access is an invitation, which is audited.
    const membership = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("userId", args.userId),
      )
      .unique();
    if (membership === null) throw new Error("NOT_A_MEMBER");

    const already = await ctx.db
      .query("workspaceGroupMembers")
      .withIndex("by_group_user", (q) => q.eq("groupId", args.groupId).eq("userId", args.userId))
      .unique();
    if (already !== null) return null;

    const named = await ctx.db
      .query("workspaceGroupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .take(MAX_MEMBERS_PER_GROUP);
    if (named.length >= MAX_MEMBERS_PER_GROUP) throw new Error("TOO_MANY_GROUP_MEMBERS");

    await ctx.db.insert("workspaceGroupMembers", {
      groupId: args.groupId,
      workspaceId: args.workspaceId,
      userId: args.userId,
      addedBy: actorId,
      addedAt: Date.now(),
    });
    return null;
  },
});

export const removeGroupMember = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    groupId: v.id("workspaceGroups"),
    userId: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");
    await groupOfWorkspace(ctx, args.workspaceId, args.groupId);

    const row = await ctx.db
      .query("workspaceGroupMembers")
      .withIndex("by_group_user", (q) => q.eq("groupId", args.groupId).eq("userId", args.userId))
      .unique();
    if (row !== null) await ctx.db.delete(row._id);
    return null;
  },
});

/**
 * Delete a group, and release its name.
 *
 * **The manifest is not rewritten**, and that is deliberate rather than
 * unfinished. The bucket is the customer's and a delete here must not reach
 * into it; a rule naming a group that no longer exists resolves to nobody, so
 * the folder reads as owners-only — the safe direction — and the console's
 * privacy panel shows the dangling name for the owner to clear. Silently
 * rewriting somebody's access map from a control-plane delete is the shape
 * that publishes a folder by accident.
 *
 * Releasing the name is the part that must happen: leaving it claimed would
 * make a deleted group a permanent reservation in a namespace shared with
 * every username.
 */
export const deleteGroup = mutation({
  args: { workspaceId: v.id("workspaces"), groupId: v.id("workspaceGroups") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");
    const group = await groupOfWorkspace(ctx, args.workspaceId, args.groupId);

    const named = await ctx.db
      .query("workspaceGroupMembers")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .take(MAX_MEMBERS_PER_GROUP);
    for (const row of named) await ctx.db.delete(row._id);

    const claim = await ctx.db
      .query("names")
      .withIndex("by_name", (q) => q.eq("name", group.name))
      .unique();
    if (claim !== null && claim.kind === "group") await ctx.db.delete(claim._id);

    await ctx.db.delete(args.groupId);
    return null;
  },
});
