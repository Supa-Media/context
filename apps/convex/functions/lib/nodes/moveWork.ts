/**
 * The queued move's worker (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`): one scheduled pass of the
 * bucket catching up behind a move the tree already draws.
 *
 * A pass takes the workspace's oldest move (`nodeMoves.claim`), lists what is
 * still at its old name, and moves each object straight to where the tree
 * draws it now, through every pending move (`logicalPath`), so a move made on
 * top of a moving folder copies each object once. What it moved is told to the
 * tree as it goes. It repeats until its time is up, then the next pass is
 * scheduled (`nodeMoves.progress`).
 *
 * When nothing is left at the old name the move finishes: the old name's
 * rules go (or, for an undone move, what its start added), links inside the
 * bucket are rewritten once, and the row is deleted.
 *
 * A pass that fails records a fixed label and is retried after a back-off, for
 * ever (`nodeMoves.failed`); staff see it as stuck after a few and can Undo.
 * Nothing here logs a path: a label is all that leaves this file.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { recordForwarding } from "../../../../mcp/src/forwarding.js";
import { MoveObjectConflict, logicalPath, moveObject } from "../../../../mcp/src/moves/queued.js";
import { remapFolderIcons } from "@context/shared/src/folderIcons.cjs";
import { clearanceOf } from "../clearance";
import { loadPrivacyState } from "../fileOps/privacyState";
import { rewriteReferences } from "../fileOps/references";
import { followInProjection, type ProjectionClient } from "../fileOps/search";
import type { FileStore } from "../fileOps/store";
import type { OperationResult } from "../filesFns/operationTypes";
import { PRIVACY_KEY } from "../privacy";
import { releasePrivacy } from "./movePrivacy";
import { touchNodesNow } from "./run";
import { rowFromObject } from "./sweep";
import { type NodeRow, OBSERVE_BATCH } from "./table";

/** Keys one listing of the old name reads. */
const LIST_PAGE = 200;
/** Objects moved at once. */
const POOL = 6;
/** A pass stops starting new pages after this long, and schedules the next. */
const PASS_BUDGET_MS = 60_000;
/** Rows one finishing link rewrite reads, a page at a time. */
const RENAME_PAGE = 2_000;

/** Fixed, path-free labels: what the admin page shows for a failed pass. */
export const MOVE_FAILED_CONFLICT = "A note changed or a name was taken while moving; retrying";
export const MOVE_FAILED_STORAGE = "Storage refused a move; retrying";
export const MOVE_FAILED_FINISH = "Finishing the move failed; retrying";

type Claimed = NonNullable<Awaited<ReturnType<typeof claimMove>>>;

function claimMove(ctx: ActionCtx, workspaceId: Id<"workspaces">, now: number) {
  return ctx.runMutation(internal.functions.nodeMoves.claim, { workspaceId, now });
}

async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(runners);
}

/** Tell the tree what one page moved: destinations seen, sources gone. */
async function observeMoved(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  at: number,
  rows: NodeRow[],
  gone: string[],
): Promise<void> {
  for (let index = 0; index < Math.max(rows.length, gone.length); index += OBSERVE_BATCH) {
    await ctx.runMutation(internal.functions.nodes.observe, {
      workspaceId,
      at,
      rows: rows.slice(index, index + OBSERVE_BATCH),
      gone: gone.slice(index, index + OBSERVE_BATCH),
      vanishedUnder: [],
    });
  }
}

/**
 * Move one page of what is still at the old name. Answers how many objects it
 * moved, or `null` when nothing was left there.
 */
async function movePage(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: FileStore, claimed: Claimed): Promise<number | null> {
  const at = Date.now();
  const listed = await store.list({ prefix: `${claimed.from}/`, limit: LIST_PAGE });
  const keys = listed.objects.map((object) => object.key).filter((key) => key.startsWith(`${claimed.from}/`));
  if (keys.length === 0) return null;
  const rows: NodeRow[] = [];
  const gone: string[] = [];
  let moved = 0;
  await pool(keys, POOL, async (key) => {
    const destination = logicalPath(key, claimed.moves) as string;
    const answer = await moveObject(store, key, destination);
    if (answer.state === "moved") {
      moved += 1;
      const row = rowFromObject({ key: destination, etag: answer.etag, size: answer.size });
      if (row !== null) rows.push(row);
    }
    if (rowFromObject({ key }) !== null) gone.push(key);
  });
  await observeMoved(ctx, workspaceId, at, rows, gone);
  return moved;
}

