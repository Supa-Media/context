/**
 * A workspace's whole access set as its workspace object keeps it (`apps/mcp/src/workspaceStore/accessRows.js`):
 * every row that carries a setting, before any overlay, with what the overlays need to be applied in the object the
 * way `accessRowsOf` applies them here. Sent with the push beside the rendered rules, from the same transaction, so
 * the object can render its own and compare (`docs/decisions/storage-and-credentials/object-row-writes.md`).
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { pinnedContextWorkspace } from "../pinnedContext";
import { accessStateOf, accessVersionOf, settingRowsOf } from "./accessRows";
import { livePending } from "./pendingAccess";
import type { Grantee } from "./rowAccess";
import { movingRowMoves } from "./rowMoveChunks";
import { sealsChatHomes } from "./sealedChats";

export interface ObjectAccessSet {
  version: number;
  rows: { token: string; kind: "file" | "folder"; path: string; base?: "private" | "team"; grantees: Grantee[] }[];
  pending: { path: string; kind: "file" | "folder"; base: "private" | "team"; at: number }[];
  /** `accounts` grants are honoured here: the pinned workspace (`withAccountsHonoured`). */
  accounts: boolean;
  /** The chat homes are sealed here (`withSealedChats`). */
  sealsChats: boolean;
  /** Chunked moves part way through, while which the rules name both paths (`withMovingAccess`). */
  moving: number;
}

export async function objectAccessSet(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<ObjectAccessSet> {
  const state = await accessStateOf(ctx, workspaceId);
  const rows = await settingRowsOf(ctx, workspaceId, state);
  const pinned = await pinnedContextWorkspace(ctx);
  return {
    version: await accessVersionOf(ctx, workspaceId),
    rows: rows.map((row) => ({
      token: row.noteId,
      kind: row.kind,
      path: row.path,
      ...(row.base !== undefined ? { base: row.base } : {}),
      grantees: row.grantees.map((grantee) => ({ kind: grantee.kind, id: grantee.id, role: grantee.role })),
    })),
    pending: livePending(state?.pending, Date.now()).map((entry) => ({ path: entry.path, kind: entry.kind, base: entry.base, at: entry.at })),
    accounts: pinned !== null && pinned._id === workspaceId,
    sealsChats: await sealsChatHomes(ctx, workspaceId),
    moving: (await movingRowMoves(ctx.db, workspaceId)).length,
  };
}
