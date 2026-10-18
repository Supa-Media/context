/**
 * The inverse of `renderAccess` for going back to Off (`privacyRows.backToOff`):
 * a workspace's access rows written as the privacy rules a `privacy.md` can
 * hold. Once the rules decide again, they must say what the rows said.
 *
 * What a rule can say, and nothing more:
 *  - `private` or `team` on a row with no list;
 *  - `@name` on a row whose only grant is one view grant to one group or one
 *    person (base `private`, or unset: a listed row with no base is private,
 *    as `renderAccess` renders it).
 *
 * Refused, path by path, is everything else: an email grant, an edit grant,
 * two or more grants on one row, a `team` base with a list (a rule gives one
 * value, and "team, plus these people" is not one), and a person with no
 * handle. Refusing is the only honest answer: writing a narrower rule than the
 * rows would hide notes the owner shared, and a wider one would publish them.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { GROUP_SCOPE_PATTERN, type PrivacyRule, type Visibility } from "../privacy";
import { handleForUser } from "../identities";
import { scanAccessRows } from "./accessRows";
import { withPendingPrivate } from "./pendingAccess";
import type { AccessRow } from "./rowAccess";

export type RulesFromRows =
  | { ok: true; folders: { prefix: string; visibility: string }[]; notes: { path: string; visibility: string }[] }
  | { ok: false; paths: string[] };

/** The `@name` a single grant is written as, or `null` when no name can carry it. */
async function nameOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, row: AccessRow): Promise<Visibility | null> {
  const [grant] = row.grantees;
  if (grant.kind === "group") {
    const group = await ctx.db.get(grant.id as Id<"workspaceGroups">);
    if (group === null || group.workspaceId !== workspaceId) return null;
    const name = `@${group.name}`;
    return GROUP_SCOPE_PATTERN.test(name) ? (name as Visibility) : null;
  }
  if (grant.kind === "user") {
    const handle = await handleForUser(ctx, grant.id as Id<"users">);
    if (handle === null) return null;
    const name = `@${handle}`;
    return GROUP_SCOPE_PATTERN.test(name) ? (name as Visibility) : null;
  }
  return null;
}

/** The visibility one row is written as, or `null` when the rules cannot say it. */
async function visibilityOfRow(ctx: QueryCtx, workspaceId: Id<"workspaces">, row: AccessRow): Promise<Visibility | null> {
  if (row.grantees.length === 0) return row.base === "team" ? "team" : "private";
  if (row.grantees.length > 1 || row.grantees[0].role !== "view") return null;
  if (row.base === "team") return null;
  return await nameOf(ctx, workspaceId, row);
}

/** The rules this workspace's rows say, or the paths they cannot say. Reads only. */
export async function rulesFromRows(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<RulesFromRows> {
  // A private access still waiting for its row is said too, or going back to Off would drop it.
  const state = await ctx.db
    .query("nodeAccessState")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  const rows = withPendingPrivate(await scanAccessRows(ctx, workspaceId), state?.pending, Date.now());
  const folders: PrivacyRule[] = [];
  const notes: { path: string; visibility: string }[] = [];
  const refused: string[] = [];
  for (const row of rows) {
    const vis = await visibilityOfRow(ctx, workspaceId, row);
    if (vis === null) {
      refused.push(row.path);
      continue;
    }
    if (row.kind === "folder") folders.push({ prefix: row.path, vis });
    else notes.push({ path: row.path, visibility: vis });
  }
  if (refused.length > 0) return { ok: false, paths: refused };
  return { ok: true, folders: folders.map((rule) => ({ prefix: rule.prefix, visibility: rule.vis })), notes };
}
