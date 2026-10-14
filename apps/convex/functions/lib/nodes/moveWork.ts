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
import { MoveObjectConflict, logicalPath } from "../../../../mcp/src/moves/queued.js";
import { remapFolderIcons } from "@context/shared/src/folderIcons.cjs";
import { clearanceOf } from "../clearance";
import { type PrivacyState, loadPrivacyState } from "../fileOps/privacyState";
import { rewriteReferences } from "../fileOps/references";
import { followInProjection, type ProjectionClient } from "../fileOps/search";
import type { FileStore } from "../fileOps/store";
import type { OperationResult } from "../filesFns/operationTypes";
import { PRIVACY_KEY } from "../privacy";
import { releasePrivacy } from "./movePrivacy";
import { type StepOptions, moveOneObject } from "./moveSteps";
import { touchNodesNow } from "./run";
import { rowFromObject } from "./sweep";
import { type NodeRow, OBSERVE_BATCH } from "./table";

/** Keys one listing of the old name reads. */
const LIST_PAGE = 200;
/** Objects moved at once when each one is read and written through here. */
const POOL = 6;
/** Objects moved at once when the bucket copies them itself (nothing held in memory). */
const SERVER_COPY_POOL = 16;
/**
 * Read-and-write moves hold a file in memory, and a Convex action has 64 MB:
 * files past `ONE_AT_A_TIME_BYTES` take turns, and a file past
 * `BUFFERED_MAX_BYTES` is not attempted on a bucket that cannot copy it
 * itself. It is reported (and the move shown as stuck) rather than taking
 * the whole pass down with it.
 */
const ONE_AT_A_TIME_BYTES = 4 * 1024 * 1024;
export const BUFFERED_MAX_BYTES = 24 * 1024 * 1024;
/** A pass stops starting new pages after this long, and schedules the next. */
const PASS_BUDGET_MS = 60_000;
/** Rows one finishing link rewrite reads, a page at a time. */
const RENAME_PAGE = 2_000;

/** Fixed, path-free labels: what the admin page shows for a failed pass. */
export const MOVE_FAILED_CONFLICT = "A note changed or a name was taken while moving; retrying";
export const MOVE_FAILED_STORAGE = "Storage refused a move; retrying";
export const MOVE_FAILED_FINISH = "Finishing the move failed; retrying";
export const MOVE_FAILED_TOO_LARGE = "A file is too large to move on this storage";

type Claimed = NonNullable<Awaited<ReturnType<typeof claimMove>>>;

function claimMove(ctx: ActionCtx, workspaceId: Id<"workspaces">, now: number) {
  return ctx.runMutation(internal.functions.nodeMoves.claim, { workspaceId, now });
}

/** Run one job at a time through the returned gate, in the order they ask. */
function turns(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>) => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
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

/** What one walk of the old name did. */
interface Walk {
  /** Objects the walk found still at the old name. */
  listed: number;
  moved: number;
  failed: number;
  /** Of those failures, how many were a note changing or a name taken, not storage refusing. */
  conflicts: number;
  /** Of those failures, how many were too large to read through here. */
  tooLarge: number;
  /** The walk reached the end of the old name before its time was up. */
  complete: boolean;
}

/**
 * Walk everything still at the old name once, from the start, a page at a
 * time, moving each object straight to where the tree draws it now.
 *
 * Paged by the store's own cursor, never by "list again until empty": a page
 * can come back with no objects while more follow it (deleted-note markers
 * are hidden from listings, so a page of 200 of them is an empty page), and a
 * file that could not move this time stays first in line. Either way the
 * objects behind it are still reached.
 */
