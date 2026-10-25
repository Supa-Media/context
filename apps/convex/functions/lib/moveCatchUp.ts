/**
 * Catching up after a storage move switches over.
 *
 * A move's last check reads every file in the old bucket, finds nothing
 * different, and the binding swaps. What the check cannot see is a write that
 * lands in the old bucket *after* it read that file: a writer that opened the
 * old storage a moment before the swap — an agent's turn, a file operation of
 * up to ten minutes, a queued job — still finishes into it. Nothing reads the
 * old bucket again, so without this that write is lost.
 *
 * A write fence was the other design, and it was turned down because of what a
 * refused writer does here: the email worker rejects mail it cannot store
 * permanently (by design: see `infra/email-worker`), and queued jobs fail for
 * good. A fence would lose exactly the data it was meant to protect.
 *
 * So after the swap, a few passes read the old bucket for files changed since
 * the last check began, and bring them across under one rule: **a file in the
 * new bucket is never overwritten and never deleted.**
 *
 *  - Missing from the new bucket: created there, create-only, so a file that
 *    appears between the read and the write wins and the late one goes beside
 *    it instead.
 *  - Different in the new bucket: the late version is kept beside it, as a
 *    note of its own named `name (saved during the move).ext` in the same
 *    folder. We cannot tell which side is newer without trusting two
 *    providers' clocks against ours, and guessing wrong either way loses an
 *    edit; keeping both loses nothing. A note's bytes live at its id key and
 *    its name is a tree row (`notes-by-id.md`), so the copy is a new note id
 *    with its own key and a row beside the original's, carrying the
 *    original's access (`moveCatchUpRows.ts`). A copy under a key with no
 *    row would be a file nobody can open, which is the edit lost after all.
 *  - A late version of an id key no live row holds (a note trashed in the new
 *    bucket's tree) is not carried: nobody could open it.
 *  - A deletion in the old bucket is not carried: the note stays. A deleted
 *    note coming back is recoverable by deleting it again; a note deleted by a
 *    stale writer is not recoverable at all.
 *  - Anything that is not an id key, Context's own plumbing under `.context/`
 *    and the frozen path copies a keyed bucket still holds alike, is only ever
 *    created, never duplicated: a copy of an index or a history file under a
 *    new name is noise nobody can use, and nothing reads a path copy.
 *
 * The cost, stated: a file whose old-bucket copy was rewritten with the same
 * content during the last check, and which is then edited in the new bucket
 * before a pass runs, gets a harmless extra copy. That is the price of never
 * guessing between two clocks.
 *
 * Not yet covered: a managed source whose objects are encrypted. The passes
 * read raw objects, exactly as the move does, so they must move to the
 * key-aware store in the same change that lets the move read one.
 */

import {
  ATTACHMENT_CONTENT_TYPE,
  LOGICAL_DELETE_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
} from "../../../mcp/src/store/index.js";
import { isLogicalDeleteMarker } from "../../../mcp/src/store/logicalDelete.js";
import { idKeyFor, isNoteId, newNoteId } from "../../../mcp/src/store/noteIdKeys.js";
import { planReconcileWaves } from "./managedMigration";

