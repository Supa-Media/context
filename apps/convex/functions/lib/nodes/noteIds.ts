/**
 * Stable note ids and the id-keyed copy of each note (phase "copy" of the move
 * from path keys to id keys; `apps/mcp/src/moves/idCopyPage.js` copies, this
 * file says what a copy is and when one is still true).
 *
 * A `nodes` row gets a `noteId` the moment it is inserted, and keeps it for as
 * long as the note is that note: a queued move carries it to the destination
 * (`carryIdentity`). The body of a note is then copied to `notes/<noteId>.md`
 * (or `files/<noteId><ext>` for anything else), and the row records the copy
 * in `idCopy`, with the SOURCE etag it was made from. A copy is fresh only
 * while the row's etag still equals that one, so an edit makes it stale
 * without anything having to find the copy.
 *
 * Nothing reads the copies yet. Paths stay the keys people use.
 */

import type { Doc } from "../../../_generated/dataModel";

/** Attachments above this are not copied: reported as failed `too_large`, never read into memory. */
export const ID_COPY_MAX_BYTES = 20 * 1024 * 1024;

/** Rows one copy page reads from the index (fresh rows included), and the stale ones it names at most. */
export const COPY_SCAN = 1_000;
export const COPY_PAGE = 200;
/** Rows one backfill mutation assigns ids to. */
export const BACKFILL_BATCH = 500;
/** Items one id-copy ticket may name, as many as the mover accepts (`ID_ITEMS_MAX` there). */
export const ID_ITEMS_MAX = 500;
/** Failed items kept, path-free, per pass. */
export const FAILURES_MAX = 20;
/** Consecutive failed pages before the copy is shown as failed. */
export const COPY_STREAK_MAX = 3;
export const COPY_RETRY_MS = 30_000;
/** A page holds the lease this long; the mover's own page timeout is shorter. */
export const COPY_LEASE_MS = 6 * 60_000;
/** Lanes and bytes in flight for a page run in this action (the mover uses its own). */
export const ID_LANES = 6;
export const ID_BYTE_BUDGET = 16 * 1024 * 1024;

/** Fixed, path-free labels. */
export const COPY_FAILED_LABEL = "Copying notes to their id keys failed; retrying";
export const COPY_STUCK_LABEL = "Copying notes to their id keys keeps failing; restart it once storage answers";
export const CHECK_FAILED_LABEL = "Checking the id copies failed; start the check again";

/** Why one item was not copied: the mover's reasons, or ours. */
export const COPY_REASONS = new Set(["too_large", "changed", "missing", "copy_failed", "verify_failed", "no_answer", "no_etag"]);

export interface NoteIdItem {
  path: string;
  key: string;
  etag: string;
  size?: number;
}

/**
 * A UUIDv7: 48 bits of milliseconds, then random bits, so ids sort roughly by
 * creation and never repeat in practice. Built from Web Crypto, which is what
 * the Convex runtime and the test runtime both have.
 */
export function newNoteId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let millis = Math.floor(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = millis % 256;
    millis = Math.floor(millis / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The id key a note's body is copied to. `.md` is a note; anything else keeps
 * its lowercased extension (a name's last dot after its first character, as
 * `path.extname` reads it), and a name with none keeps none.
 */
export function idKeyFor(noteId: string, path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : "";
  return extension === ".md" ? `notes/${noteId}.md` : `files/${noteId}${extension}`;
}

/**
 * Whether the copy the row records was made from the version the row has now,
 * and says which version of the key holds it (`keyEtag`). A record without the
 * key's etag cannot tell a copy from a racing write at the key, so it is never
 * trusted: the next pass copies it again and records one.
 */
export function copyMatches(row: Pick<Doc<"nodes">, "etag" | "idCopy">): boolean {
  return (
    row.idCopy !== undefined &&
    row.etag !== undefined &&
    row.idCopy.etag === row.etag &&
    typeof row.idCopy.keyEtag === "string" &&
    row.idCopy.keyEtag !== ""
  );
}

/** A live file whose copy is still true: the only rows a copy is not owed for. */
export function copyIsFresh(row: Pick<Doc<"nodes">, "kind" | "goneAt" | "etag" | "idCopy">): boolean {
  return row.kind === "file" && row.goneAt === undefined && copyMatches(row);
}

/** Whether a row is too big to copy through the mover: reported as failed `too_large`. */
export function tooLarge(size: number | undefined): boolean {
  return (size ?? 0) > ID_COPY_MAX_BYTES;
}
