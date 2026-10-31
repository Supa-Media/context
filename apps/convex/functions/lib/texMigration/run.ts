/**
 * Moving Tex's existing notes from the bucket into their person's Durable
 * Object (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * One call is one page of work, and the cursor says where the next call picks
 * up. Within a personal workspace's Tex folder, each live keyed row whose key
 * is its bucket id key is handled in this order, and each step waits for the
 * one before it:
 *
 *  1. read the bucket copy, and its etag, which must be the row's own version;
 *  2. copy the body to the same id key of the person's object, with its
 *     content type (the row still names the bucket, so nothing reads the copy);
 *  3. read the copy back and compare it with the bucket's bytes;
 *  4. check the bucket copy did not move under the copy;
 *  5. switch the row's key to the Tex form, conditional on the row's etag
 *     still being the one read in step 1 (`functions/texMigration.ts`);
 *  6. only then delete the bucket copy.
 *
 * A crash before 5 leaves the bucket copy authoritative (the next run copies
 * again, over the same key). A crash between 5 and 6 leaves a bucket copy
 * nothing names; a later run finds a row already in the Tex form and removes
 * that copy once the object is there to hold it.
 *
 * The answer is counts, plus paths only when the caller asks for them: the
 * workflow that runs this prints its log publicly, and note names are not
 * for it. Failures are counted by a fixed code, never by their message.
 */

import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { internal } from "../../../_generated/api";
import type { FileStore } from "../fileOps/store";
import { texKeyFor } from "../../../../mcp/src/store/texRouting.js";
import { ID_COPY_MAX_BYTES, idKeyFor } from "../nodes/noteIds";
import { bareEtag, sameBytes, texRowState, type TexRowState } from "./classify";

/** Workspaces read per page of the workspace list. */
const WORKSPACES_PER_PAGE = 25;
/** Work units (rows that are, or were, keyed for a move) one real call may spend: each one reads and writes whole bodies. */
export const MOVE_WORK_PER_CALL = 10;
/** Work units one dry-run call may spend: it only reads the tree. */
export const DRY_WORK_PER_CALL = 500;

export interface TexRow {
  id: Id<"nodes">;
  path: string;
  noteId?: string;
  storageKey: string;
  etag?: string;
}

export interface TexMigrationCounts {
  /** Personal workspaces whose Tex folder was looked at to the end. */
  workspaces: number;
  /** Live keyed rows under a personal workspace's Tex folder. */
  rows: number;
  /** Dry run: rows that a real run would move. */
  wouldMove: number;
  /** Rows switched to the Tex form by this run. */
  moved: number;
  /** Rows already in the Tex form. */
  alreadyMoved: number;
  /** Bucket copies removed for rows already in the Tex form (left by a crash after the switch). */
  swept: number;
  /** Keyed rows that are not this migration's: a path key, or another owner's Tex form. */
  other: number;
  /** Rows left as they were, counted by a fixed code (`missing`, `changed`, `verify_failed`, `FAILED`, ...). */
  refused: Record<string, number>;
}

export interface TexMigrationPage extends TexMigrationCounts {
  /** Paths of the rows handled, only when the caller asked for them. */
  paths?: string[];
  /** Where the next call picks up, or `""` when the run is done. */
  cursor: string;
  done: boolean;
}

export interface TexMigrationOptions {
  dryRun: boolean;
  cursor?: string;
  listPaths?: boolean;
  limit?: number;
  /** The workspace's bucket, as the console opens it, with Tex keys routed to the person's object; `null` when it has none. */
  openStore: (workspaceId: Id<"workspaces">) => Promise<FileStore | null>;
  /** Test seam: runs after a copy is read back and before the switch. */
  afterCopy?: (row: TexRow) => Promise<void>;
}

interface Cursor {
  /** The workspace list's cursor for the page this run is in, or `null` for the first. */
  c: string | null;
  /** The index in that page of the workspace the run is in. */
  i: number;
  /** The last row of that workspace already handled, or `null` to start its folder again. */
  a: string | null;
}

interface Work {
  spent: number;
  limit: number;
}

type Meta = { etag?: string; size?: number };

function emptyCounts(): TexMigrationCounts {
  return { workspaces: 0, rows: 0, wouldMove: 0, moved: 0, alreadyMoved: 0, swept: 0, other: 0, refused: {} };
}