interface CatchUpRead {
  contentType?: string;
  uploaded?: Date;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface CatchUpListed {
  key: string;
  size?: number;
  uploaded?: Date;
}

/** The slice of a store the catch-up uses. Writes are create-only. */
export interface CatchUpStore {
  list(options: { cursor?: string; limit?: number }): Promise<{
    objects: CatchUpListed[];
    truncated: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<CatchUpRead | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options: { contentType: string; onlyIf?: { absent: true } },
  ): Promise<{ etag?: string } | null>;
}

/** One name beside a note a late version may take: free, a row keyed at `key`, or taken by something else. */
export type BesideSlot = { free: true } | { free: false; key: string | null };

/** The tree's side of keeping a late version beside its note (`moveCatchUpRows.ts`). */
export interface CatchUpRows {
  /**
   * The path of the live row keyed at `key`, and each beside name's state in
   * order (`besideName(path, 1)` first), or null when no live row holds it.
   */
  besideOf(key: string): Promise<{ path: string; slots: BesideSlot[] } | null>;
  /**
   * Gives the copy written at `key` its row at `path`, beside the note keyed
   * at `original`, with that note's access. False when it could not: the name
   * was taken meanwhile, or the original is gone.
   */
  adopt(copy: { original: string; path: string; noteId: string; key: string; etag: string; size: number }): Promise<boolean>;
}

export type CatchUpOutcome =
  | "same"
  | "copied"
  | "kept_beside"
  | "deletion_not_carried"
  | "left"
  | "no_row"
  | "too_large"
  | "no_room"
  | "gone";

/** The most numbered copies one note gets before a pass gives up on it. */
const MAX_COPIES = 20;

/**
 * `projects/plan.md` becomes `projects/plan (saved during the move).md`, then
 * `… 2)`: the name a late version's row takes beside its note.
 */
export function besideName(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const suffix = n <= 1 ? " (saved during the move)" : ` (saved during the move ${n})`;
  return dot > slash + 1 ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`;
}

/** The besides names a note's late versions may take, in order. */
export function besideNames(path: string): string[] {
  return Array.from({ length: MAX_COPIES }, (_, index) => besideName(path, index + 1));
}

const ID_KEY = /^(?:notes\/([^/]+)\.md|files\/([^/.]+)(?:\.[^/]*)?)$/;

/** The note id an id key names (`notes/<id>.md`, `files/<id>.<ext>`), or null for any other key. */
export function noteIdOfKey(key: string): string | null {
  const match = ID_KEY.exec(key);
  const noteId = match?.[1] ?? match?.[2] ?? null;
  return noteId !== null && isNoteId(noteId) ? noteId : null;
}

/**
 * Whether a listed object may have changed after the last check began.
 *
 * A listing with no usable date is treated as changed: skipping it would turn
 * a provider that omits LastModified into silent loss, and reading it costs
 * one comparison.
 */
export function changedSince(object: CatchUpListed, since: number): boolean {
  const at = object.uploaded?.getTime();
  if (at === undefined || !Number.isFinite(at) || at <= 0) return true;
  return at >= since;
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function contentTypeFor(key: string): string {
  return key.toLowerCase().endsWith(".md") ? MARKDOWN_CONTENT_TYPE : ATTACHMENT_CONTENT_TYPE;
}

/** Create `key` only if it is absent, then prove the bytes landed. Null when something else holds the key. */
async function createExactly(
  target: CatchUpStore,
  key: string,
  bytes: ArrayBuffer,
): Promise<{ etag?: string } | null> {
  const written = await target.put(key, bytes, {
    contentType: contentTypeFor(key),
    onlyIf: { absent: true },
  });
  if (written === null) return null;
  const verified = await target.get(key);
  if (verified === null || !sameBytes(bytes, await verified.arrayBuffer())) {
    throw new Error("VERIFY_FAILED");
  }
  return written;
}

/** Whether `key` in the target holds exactly `bytes`. */
async function holds(target: CatchUpStore, key: string, bytes: ArrayBuffer): Promise<boolean> {
  const there = await target.get(key);
  return there !== null && sameBytes(bytes, await there.arrayBuffer());
}

/**
 * Keep a late version of the note keyed at `key` beside it: a new note id, its
 * bytes at that id's key, and a row at the first free beside name. A beside
 * name already holding these bytes means an earlier pass kept them.
 */
async function keepBeside(
  target: CatchUpStore,
  rows: CatchUpRows,
  key: string,
  bytes: ArrayBuffer,
): Promise<CatchUpOutcome> {
  const note = await rows.besideOf(key);
  if (note === null) return "no_row";
  for (const [index, slot] of note.slots.entries()) {
    if (!slot.free) {
      if (slot.key !== null && (await holds(target, slot.key, bytes))) return "kept_beside";
      continue;
    }
    const path = besideName(note.path, index + 1);
    const noteId = newNoteId();
    const copyKey = idKeyFor(noteId, path);
    const written = await createExactly(target, copyKey, bytes);
    // A fresh id's key is never taken; if it somehow is, the next name gets another id.
    if (written === null) continue;
    if (await rows.adopt({ original: key, path, noteId, key: copyKey, etag: written.etag ?? "", size: bytes.byteLength })) {
      return "kept_beside";
    }
    // Taken between the look and the write, or the original went: look again from the start of the names.
    return await keepBesideAgain(target, rows, key, bytes);
  }
  return "no_room";
}

/** One more look after a lost race for a name, so two passes never loop on each other. */
async function keepBesideAgain(
  target: CatchUpStore,
  rows: CatchUpRows,
  key: string,
  bytes: ArrayBuffer,
): Promise<CatchUpOutcome> {
  const note = await rows.besideOf(key);
  if (note === null) return "no_row";
  for (const slot of note.slots) {
    if (!slot.free && slot.key !== null && (await holds(target, slot.key, bytes))) return "kept_beside";
  }
  // Still not kept: the next pass reads the old bucket again and tries once more.
  throw new Error("BESIDE_RACE");
}

/** Bring one old-bucket key across without touching anything already there. */
export async function catchUpObject(options: {
  source: CatchUpStore;
  target: CatchUpStore;
  rows: CatchUpRows;
  key: string;
  byteCap: number;
}): Promise<CatchUpOutcome> {
  const { source, target, key } = options;
  const read = await source.get(key);
  if (read === null) return "gone";
  const bytes = await read.arrayBuffer();
  if (bytes.byteLength > options.byteCap) return "too_large";
  if (
    read.contentType === LOGICAL_DELETE_CONTENT_TYPE ||
    (bytes.byteLength < 512 && isLogicalDeleteMarker(new TextDecoder().decode(bytes)))
  ) {
    return "deletion_not_carried";
  }

  const existing = await target.get(key);
  if (existing === null) {
    if ((await createExactly(target, key, bytes)) !== null) return "copied";
    // Somebody created it between our read and our write. Theirs stays.
    if (await holds(target, key, bytes)) return "same";
  } else if (sameBytes(bytes, await existing.arrayBuffer())) {
    return "same";
  }
  if (noteIdOfKey(key) === null) return "left";
  return await keepBeside(target, options.rows, key, bytes);
}

export interface CatchUpCounts {
  /** Listed objects changed since the last check began, and so read. */
  checked: number;
  copied: number;
  keptBeside: number;
  tooLarge: number;
  failed: number;
  /** Notes with every numbered name already taken by other versions. */
  noRoom: number;
  /** Late versions of an id key no live row holds, so nobody could open them. */
  noRow: number;
}

/**
 * One listed page: read what changed since `since`, a bounded wave at a time.
 *
 * Unlike the move's own page, a failure here does not fail the page: each key
 * is independent, the next pass lists again, and stopping at the first error
 * would leave every later key on the page for a pass that might not come.
 */
export async function catchUpPage(options: {
  source: CatchUpStore;
  target: CatchUpStore;
  rows: CatchUpRows;
  objects: readonly CatchUpListed[];
  since: number;
  byteCap: number;
  maxWidth: number;
  byteBudget?: number;
}): Promise<CatchUpCounts> {
  const counts: CatchUpCounts = {
    checked: 0,
    copied: 0,
    keptBeside: 0,
    tooLarge: 0,
    failed: 0,
    noRoom: 0,
    noRow: 0,
  };
  const changed = options.objects.filter((object) => changedSince(object, options.since));
  const waves = planReconcileWaves(changed, {
    maxWidth: options.maxWidth,
    byteBudget: options.byteBudget ?? Number.POSITIVE_INFINITY,
  });
  for (const wave of waves) {
    const settled = await Promise.allSettled(
      wave.map((object) =>
        catchUpObject({
          source: options.source,
          target: options.target,
          rows: options.rows,
          key: object.key,
          byteCap: options.byteCap,
        }),
      ),
    );
    for (const result of settled) {
      counts.checked += 1;
      if (result.status === "rejected") {
        counts.failed += 1;
        continue;
      }
      if (result.value === "copied") counts.copied += 1;
      else if (result.value === "kept_beside") counts.keptBeside += 1;
      else if (result.value === "too_large") counts.tooLarge += 1;
      else if (result.value === "no_room") counts.noRoom += 1;
      else if (result.value === "no_row") counts.noRow += 1;
    }
  }
  return counts;
}
