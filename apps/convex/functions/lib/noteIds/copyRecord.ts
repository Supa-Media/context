/**
 * What a copy page writes back, and the lease around it. Every write here is
 * guarded by the pass's run id and cursor, so a page that was handed out before
 * a restart, or that a second chain already moved past, records nothing.
 *
 * A copy is marked on its row only when the row still has the etag the copy
 * was made from (`recordCopyPage`). An edit that landed while the bytes were in
 * flight leaves the row stale, and the next pass copies it again; nothing
 * waits for it here.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { COPY_FAILED_LABEL, COPY_STREAK_MAX, COPY_STUCK_LABEL, FAILURES_MAX, idKeyFor } from "../nodes/noteIds";
import { copyRowOf, idCopyPaused, leaseHeld, nodeAt, type CopyRow } from "./state";

export type CopyResult = { path: string; ok: boolean; etag?: string; reason?: string };
export type CopyRefusal = { noteId: string; reason: string };

/** A lease for this run's next page, or `null` when the run is not current, paused, or already leased. */
export async function claimCopyRun(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; runId: number; now: number },
): Promise<{ cursor?: string } | null> {
  const row = await copyRowOf(ctx.db, args.workspaceId);
  if (row === null || row.runId !== args.runId || row.status !== "copying") return null;
  if (await idCopyPaused(ctx.db)) return null;
  if (leaseHeld(row, args.now)) return null;
  await ctx.db.patch(row._id, { leaseAt: args.now });
  return row.cursor === undefined ? {} : { cursor: row.cursor };
}

/** Let go of the lease without moving the cursor (a page that found it must wait for a backfill). */
export async function releaseCopyRun(ctx: MutationCtx, args: { workspaceId: Id<"workspaces">; runId: number }): Promise<void> {
  const row = await copyRowOf(ctx.db, args.workspaceId);
  if (row === null || row.runId !== args.runId) return;
  await ctx.db.patch(row._id, { leaseAt: undefined });
}

/**
 * A page failed. The run keeps going after a back-off until `COPY_STREAK_MAX`
 * failures in a row, then it is shown as failed with a fixed label.
 */
export async function failCopyRun(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; runId: number; streak: number },
): Promise<"stale" | "retry" | "failed"> {
  const row = await copyRowOf(ctx.db, args.workspaceId);
  if (row === null || row.runId !== args.runId || row.status !== "copying") return "stale";
  const now = Date.now();
  if (args.streak + 1 >= COPY_STREAK_MAX) {
    await ctx.db.patch(row._id, { status: "failed", error: COPY_STUCK_LABEL, leaseAt: undefined, updatedAt: now });
    return "failed";
  }
  await ctx.db.patch(row._id, { error: COPY_FAILED_LABEL, leaseAt: undefined, updatedAt: now });
  return "retry";
}

/** What one page's scan and copies add to the pass, and what the next step is. */
export interface CopyPageRecord {
  workspaceId: Id<"workspaces">;
  runId: number;
  /** The cursor the page was claimed at: `undefined` for the first page of a pass. */
  expectedCursor?: string;
  next?: string;
  done: boolean;
  /** The pass had already copied something before this page. */
  found: boolean;
  files: number;
  fresh: number;
  refused: CopyRefusal[];
  results: CopyResult[];
}

export type CopyNext = "more" | "restart" | "paused" | "done" | "stale";

/**
 * Apply one page: mark the copies that are still true, count the failures, and
 * move the cursor. At the end of the scan a pass that copied something is run
 * again from the start, to be sure nothing changed under it; a pass that copied
 * nothing is done. The pass's own counts restart with its first page.
 */
export async function recordCopyPage(
  ctx: MutationCtx,
  args: CopyPageRecord,
): Promise<{ next: CopyNext; found: boolean }> {
  const row: CopyRow | null = await copyRowOf(ctx.db, args.workspaceId);
  if (row === null || row.runId !== args.runId || row.status !== "copying") return { next: "stale", found: false };
  if (row.cursor !== args.expectedCursor) return { next: "stale", found: false };

  const now = Date.now();
  const first = args.expectedCursor === undefined;
  const failures: { noteId: string; reason: string }[] = first ? [] : [...row.failures];
  const files = (first ? 0 : row.files) + args.files;
  let copied = (first ? 0 : row.copied) + args.fresh;
  let failed = first ? 0 : row.failed;
  const failWith = (noteId: string, reason: string) => {
    failed += 1;
    if (failures.length < FAILURES_MAX) failures.push({ noteId, reason });
  };

  for (const refusal of args.refused) failWith(refusal.noteId, refusal.reason);
  let copiedAny = false;
  let editedAny = false;
  for (const result of args.results) {
    const node = await nodeAt(ctx.db, args.workspaceId, result.path);
    if (node === null || node.kind !== "file" || node.goneAt !== undefined || node.noteId === undefined) continue;
    if (!result.ok) {
      failWith(node.noteId, result.reason ?? "copy_failed");
      continue;
    }
    // Made from a version the row no longer has: it was edited while the bytes were in flight,
    // so it is still stale and the pass goes round again to copy it.
    if (node.etag === undefined || node.etag !== result.etag) {
      editedAny = true;
      continue;
    }
    await ctx.db.patch(node._id, { idCopy: { key: idKeyFor(node.noteId, node.path), etag: result.etag, copiedAt: now } });
    copied += 1;
    copiedAny = true;
  }

  const found = args.found || copiedAny || editedAny;
  const paused = await idCopyPaused(ctx.db);
  const fields = { files, copied, failed, failures, leaseAt: undefined, updatedAt: now };
  if (!args.done) {
    await ctx.db.patch(row._id, { ...fields, cursor: args.next });
    return { next: paused ? "paused" : "more", found };
  }
  if (found) {
    await ctx.db.patch(row._id, { ...fields, cursor: undefined });
    return { next: paused ? "paused" : "restart", found };
  }
  await ctx.db.patch(row._id, { ...fields, cursor: undefined, status: "done", error: undefined });
  return { next: "done", found: false };
}
