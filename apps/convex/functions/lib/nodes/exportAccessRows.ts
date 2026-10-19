/**
 * What an archive needs to know about access, read from the rows in rows mode:
 * the rules a member is judged by (`renderAccess`, the same as the readers'),
 * and every row that carries a setting, with its grants labelled for `access.md`.
 *
 * The labels are for the owner's list only. `exportAccess` decides whether
 * they are written at all; this only names what the rows hold.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import type { ExportAccessLine } from "./exportAccess";
import { accessRowsOf } from "./accessRows";
import { renderAccess, type Grantee } from "./rowAccess";

export interface ExportAccessState {
  /** The member rules, as plain values: a query cannot return a `Map`. */
  rules: { prefix: string; vis: string }[];
  overrides: [string, string][];
  lines: ExportAccessLine[];
}

/** The rows-mode access state of one workspace, for an archive. */
export async function exportAccessStateOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<ExportAccessState> {
  const rows = await accessRowsOf(ctx, workspaceId);
  const rendered = renderAccess(rows, "member");
  const lines: ExportAccessLine[] = [];
  for (const row of rows) {
    const grants: string[] = [];
    for (const grantee of row.grantees) grants.push(`${await labelOf(ctx, grantee)} (${grantee.role})`);
    lines.push({
      path: row.path,
      kind: row.kind,
      ...(row.base === undefined ? {} : { base: row.base }),
      grants,
    });
  }
  return {
    rules: rendered.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis })),
    overrides: [...rendered.overrides].map(([path, vis]): [string, string] => [path, vis]),
    lines,
  };
}

/** How a grantee is written in the list: `@handle`, `group name`, or the address. */
async function labelOf(ctx: QueryCtx, grantee: Grantee): Promise<string> {
  if (grantee.kind === "email") return grantee.id;
  if (grantee.kind === "members") return "every member";
  if (grantee.kind === "accounts") return "every Context account";
  if (grantee.kind === "group") {
    const group = await ctx.db.get(grantee.id as Id<"workspaceGroups">);
    return group === null ? "group (removed)" : `group ${group.name}`;
  }
  const handle = await handleOf(ctx, grantee.id as Id<"users">);
  return handle === null ? "a person" : `@${handle}`;
}

/**
 * The name a person answers to: the personal context they own, which is how
 * `resolveAddressedUser` maps `@name` back to them. `null` for someone with none.
 */
async function handleOf(ctx: QueryCtx, userId: Id<"users">): Promise<string | null> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(50);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace === null || workspace.kind !== "personal") continue;
    const claim = await ctx.db
      .query("names")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .first();
    if (claim !== null) return claim.name;
  }
  return null;
}
