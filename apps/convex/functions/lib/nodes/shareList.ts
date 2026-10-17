/**
 * Who a row is shared with, as its owner sees it in the share dialog (`nodesAccess.shareList`).
 *
 * The list that governs a row is the nearest one that carries a setting: the row's own, when it has a base or a
 * list, or else the nearest folder above that has one, which is what `rowAccess.ts` renders (a folder rule reaches
 * every row under it that sets nothing). The answer says which (`from`), so the dialog can say "Shared like its
 * folder" and offer the note a list of its own.
 *
 * Owner only, like every list write. Anyone else, and any mode but rows, gets `null`: the dialog then draws what
 * it drew before rows existed. A grant made by a share (`source: "share"`) is not part of the owner's list and is
 * not shown here; `setAccessRow` never touches one either.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { resolveGroupMembers } from "../../groups";
import { groupLabelOf } from "../names";
import { getMembership } from "../workspaceAuth";
import { accessSourceOf } from "./accessBackfill";
import { accessVersionOf } from "./accessRows";
import { MAX_DOMAINS_PER_WORKSPACE } from "../../workspaceDomains";

const roleValidator = v.union(v.literal("view"), v.literal("edit"));

export const shareEntryValidator = v.union(
  v.object({
    kind: v.literal("user"),
    userId: v.id("users"),
    label: v.string(),
    detail: v.optional(v.string()),
    member: v.boolean(),
    role: roleValidator,
  }),
  v.object({
    kind: v.literal("group"),
    groupId: v.id("workspaceGroups"),
    name: v.string(),
    label: v.string(),
    count: v.number(),
    role: roleValidator,
  }),
  v.object({ kind: v.literal("email"), email: v.string(), role: roleValidator }),
);

export const shareListValidator = v.union(
  v.null(),
  v.object({
    version: v.number(),
    kind: v.union(v.literal("file"), v.literal("folder")),
    /** The row's own base, or `null` when it takes its folder's. */
    base: v.union(v.literal("private"), v.literal("team"), v.null()),
    /** What everyone else in the workspace gets: `team` only where the governing row's base is `team`. */
    tier: v.union(v.literal("private"), v.literal("team")),
    /** The folder whose setting this row follows, or `null` when the row sets its own (or nothing above does). */
    from: v.union(v.string(), v.null()),
    grantees: v.array(shareEntryValidator),
    /** The domains whose people join this workspace when they sign in, switched on (`workspaceDomains`). */
    domains: v.array(v.string()),
  }),
);

export type ShareEntry = Infer<typeof shareEntryValidator>;
export type ShareList = Infer<typeof shareListValidator>;

async function rowAt(ctx: QueryCtx, workspaceId: Id<"workspaces">, path: string): Promise<Doc<"nodes"> | null> {
  return await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .unique();
}

async function listOf(ctx: QueryCtx, row: Doc<"nodes">): Promise<Doc<"nodeAccess">[]> {
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_node", (q) => q.eq("nodeId", row._id))
    .collect();
  return grants.filter((grant) => grant.source !== "share");
}

/** The folders above a path, nearest first. */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let end = parts.length - 1; end > 0; end--) out.push(parts.slice(0, end).join("/"));
  return out;
}

async function entriesOf(
  ctx: QueryCtx,
  workspace: Doc<"workspaces">,
  grants: Doc<"nodeAccess">[],
): Promise<ShareEntry[]> {
  const out: ShareEntry[] = [];
  for (const grant of grants) {
    if (grant.granteeKind === "user" && grant.granteeUserId !== undefined) {
      const user = await ctx.db.get(grant.granteeUserId);
      if (user === null) continue;
      const member = (await getMembership(ctx, workspace._id, grant.granteeUserId)) !== null;
      // An address is shown for a member only: the owner sees members' addresses on the members list already.
      const email = member ? (user.email ?? undefined) : undefined;
      const label = user.name ?? email ?? "Someone outside this workspace";
      out.push({
        kind: "user",
        userId: grant.granteeUserId,
        label,
        detail: user.name !== undefined && email !== undefined ? email : undefined,
        member,
        role: grant.role,
      });
    } else if (grant.granteeKind === "group" && grant.granteeGroupId !== undefined) {
      const group = await ctx.db.get(grant.granteeGroupId);
      if (group === null || group.workspaceId !== workspace._id) continue;
      const live = await resolveGroupMembers(ctx, workspace._id, group._id);
      out.push({
        kind: "group",
        groupId: group._id,
        name: group.name,
        label: groupLabelOf(workspace.slug, group.name),
        count: live.length,
        role: grant.role,
      });
    } else if (grant.granteeKind === "email" && grant.granteeEmail !== undefined) {
      out.push({ kind: "email", email: grant.granteeEmail, role: grant.role });
    }
  }
  return out;
}

export async function shareListHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; path: string },
): Promise<ShareList> {
  const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  if (userId === null) return null;
  const membership = await getMembership(ctx, args.workspaceId, userId);
  if (membership === null || membership.role !== "owner") return null;
  if ((await accessSourceOf(ctx.db)) !== "rows") return null;
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return null;
  const row = await rowAt(ctx, args.workspaceId, args.path);
  if (row === null) return null;

  const version = await accessVersionOf(ctx, args.workspaceId);
  const domains = (
    await ctx.db
      .query("workspaceDomains")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_DOMAINS_PER_WORKSPACE)
  )
    .filter((row) => row.enabled)
    .map((row) => row.domain);
  const own = await listOf(ctx, row);
  if (row.access?.base !== undefined || own.length > 0) {
    return {
      version,
      kind: row.kind,
      base: row.access?.base ?? null,
      // A list on a row with no base of its own is rendered as the list alone (`rowAccess.ts`), which is private.
      tier: row.access?.base === "team" ? "team" : "private",
      from: null,
      grantees: await entriesOf(ctx, workspace, own),
      domains,
    };
  }
  for (const path of ancestorsOf(args.path)) {
    const folder = await rowAt(ctx, args.workspaceId, path);
    if (folder === null) continue;
    const list = await listOf(ctx, folder);
    if (folder.access?.base === undefined && list.length === 0) continue;
    return {
      version,
      kind: row.kind,
      base: null,
      tier: folder.access?.base === "team" ? "team" : "private",
      from: path,
      grantees: await entriesOf(ctx, workspace, list),
      domains,
    };
  }
  return { version, kind: row.kind, base: null, tier: "private", from: null, grantees: [], domains };
}
