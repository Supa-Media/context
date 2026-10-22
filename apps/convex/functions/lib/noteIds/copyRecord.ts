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
import { applyObservation } from "../nodes/observe";
import { convexNodeTable } from "../nodes/convexTable";
import { COPY_FAILED_LABEL, COPY_HEAL_MAX, COPY_STREAK_MAX, COPY_STUCK_LABEL, FAILURES_MAX, idKeyFor } from "../nodes/noteIds";
import { copyRowOf, leaseHeld, nodeAt, type CopyRow, type NodeDoc } from "./state";

export type CopyResult = {
  path: string;
  /** The key the page wrote the bytes to (the item's key); a row whose id changed since does not take the copy. */
  key?: string;
  ok: boolean;
  etag?: string;
  keyEtag?: string;
  reason?: string;
  /** For `changed`: the bucket's current version of the path (`copyOne` in `apps/mcp/src/moves/idCopyPage.js`). */
  currentEtag?: string;
  currentSize?: number;
};
export type CopyRefusal = { noteId: string; reason: string };

/** A lease for this run's next page, or `null` when the run is not current or already leased. */
export async function claimCopyRun(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; runId: number; now: number },
): Promise<{ cursor?: string } | null> {
  const row = await copyRowOf(ctx.db, args.workspaceId);
  if (row === null || row.runId !== args.runId || row.status !== "copying") return null;
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

/**
 * Set a live row to the bucket's version of its path: the same observation a
 * sweep makes of that path (`observe.ts`), so the row's etag and size are what
 * the bucket holds now. Only the row the copy named is touched.
 */
async function refreshRow(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  node: NodeDoc,
  current: { etag: string; size?: number },
  at: number,
): Promise<void> {
  await applyObservation(convexNodeTable(ctx, workspaceId), {
    at,
    rows: [{ path: node.path, etag: current.etag, size: current.size ?? node.size, uploaded: node.uploaded }],
    gone: [],
    vanishedUnder: [],
    source: "bucket",
  });
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

export type CopyNext = "more" | "restart" | "done" | "stale";

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
    // Listed once per id: two rows that name one id are one line in the report, and each still counts as failed.
    if (failures.length < FAILURES_MAX && !failures.some((failure) => failure.noteId === noteId)) failures.push({ noteId, reason });
  };

  for (const refusal of args.refused) failWith(refusal.noteId, refusal.reason);
  let copiedAny = false;
  let editedAny = false;
  for (const result of args.results) {
    const node = await nodeAt(ctx.db, args.workspaceId, result.path);
    if (node === null || node.kind !== "file" || node.goneAt !== undefined || node.noteId === undefined) continue;
    // A keyed row's bytes live at its key alone: a copy made from its frozen path object marks nothing.
    if (node.storageKey !== undefined) continue;
    // The bytes went to the key the page was handed; a row that took another id since (a repair) does not own that copy.
    if (result.key !== undefined && result.key !== idKeyFor(node.noteId, node.path)) continue;
    if (!result.ok) {
      if (result.reason === "changed" && result.currentEtag !== undefined && result.currentEtag !== node.etag) {
        // The bucket holds a version the row does not: a writer changed the object without the tree hearing of it,
        // so the row is what is stale. Refresh it to the bucket's version (as a sweep would) and copy again next pass.
        // A note that keeps changing is healed a few passes in a row, then reported as changed.
        await refreshRow(ctx, args.workspaceId, node, { etag: result.currentEtag, size: result.currentSize }, now);
        const heals = node.idHeals ?? 0;
        if (heals < COPY_HEAL_MAX) {
          await ctx.db.patch(node._id, { idHeals: heals + 1 });
          editedAny = true;
        } else {
          failWith(node.noteId, "changed");
        }
        continue;
      }
      failWith(node.noteId, result.reason ?? "copy_failed");
      continue;
    }
    // Made from a version the row no longer has: it was edited while the bytes were in flight,
    // so it is still stale and the pass goes round again to copy it.
    if (node.etag === undefined || node.etag !== result.etag) {
      editedAny = true;
      continue;
    }
    await ctx.db.patch(node._id, {
      idHeals: undefined,
      idCopy: {
        key: idKeyFor(node.noteId, node.path),
        etag: result.etag,
        copiedAt: now,
        ...(result.keyEtag === undefined ? {} : { keyEtag: result.keyEtag }),
      },
    });
    copied += 1;
    copiedAny = true;
  }

  const found = args.found || copiedAny || editedAny;
  const fields = { files, copied, failed, failures, leaseAt: undefined, updatedAt: now };
  if (!args.done) {
    await ctx.db.patch(row._id, { ...fields, cursor: args.next });
    return { next: "more", found };
  }
  if (found) {
    await ctx.db.patch(row._id, { ...fields, cursor: undefined });
    return { next: "restart", found };
  }
  await ctx.db.patch(row._id, { ...fields, cursor: undefined, status: "done", error: undefined });
  return { next: "done", found: false };
}
