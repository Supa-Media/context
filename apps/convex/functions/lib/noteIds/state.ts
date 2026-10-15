/**
 * The id copy's bookkeeping, read and written by its mutations
 * (`functions/noteIdsCopy.ts`, `functions/noteIds.ts`): the pass row, the
 * switch, a row's own id, and the scan that picks what to copy next.
 *
 * Counts, times and fixed labels only on the pass row. The paths that are read
 * here never leave in a return value, a log or a label.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import { COPY_LEASE_MS, COPY_SCAN, copyIsFresh, idKeyFor, newNoteId, tooLarge, type NoteIdItem } from "../nodes/noteIds";

export type CopyRow = Doc<"noteIdCopies">;
export type NodeDoc = Doc<"nodes">;

export async function copyRowOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<CopyRow | null> {
  return await db
    .query("noteIdCopies")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** The pass row, created idle the first time anything asks for it. */
export async function ensureCopyRow(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<CopyRow> {
  const existing = await copyRowOf(ctx.db, workspaceId);
  if (existing !== null) return existing;
  const id = await ctx.db.insert("noteIdCopies", {
    workspaceId,
    status: "idle",
    runId: 0,
    files: 0,
    copied: 0,
    failed: 0,
    failures: [],
    updatedAt: Date.now(),
  });
  return (await ctx.db.get(id)) as CopyRow;
}

/** The switch: absent means running. */
export async function idCopyPaused(db: DatabaseReader): Promise<boolean> {
  const row = await db.query("noteIdLayout").first();
  return row?.paused === true;
}

/** A page of a pass holds the row's lease, so no second page runs beside it. */
export function leaseHeld(row: CopyRow, now: number): boolean {
  return row.leaseAt !== undefined && now - row.leaseAt < COPY_LEASE_MS;
}

/**
 * Begin a new pass: a new run id (so every page handed out before now records
 * nothing), counts and failures cleared, the cursor back to the start, and the
 * first page scheduled. A pass already holding its lease is left alone unless
 * `force` (a restart), since its page will finish and carry on from there.
 */
export async function beginCopyPass(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  options: { force: boolean },
): Promise<boolean> {
  const now = Date.now();
  const row = await ensureCopyRow(ctx, workspaceId);
  if (!options.force && leaseHeld(row, now)) return false;
  const runId = row.runId + 1;
  await ctx.db.patch(row._id, {
    status: "copying",
    runId,
    cursor: undefined,
    files: 0,
    copied: 0,
    failed: 0,
    failures: [],
    error: undefined,
    leaseAt: undefined,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.run, { workspaceId, runId });
  return true;
}

export async function nodeAt(db: DatabaseReader, workspaceId: Id<"workspaces">, path: string): Promise<NodeDoc | null> {
  return await db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .unique();
}

/** The pages of live files one scan reads: its items, the rows it cannot copy, and where it stopped. */
export interface CopyScan {
  items: NoteIdItem[];
  /** Live files the scan read that a copy is owed for and cannot be made: their id and a reason, never a path. */
  refused: { noteId: string; reason: "too_large" | "no_etag" }[];
  /** Live files read, and how many already have a copy that is still true. */
  files: number;
  fresh: number;
  /** Live files with no `noteId` yet: the backfill has not reached them. */
  unidentified: number;
  /** The last path read, when the scan stopped before the end. */
  next?: string;
  done: boolean;
}

/**
 * The next stale live files after `after`, in path order. Stops at `limit`
 * items or `COPY_SCAN` rows read, whichever is first, and says where it
 * stopped so the next page starts just after it.
 */
export async function scanCopies(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  after: string | undefined,
  limit: number,
): Promise<CopyScan> {
  const scan: CopyScan = { items: [], refused: [], files: 0, fresh: 0, unidentified: 0, done: true };
  const rows = db.query("nodes").withIndex("by_workspace_path", (q) =>
    after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", after),
  );
  let read = 0;
  let last: string | undefined;
  for await (const row of rows) {
    read += 1;
    last = row.path;
    if (row.kind === "file" && row.goneAt === undefined) {
      scan.files += 1;
      if (row.noteId === undefined) scan.unidentified += 1;
      else if (copyIsFresh(row)) scan.fresh += 1;
      else if (tooLarge(row.size)) scan.refused.push({ noteId: row.noteId, reason: "too_large" });
      else if (row.etag === undefined) scan.refused.push({ noteId: row.noteId, reason: "no_etag" });
      else scan.items.push({ path: row.path, key: idKeyFor(row.noteId, row.path), etag: row.etag, ...(row.size === undefined ? {} : { size: row.size }) });
    }
    if (scan.items.length >= limit || read >= COPY_SCAN) {
      scan.done = false;
      scan.next = last;
      break;
    }
  }
  return scan;
}

/** The live file rows that hold a copy, after `after`, for the diagnosis to check. */
export interface CheckScan {
  items: NoteIdItem[];
  next?: string;
  done: boolean;
}

export async function scanCopiedFiles(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  after: string | undefined,
  limit: number,
): Promise<CheckScan> {
  const scan: CheckScan = { items: [], done: true };
  const rows = db.query("nodes").withIndex("by_workspace_path", (q) =>
    after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", after),
  );
  let read = 0;
  let last: string | undefined;
  for await (const row of rows) {
    read += 1;
    last = row.path;
    if (row.kind === "file" && row.goneAt === undefined && row.idCopy !== undefined && row.etag !== undefined) {
      scan.items.push({ path: row.path, key: row.idCopy.key, etag: row.etag, ...(row.size === undefined ? {} : { size: row.size }) });
    }
    if (scan.items.length >= limit || read >= COPY_SCAN) {
      scan.done = false;
      scan.next = last;
      break;
    }
  }
  return scan;
}

/**
 * A queued move (`lib/nodes/moveWork.ts`) has moved the bytes at `from` to
 * `to`. The note keeps its id, so the target takes the source's `noteId`, and
 * its copy if the copy is still the same object's: the bytes are the same, so
 * the copy is judged by the etag the target now has. A copy that would sit
 * under a different key (the name's extension changed) is not carried.
 */
export async function carryIdentity(ctx: MutationCtx, workspaceId: Id<"workspaces">, from: string, to: string): Promise<void> {
  const source = await nodeAt(ctx.db, workspaceId, from);
  const target = await nodeAt(ctx.db, workspaceId, to);
  if (source === null || target === null || target.kind !== "file") return;
  const noteId = source.noteId ?? target.noteId ?? newNoteId();
  const key = idKeyFor(noteId, to);
  const copy = source.idCopy;
  const idCopy =
    copy !== undefined && copy.key === key && target.etag !== undefined
      ? { key, etag: copy.etag === source.etag ? target.etag : copy.etag, copiedAt: copy.copiedAt }
      : undefined;
  await ctx.db.patch(target._id, { noteId, idCopy });
}
