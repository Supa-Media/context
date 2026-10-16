/**
 * The workspace's access rows, read from the database as `rowAccess.ts`
 * takes them. Shared by the parity check (`accessParity.ts`) and every reader
 * that answers from rows once `nodeMigration.accessSource` is `rows`
 * (`readerRules.ts`, `grantedNames.ts`), so they cannot read rows differently.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import type { AccessRow, Grantee } from "./rowAccess";

function granteeOf(grant: Doc<"nodeAccess">): Grantee | null {
  if (grant.granteeKind === "user" && grant.granteeUserId !== undefined) {
    return { kind: "user", id: grant.granteeUserId, role: grant.role };
  }
  if (grant.granteeKind === "group" && grant.granteeGroupId !== undefined) {
    return { kind: "group", id: grant.granteeGroupId, role: grant.role };
  }
  if (grant.granteeKind === "email" && grant.granteeEmail !== undefined) {
    return { kind: "email", id: grant.granteeEmail, role: grant.role };
  }
  return null;
}

/** Every row that carries an access setting, as the renderer takes them. Tombstones included: the derivation covers them too. */
export async function accessRowsOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<AccessRow[]> {
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const grants = await ctx.db
    .query("nodeAccess")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const granteesByNode = new Map<string, Grantee[]>();
  for (const grant of grants) {
    const grantee = granteeOf(grant);
    if (grantee === null) continue;
    const list = granteesByNode.get(grant.nodeId) ?? [];
    list.push(grantee);
    granteesByNode.set(grant.nodeId, list);
  }
  const out: AccessRow[] = [];
  for (const row of rows) {
    const grantees = granteesByNode.get(row._id) ?? [];
    if (row.access === undefined && grantees.length === 0) continue;
    out.push({
      path: row.path,
      noteId: row.noteId ?? row._id,
      kind: row.kind,
      base: row.access?.base,
      grantees,
    });
  }
  return out;
}
