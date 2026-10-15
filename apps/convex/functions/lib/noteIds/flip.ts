/**
 * The flip to keyed rows (`keys` mode, `lib/noteIds/keyedState.ts`): once a
 * copy pass finds nothing left to copy, each live file row whose copy is still
 * true is keyed. Its bytes are the copy's bytes, so the flip changes no content
 * and writes no change-log entry; it only makes the key the row's own
 * (`storageKey`) and rebases the row's etag onto the key's version.
 *
 * One page is one mutation (`functions/noteIdsCopy.ts`, `flip`): it reads up to
 * `COPY_SCAN` rows and keys up to `FLIP_PAGE` of the ones that qualify, and says
 * where it stopped so the next page starts just after. Nothing here reaches a
 * bucket.
 *
 * Plumbing (`privacy.md`, `.`-folders, id-keyed names) is never keyed: it is
 * not a note, and the engine reads it by its path.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { isPlumbing } from "../privacy";
import { COPY_SCAN, copyMatches, idKeyFor } from "../nodes/noteIds";

/** Live file rows one flip page keys at most. */
export const FLIP_PAGE = 200;

export interface FlipPage {
  /** Rows keyed by this page. */
  flipped: number;
  /** The last path read, when the walk stopped before the end. */
  next?: string;
  /** The walk reached the end of the workspace's rows. */
  done: boolean;
  /** Some live, non-plumbing file row is still unkeyed (its copy is not fresh): carried to the next page. */
  left: boolean;
}

export interface FlipTarget {
  storageKey: string;
  keyEtag: string;
  pathEtag: string;
}

/**
 * The key a row flips to and the version it takes, or `null` when the row
 * does not qualify: not a live unkeyed file, no id, no fresh copy, or a copy
 * recorded under a key other than the id key for its path.
 */
export function flipTarget(row: Doc<"nodes">): FlipTarget | null {
  if (row.kind !== "file" || row.goneAt !== undefined || row.storageKey !== undefined) return null;
  if (row.noteId === undefined || row.etag === undefined || row.idCopy === undefined) return null;
  if (!copyMatches(row)) return null;
  const keyEtag = row.idCopy.keyEtag;
  if (typeof keyEtag !== "string" || keyEtag === "") return null;
  if (row.idCopy.key !== idKeyFor(row.noteId, row.path)) return null;
  return { storageKey: row.idCopy.key, keyEtag, pathEtag: row.etag };
}

/** Whether a row is a live, unkeyed file that is a note (not plumbing): one the flip owes a key to. */
export function owesKey(row: Doc<"nodes">): boolean {
  return row.kind === "file" && row.goneAt === undefined && row.storageKey === undefined && !isPlumbing(row.path);
}

/**
 * Keys the qualifying rows after `after`, up to `FLIP_PAGE` of them, reading at
 * most `COPY_SCAN` rows. `leftBefore` is carried in from earlier pages: the
 * walk completes (`keyedDoneAt`) only when no page found a row still owed a key.
 */
export async function flipPage(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  after: string | undefined,
  leftBefore: boolean,
): Promise<FlipPage> {
  const rows = ctx.db.query("nodes").withIndex("by_workspace_path", (q) =>
    after === undefined ? q.eq("workspaceId", workspaceId) : q.eq("workspaceId", workspaceId).gt("path", after),
  );
  let flipped = 0;
  let read = 0;
  let left = leftBefore;
  for await (const row of rows) {
    read += 1;
    if (owesKey(row)) {
      const target = flipTarget(row);
      if (target === null) {
        left = true;
      } else {
        await keyRow(ctx, row, target);
        flipped += 1;
      }
    }
    if (flipped >= FLIP_PAGE || read >= COPY_SCAN) {
      return { flipped, next: row.path, done: false, left };
    }
  }
  return { flipped, done: true, left };
}

/**
 * A row keyed by the flip: its bytes are the key's, its etag the key's version,
 * and the path version it had is kept in `keyedFrom`. A `parsed` read of the
 * path version is the same text, so it is rebased to the key's version.
 */
async function keyRow(ctx: MutationCtx, row: Doc<"nodes">, target: FlipTarget): Promise<void> {
  await ctx.db.patch(row._id, {
    storageKey: target.storageKey,
    etag: target.keyEtag,
    keyedFrom: { pathEtag: target.pathEtag, keyEtag: target.keyEtag },
    ...(row.parsed === target.pathEtag ? { parsed: target.keyEtag } : {}),
  });
}
