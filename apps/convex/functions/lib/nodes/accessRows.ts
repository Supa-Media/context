/**
 * The workspace's access rows, read from the database as `rowAccess.ts`
 * takes them. Shared by the parity check (`accessParity.ts`) and every reader
 * that answers from rows once `nodeMigration.accessSource` is `rows`
 * (`readerRules.ts`, `grantedNames.ts`), so they cannot read rows differently.
 *
 * Readers read the snapshot one derivation leaves on `nodeAccessState` (one
 * document, not a scan of the tree). The snapshot is absent while a derivation
 * walks and when the set is too large to hold, and then the scan answers.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { pinnedContextWorkspace } from "../pinnedContext";
import { withPendingPrivate } from "./pendingAccess";
import { withChatFolders } from "./chatFolders";
import type { AccessRow, Grantee } from "./rowAccess";
import { movingRowMoves, withMovingAccess } from "./rowMoveChunks";
import { located, nodePaths } from "./paths";

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
  if (grant.granteeKind === "members") return { kind: "members", id: "members", role: grant.role };
  if (grant.granteeKind === "accounts") return { kind: "accounts", id: "accounts", role: grant.role };
  return null;
}

/**
 * Every row that carries an access setting, read by scanning the tree and the
 * grants. Tombstones included: the derivation covers them too. This is the
 * truth the snapshot is rebuilt from, and the fallback while there is none.
 */
export async function scanAccessRows(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<AccessRow[]> {
  // Only the rows with a setting of their own, and the rows a grant names: a big workspace's whole tree is more
  // than one function may read (a chunked Archive rename stopped for good on "Too many bytes read", 2026-10-22).
  const rows = new Map<string, Doc<"nodes">>();
  for (const base of ["private", "team"] as const) {
    const set = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_access", (q) => q.eq("workspaceId", workspaceId).eq("access.base", base))
      .collect();
    for (const row of set) rows.set(row._id, row);
  }
  const paths = await nodePaths(ctx.db, workspaceId);
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
    if (!rows.has(grant.nodeId)) {
      const row = await ctx.db.get(grant.nodeId);
      if (row !== null && row.workspaceId === workspaceId) rows.set(row._id, row);
    }
  }
  // Each at the path it is at now; a row its parents spell no path for is reached by no reader, and judges nothing.
  const placed: Doc<"nodes">[] = [];
  for (const row of rows.values()) {
    const at = await located(ctx.db, row, paths);
    if (at !== null) placed.push(at);
  }
  // In path order, as the tree's index gave them before.
  const ordered = placed.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const out: AccessRow[] = [];
  for (const row of ordered) {
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

/**
 * The workspace's `nodeAccessState` row, read once per query.
 *
 * It holds the access snapshot, the largest thing a reader reads, and one
 * query used to read it up to four times: the rules, the rules' etag, and the
 * access version each asked again (`nodesPrivacy.authority`, the live head,
 * folder listings; Convex invoice, owner 2026-10-30). A query cannot change
 * it, so its first answer is the answer for the rest of the query. A mutation
 * (a `db` that can write) always reads afresh, as it may have just written it.
 */
const stateReads = new WeakMap<object, Map<string, Promise<Doc<"nodeAccessState"> | null>>>();

export async function accessStateOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Doc<"nodeAccessState"> | null> {
  const read = () =>
    ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
  if ("insert" in ctx.db) return await read();
  let reads = stateReads.get(ctx.db);
  if (reads === undefined) stateReads.set(ctx.db, (reads = new Map()));
  let state = reads.get(workspaceId);
  if (state === undefined) reads.set(workspaceId, (state = read()));
  return await state;
}

/** The version of this workspace's access rows: bumped by every finished derivation, `0` before the first. */
export async function accessVersionOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<number> {
  const state = await accessStateOf(ctx, workspaceId);
  return state?.version ?? 0;
}

/**
 * The access rows a reader judges by: the snapshot one document holds when a
 * finished derivation left one, else the scan.
 */
export async function accessRowsOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<AccessRow[]> {
  const state = await accessStateOf(ctx, workspaceId);
  const rows =
    state?.snapshot !== undefined
      ? state.snapshot.map((entry) => ({
          path: entry.path,
          noteId: entry.noteId,
          kind: entry.kind,
          base: entry.base,
          grantees: entry.grantees.map((grantee) => ({ kind: grantee.kind, id: grantee.id, role: grantee.role })),
        }))
      : await scanAccessRows(ctx, workspaceId);
  // A folder moving in pages is judged by the same rules at both its names (`rowMoveChunks.ts`).
  const moving = withMovingAccess(rows, await movingRowMoves(ctx.db, workspaceId));
  // A private access waiting for its row closes the path before the row exists (`pendingAccess.ts`).
  const pending = withPendingPrivate(moving, state?.pending, Date.now());
  // A Tex guest chat's folder is shared with the chat's group before it has a row (`chatFolders.ts`).
  return await withAccountsHonoured(ctx, workspaceId, await withChatFolders(ctx, workspaceId, pending));
}

/**
 * The rows with every `accounts` grant taken out, unless this is the pinned workspace. "Every signed-in Context
 * account" is that one workspace's level and nobody else's (non-negotiable #5): a grant of it anywhere else, however
 * it got there, opens nothing and gives nobody a name. A row left with neither a base nor a list carried no
 * setting of its own and is dropped, as `scanAccessRows` drops one. One extra read only where such a grant exists.
 */
export async function withAccountsHonoured(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  rows: AccessRow[],
): Promise<AccessRow[]> {
  if (!rows.some((row) => row.grantees.some((grantee) => grantee.kind === "accounts"))) return rows;
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned !== null && pinned._id === workspaceId) return rows;
  return rows
    .map((row) => ({ ...row, grantees: row.grantees.filter((grantee) => grantee.kind !== "accounts") }))
    .filter((row) => row.base !== undefined || row.grantees.length > 0);
}