function refuse(counts: TexMigrationCounts, code: string): void {
  counts.refused[code] = (counts.refused[code] ?? 0) + 1;
}

/** An error's code when it names one in capitals, else a fixed `FAILED`: never a message, which can carry a path. */
function codeOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "FAILED";
}

function decodeCursor(cursor: string | undefined): Cursor {
  if (cursor === undefined || cursor === "") return { c: null, i: 0, a: null };
  const parsed = JSON.parse(cursor) as Partial<Cursor>;
  const valid =
    (parsed.c === null || typeof parsed.c === "string") &&
    typeof parsed.i === "number" &&
    Number.isInteger(parsed.i) &&
    parsed.i >= 0 &&
    (parsed.a === null || typeof parsed.a === "string");
  if (!valid) throw new Error("the Tex migration cursor is not one this run wrote");
  return { c: parsed.c ?? null, i: parsed.i as number, a: parsed.a ?? null };
}

/** The bucket's view of `key`: its etag and size, `null` when there is no object, `undefined` when the store cannot say. */
async function metaAt(store: FileStore, key: string): Promise<Meta | null | undefined> {
  if (typeof store.head === "function") return await store.head(key);
  const object = (await store.get(key)) as { etag?: string } | null;
  return object === null ? null : { etag: object.etag };
}

type Outcome = { moved: true } | { moved: false; code: string };

/** Steps 1 to 6 for one row. Answers `moved`, or the fixed code that refused it. */
async function moveRow(
  ctx: ActionCtx,
  options: TexMigrationOptions,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  row: TexRow,
  counts: TexMigrationCounts,
): Promise<Outcome> {
  if (row.noteId === undefined || row.etag === undefined) return { moved: false, code: "no_etag" };
  const idKey = idKeyFor(row.noteId, row.path);
  const texKey = texKeyFor(`person:${workspaceId}`, idKey);

  const before = await metaAt(store, idKey);
  if (before === null) return { moved: false, code: "missing" };
  if (bareEtag(before?.etag) === "") return { moved: false, code: "no_etag" };
  if (bareEtag(before?.etag) !== bareEtag(row.etag)) return { moved: false, code: "changed" };
  if ((before?.size ?? 0) > ID_COPY_MAX_BYTES) return { moved: false, code: "too_large" };

  const source = (await store.get(idKey)) as { arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string }; contentType?: string } | null;
  if (source === null) return { moved: false, code: "missing" };
  const contentType = source.httpMetadata?.contentType ?? source.contentType;
  const bytes = new Uint8Array(await source.arrayBuffer());

  await store.put(texKey, bytes, contentType ? { contentType } : {});
  const copied = (await store.get(texKey)) as { arrayBuffer(): Promise<ArrayBuffer> } | null;
  if (copied === null || !sameBytes(bytes, new Uint8Array(await copied.arrayBuffer()))) return { moved: false, code: "verify_failed" };

  await options.afterCopy?.(row);
  const after = await metaAt(store, idKey);
  if (after === null || after === undefined || bareEtag(after.etag) !== bareEtag(before?.etag)) return { moved: false, code: "changed" };

  const placed = await metaAt(store, texKey);
  const toEtag = bareEtag(placed?.etag);
  if (toEtag === "") return { moved: false, code: "no_etag" };

  const switched = await ctx.runMutation(internal.functions.texMigrationRows.switchKey, {
    workspaceId,
    id: row.id,
    from: idKey,
    to: texKey,
    etag: row.etag,
    toEtag,
  });
  if (!switched) return { moved: false, code: "changed" };

  try {
    await store.delete(idKey);
  } catch {
    refuse(counts, "DELETE_FAILED");
  }
  return { moved: true };
}

/** A row already in the Tex form: removes a bucket copy left behind, once the object is there to hold the note. */
async function sweepRow(store: FileStore, row: TexRow, counts: TexMigrationCounts): Promise<void> {
  if (row.noteId === undefined) return;
  const idKey = idKeyFor(row.noteId, row.path);
  const leftover = await metaAt(store, idKey);
  if (leftover === null || leftover === undefined) return;
  const held = await metaAt(store, row.storageKey);
  if (held === null) {
    refuse(counts, "tex_missing");
    return;
  }
  try {
    await store.delete(idKey);
    counts.swept += 1;
  } catch {
    refuse(counts, "DELETE_FAILED");
  }
}