async function walkOldName(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  claimed: Claimed,
  deadline: number,
  steps: StepOptions,
): Promise<Walk> {
  const walk: Walk = { listed: 0, moved: 0, failed: 0, conflicts: 0, tooLarge: 0, complete: false };
  const serverCopy = store.capabilities?.serverSideCopy === "same-store";
  const oneAtATime = turns();
  // A queued trash can carry one note: its own key is the whole old name, and a
  // neighbour whose name extends it (`a.md.notes.md`) is not part of it.
  const single = claimed.kind === "file";
  const prefix = single ? claimed.from : `${claimed.from}/`;
  let cursor: string | undefined;
  for (;;) {
    // The first page always runs, so a pass that started late still moves something.
    if (cursor !== undefined && Date.now() >= deadline) return walk;
    const at = Date.now();
    const listed = await store.list({ prefix, limit: LIST_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    const objects = (listed.objects as { key: string; size?: number }[]).filter((object) => (single ? object.key === claimed.from : object.key.startsWith(prefix)));
    // A store whose prefix listing cannot find a file (Dropbox) is asked for
    // the one note by name; without this a queued trash there moved nothing.
    if (single && objects.length === 0 && (store as { prefixFindsFiles?: boolean }).prefixFindsFiles === false) {
      const object = await store.get(claimed.from);
      if (object !== null) objects.push({ key: claimed.from, size: (object as { size?: number }).size });
    }
    walk.listed += objects.length;
    const rows: NodeRow[] = [];
    const gone: string[] = [];
    await pool(objects, serverCopy ? SERVER_COPY_POOL : POOL, async ({ key, size }) => {
      const bytes = typeof size === "number" ? size : 0;
      if (!serverCopy && bytes > BUFFERED_MAX_BYTES) {
        walk.failed += 1;
        walk.tooLarge += 1;
        return;
      }
      const move = () => moveOneObject(store, key, logicalPath(key, claimed.moves) as string, steps);
      const outcome = !serverCopy && bytes > ONE_AT_A_TIME_BYTES ? await oneAtATime(move) : await move();
      if (outcome.state === "failed") {
        walk.failed += 1;
        if (outcome.conflict) walk.conflicts += 1;
        return;
      }
      if (outcome.state === "moved") {
        walk.moved += 1;
        const row = rowFromObject({ key: outcome.path, etag: outcome.etag, size: outcome.size });
        if (row !== null) rows.push(row);
      }
      if (rowFromObject({ key }) !== null) gone.push(key);
    });
    await observeMoved(ctx, workspaceId, at, rows, gone);
    const { cursor: next, truncated } = listed as { cursor?: string; truncated?: boolean };
    if (truncated === false || typeof next !== "string" || next === "" || next === cursor) {
      walk.complete = true;
      return walk;
    }
    cursor = next;
  }
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
  if (claimed.trash) {
    // A trash carried no rules and rewrites no links (`trashStart.ts`): the
    // note's rules stay at its name for Restore. Fast search follows it into
    // the trash, or back out, as a trash or restore made in one go does.
    if (projection !== null) await followInProjection(store, { written: [], gone: [], moved: [[claimed.from, claimed.to]] }, projection);
    await touchNodesNow(ctx, workspaceId, store, { paths: [claimed.from, claimed.to], files: [] });
    await ctx.runMutation(internal.functions.nodeMoves.complete, { id: claimed.id });
    return;
  }
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

/**
 * One pass of the oldest queued move in this workspace.
 *
 * Walks the old name until a whole walk finds nothing left there, then
 * finishes the move. A walk that moved everything it found is followed by
 * another, which is what proves the old name empty. A walk with failures ends
 * the pass: what moved is counted as progress, and when nothing moved at all
 * the pass counts as failed and backs off, so a move that cannot progress is
 * shown as stuck rather than spinning.
 */
export async function runMoveWork(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  projection: ProjectionClient | null = null,
  options: { wait?: (ms: number) => Promise<void>; budgetMs?: number } = {},
): Promise<OperationResult> {
  const started = Date.now();
  const claimed = await claimMove(ctx, workspaceId, started);
  if (claimed === null) return { kind: "nodesKept", complete: true };
  const deadline = started + (options.budgetMs ?? PASS_BUDGET_MS);
  let rules: Promise<PrivacyState> | null = null;
  const steps: StepOptions = {
    privacy: () => (rules ??= loadPrivacyState(store)),
    ...(options.wait === undefined ? {} : { wait: options.wait }),
  };
  let moved = 0;
  let failed = 0;
  let conflicts = 0;
  let tooLarge = 0;
  let stage: "moving" | "finishing" = "moving";
  try {
    for (let first = true; first || Date.now() < deadline; first = false) {
      const walk = await walkOldName(ctx, workspaceId, store, claimed, deadline, steps);
      moved += walk.moved;
      failed += walk.failed;
      conflicts += walk.conflicts;
      tooLarge += walk.tooLarge;
      if (walk.complete && walk.listed === 0) {
        stage = "finishing";
        await finishMove(ctx, workspaceId, store, claimed, projection);
        return { kind: "nodesKept", complete: true };
      }
      if (!walk.complete || walk.failed > 0) break;
    }
    if (failed > 0 && moved === 0) {
      const label = tooLarge > 0 ? MOVE_FAILED_TOO_LARGE : conflicts === failed ? MOVE_FAILED_CONFLICT : MOVE_FAILED_STORAGE;
      console.error("nodes.move_failed", { workspaceId, label, failed });
      await ctx.runMutation(internal.functions.nodeMoves.failed, { id: claimed.id, label, now: Date.now() });
      return { kind: "nodesKept", complete: false };
    }
    const now = Date.now();
    await ctx.runMutation(internal.functions.nodeMoves.progress, { id: claimed.id, moved, now, ms: now - started });
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