/** Every move of the finished folder, old name to new, for the one link rewrite. */
async function renamesOf(ctx: ActionCtx, workspaceId: Id<"workspaces">, claimed: Claimed): Promise<Map<string, string>> {
  const renames = new Map<string, string>();
  let after: string | undefined;
  for (;;) {
    const page = await ctx.runQuery(internal.functions.nodeMoves.rowsUnder, {
      workspaceId,
      path: claimed.to,
      ...(after === undefined ? {} : { after }),
      limit: RENAME_PAGE,
    });
    for (const row of page.rows) {
      if (row.kind !== "file" || row.path === claimed.to) continue;
      renames.set(`${claimed.from}${row.path.slice(claimed.to.length)}`, row.path);
    }
    if (page.cursor === null || page.cursor === after) break;
    after = page.cursor;
  }
  return renames;
}

/** Nothing is left at the old name: settle the rules, rewrite links once, and let the row go. */
async function finishMove(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  claimed: Claimed,
  projection: ProjectionClient | null,
): Promise<void> {
  await releasePrivacy(store, { from: claimed.from, undone: claimed.undone, added: claimed.added });
  // Fast search finds the folder's notes at the new name from here on: until
  // now its rows were folded there (`atTreeNames`), and with the move gone
  // from the queue nothing would fold them.
  if (projection !== null) await followInProjection(store, { written: [], gone: [], moved: [[claimed.from, claimed.to]] }, projection);
  await touchNodesNow(ctx, workspaceId, store, { paths: [claimed.from, claimed.to], files: [PRIVACY_KEY] });
  if (claimed.undone) {
    // An undone move's start recorded forwarding the other way; this one points back.
    await recordForwarding(store, [{ from: claimed.from, to: claimed.to, kind: "folder" as const }], { now: Date.now() });
    await remapFolderIcons(store, claimed.from, claimed.to);
  }
  // Best effort, as a move made in one go treats it: the move has landed.
  await rewriteReferences(store, {
    clearance: clearanceOf(claimed.scope, claimed.grantedNames),
    state: await loadPrivacyState(store),
    renames: await renamesOf(ctx, workspaceId, claimed),
  }).catch(() => undefined);
  await ctx.runMutation(internal.functions.nodeMoves.complete, { id: claimed.id });
}

/** One pass of the oldest queued move in this workspace. */
export async function runMoveWork(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  projection: ProjectionClient | null = null,
): Promise<OperationResult> {
  const started = Date.now();
  const claimed = await claimMove(ctx, workspaceId, started);
  if (claimed === null) return { kind: "nodesKept", complete: true };
  let moved = 0;
  let stage: "moving" | "finishing" = "moving";
  try {
    while (Date.now() - started < PASS_BUDGET_MS) {
      const page = await movePage(ctx, workspaceId, store, claimed);
      if (page === null) {
        stage = "finishing";
        await finishMove(ctx, workspaceId, store, claimed, projection);
        return { kind: "nodesKept", complete: true };
      }
      moved += page;
    }
    await ctx.runMutation(internal.functions.nodeMoves.progress, { id: claimed.id, moved, now: Date.now() });
    return { kind: "nodesKept", complete: false };
  } catch (error) {
    const label = stage === "finishing"
      ? MOVE_FAILED_FINISH
      : error instanceof MoveObjectConflict
        ? MOVE_FAILED_CONFLICT
        : MOVE_FAILED_STORAGE;
    // A path never reaches a log: the workspace and the fixed label are all there is.
    console.error("nodes.move_failed", { workspaceId, label });
    await ctx.runMutation(internal.functions.nodeMoves.failed, { id: claimed.id, label, now: Date.now() });
    return { kind: "nodesKept", complete: false };
  }
}