async function openFor(options: TexMigrationOptions, workspaceId: Id<"workspaces">): Promise<{ store: FileStore | null; code: string }> {
  try {
    const store = await options.openStore(workspaceId);
    return store === null ? { store: null, code: "NO_BUCKET" } : { store, code: "" };
  } catch (error) {
    return { store: null, code: codeOf(error) };
  }
}

/** One workspace from `after` (or its start) to its end, or to the work limit. */
async function migrateWorkspace(
  ctx: ActionCtx,
  options: TexMigrationOptions,
  workspaceId: Id<"workspaces">,
  after: string | null,
  counts: TexMigrationCounts,
  paths: string[],
  work: Work,
): Promise<{ finished: boolean; next: string | null }> {
  const owner = `person:${workspaceId}`;
  let opened: { store: FileStore | null; code: string } | undefined;
  let cursor = after;
  for (;;) {
    const page: { tex: boolean; rows: TexRow[]; next: string | null } = await ctx.runQuery(internal.functions.texMigrationRows.rowsPage, {
      workspaceId,
      ...(cursor === null ? {} : { after: cursor }),
    });
    if (!page.tex) return { finished: true, next: null };
    for (const row of page.rows) {
      counts.rows += 1;
      const state: TexRowState = texRowState(row, owner);
      if (state === "other") {
        counts.other += 1;
        continue;
      }
      if (options.dryRun) {
        if (state === "move") {
          counts.wouldMove += 1;
          if (options.listPaths === true) paths.push(row.path);
        } else {
          counts.alreadyMoved += 1;
        }
      } else {
        opened ??= await openFor(options, workspaceId);
        if (opened.store === null) {
          refuse(counts, opened.code);
        } else {
          try {
            if (state === "move") {
              const outcome = await moveRow(ctx, options, workspaceId, opened.store, row, counts);
              if (outcome.moved) {
                counts.moved += 1;
                if (options.listPaths === true) paths.push(row.path);
              } else {
                refuse(counts, outcome.code);
              }
            } else {
              counts.alreadyMoved += 1;
              await sweepRow(opened.store, row, counts);
            }
          } catch (error) {
            refuse(counts, codeOf(error));
          }
        }
      }
      work.spent += 1;
      if (work.spent >= work.limit) return { finished: false, next: row.path };
    }
    if (page.next === null) return { finished: true, next: null };
    cursor = page.next;
  }
}

/**
 * One call of the run: as much as the work limit allows, from `options.cursor`.
 * Every personal workspace is visited in turn, shared ones have no Tex folder
 * to read and are passed over.
 */
export async function migrateTexNotes(ctx: ActionCtx, options: TexMigrationOptions): Promise<TexMigrationPage> {
  const counts = emptyCounts();
  const paths: string[] = [];
  const work: Work = { spent: 0, limit: options.limit ?? (options.dryRun ? DRY_WORK_PER_CALL : MOVE_WORK_PER_CALL) };
  const start = decodeCursor(options.cursor);

  const finish = (next: Cursor | null, done: boolean): TexMigrationPage => ({
    ...counts,
    ...(options.listPaths === true ? { paths } : {}),
    cursor: next === null ? "" : JSON.stringify(next),
    done,
  });

  let pageCursor = start.c;
  let index = start.i;
  let resume = start.a;
  for (;;) {
    const page: { workspaceIds: Id<"workspaces">[]; cursor: string; done: boolean } = await ctx.runQuery(
      internal.functions.folderNumbers.workspacePage,
      { ...(pageCursor === null ? {} : { cursor: pageCursor }), limit: WORKSPACES_PER_PAGE },
    );
    for (let i = index; i < page.workspaceIds.length; i += 1) {
      const outcome = await migrateWorkspace(ctx, options, page.workspaceIds[i], resume, counts, paths, work);
      resume = null;
      if (!outcome.finished) return finish({ c: pageCursor, i, a: outcome.next }, false);
      counts.workspaces += 1;
    }
    if (page.done) return finish(null, true);
    pageCursor = page.cursor;
    index = 0;
  }
}
