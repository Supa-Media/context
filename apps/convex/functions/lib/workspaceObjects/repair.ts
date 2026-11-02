/**
 * Settling what a workspace read from its object disagrees with its bucket
 * about, one key at a time (owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * Only for a workspace whose home is `object`: the object is the truth there
 * and the bucket is the backup copy written behind. Until 2026-11-02 09:37 a
 * conditional delete in such a workspace (collaboration's erase, purge and
 * cleanups) took the object's copy out unconditionally and then sent the
 * object's etag to the bucket, where it never matches (the two stores hash
 * differently), so the bucket kept every key an erase removed. Rarely, the
 * same flaw removed the object's copy of a key a newer save had just written.
 * A key the bucket holds and the object lacks is therefore one of three
 * things, and only the live editing history in the object can say which:
 *
 * - `bucketNewer`: the object still uses it, so its copy was lost. Restored
 *   into the object, only where the object still has none.
 * - `eraseNotApplied`: the document it belongs to is gone from the object, so
 *   an erase or purge removed it and the bucket missed the delete. Deleted
 *   from the bucket, on the etag read, because customer deletion must reach
 *   the backup too.
 * - `olderRevision`: a saved version the object's document no longer names.
 *   Those stay in the bucket alone by design; nothing to do.
 *
 * A note's text (`notes/<noteId>.md`) the object lacks is `bucketNewer` when a
 * live tree row still reads that key: until 2026-11-02 the app's console built
 * its store from a binding naming no workspace, so a note it made or saved in
 * an object-home workspace went to the bucket alone. With no live row, or no
 * way to ask, it is `unsure`: a removed note's text is not this tool's to
 * bring back or delete.
 *
 * A key both hold with different bytes is `objectNewer` when the object's copy
 * was written later (the bucket's write behind failed), and the bucket is
 * brought up to date; `bucketNewer` only when the bucket's copy is later by
 * more than a write behind could lag, and the object takes it. Anything this
 * cannot place is `unsure` and left alone.
 *
 * Nothing here returns a key, a path or a body; the caller reports counts.
 */

import { isWorkspaceObjectKey } from "../../../../mcp/src/workspaceStore/api.js";
import { OBJECT_PREFIXES, currentNames, historyPart, keyShape, revisionOf, type BodyStore, type StoredObject, type WalkCursor } from "./bodies";

const HISTORY_ROOT = ".context/collaboration/v1/";
/** The longest a write behind may trail the object's write; a bucket copy later than this is a write the object missed. */
export const WRITE_BEHIND_LAG_MS = 60_000;

export type RepairClass = "same" | "objectNewer" | "bucketNewer" | "eraseNotApplied" | "olderRevision" | "unsure";

export interface RepairCounts {
  listed: number;
  same: number;
  objectNewer: number;
  bucketNewer: number;
  eraseNotApplied: number;
  olderRevision: number;
  unsure: number;
  /** Written into the object (`bucketNewer`). */
  restored: number;
  /** Deleted from the bucket (`eraseNotApplied`). */
  erased: number;
  /** Written into the bucket (`objectNewer`). */
  backedUp: number;
  /** A fix refused because the key changed after it was read: left for the next run. */
  raced: number;
  failed: number;
}

export const emptyRepairCounts = (): RepairCounts => ({
  listed: 0,
  same: 0,
  objectNewer: 0,
  bucketNewer: 0,
  eraseNotApplied: 0,
  olderRevision: 0,
  unsure: 0,
  restored: 0,
  erased: 0,
  backedUp: 0,
  raced: 0,
  failed: 0,
});

type Uploaded = StoredObject & { uploaded?: Date | number | string };

function uploadedAt(object: StoredObject): number | null {
  const raw = (object as Uploaded).uploaded;
  if (raw === undefined || raw === null) return null;
  const at = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(at) && at > 0 ? at : null;
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function parsed(bytes: ArrayBuffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The document a history key belongs to, from the key alone: `documents/<id>.json`, `documents/<id>/…`, `revisions/<id>/…`. */
export function documentOfKey(key: string): string | null {
  if (!key.startsWith(HISTORY_ROOT)) return null;
  const [top, id] = key.slice(HISTORY_ROOT.length).split("/");
  if ((top !== "documents" && top !== "revisions") || !id) return null;
  return top === "documents" && id.endsWith(".json") ? id.slice(0, -".json".length) : id;
}

const stateKey = (documentId: string) => `${HISTORY_ROOT}documents/${documentId}.json`;

/** What the object's live editing history says about one document, read once per document per `Facts`. */
export class Facts {
  private readonly states = new Map<string, Promise<Set<string> | null>>();
  private readonly lives = new Map<string, Promise<boolean>>();
  /**
   * `readsNote` answers whether a live tree row reads a `notes/` key (the control plane's rows); without it a missing
   * note text is never placed.
   */
  constructor(
    private readonly object: BodyStore,
    private readonly readsNote: ((key: string) => Promise<boolean>) | null = null,
  ) {}

  /** Whether a live row still reads this note text; `null` when nobody can say. */
  async noteRead(key: string): Promise<boolean | null> {
    return this.readsNote === null ? null : await this.readsNote(key);
  }

  /** The revision names the object's state for `documentId` points at, or `null` when the object holds no state. */
  names(documentId: string): Promise<Set<string> | null> {
    let found = this.states.get(documentId);
    if (found === undefined) {
      found = (async () => {
        const state = await this.object.get(stateKey(documentId));
        if (state === null) return null;
        return currentNames(parsed(await state.arrayBuffer()));
      })();
      this.states.set(documentId, found);
    }
    return found;
  }

  /**
   * Whether the document still lives in the object: its state, or any of its saved versions or operations. A purge
   * removes the versions and operations before the state and an erase removes the head last, so a document with
   * none of them left was erased.
   */
  live(documentId: string): Promise<boolean> {
    let found = this.lives.get(documentId);
    if (found === undefined) {
      found = (async () => {
        if ((await this.names(documentId)) !== null) return true;
        for (const prefix of [`${HISTORY_ROOT}revisions/${documentId}/`, `${HISTORY_ROOT}documents/${documentId}/`]) {
          const page = await this.object.list({ prefix, limit: 1 });
          if ((page.objects ?? []).some((entry) => isWorkspaceObjectKey(entry.key))) return true;
        }
        return false;
      })();
      this.lives.set(documentId, found);
    }
    return found;
  }
}

/** The class of a key the bucket holds and the object does not. */
async function classifyMissing(key: string, bucketCopy: ArrayBuffer, facts: Facts): Promise<RepairClass> {
  if (key.startsWith("notes/")) return (await facts.noteRead(key)) === true ? "bucketNewer" : "unsure";
  const part = historyPart(key);
  if (part === "heads") {
    // An erase deletes a head after purging its document; no other step deletes one.
    const documentId = parsed(bucketCopy)?.documentId;
    if (typeof documentId !== "string" || documentId === "") return "unsure";
    return (await facts.live(documentId)) ? "bucketNewer" : "eraseNotApplied";
  }
  const documentId = documentOfKey(key);
  if (documentId === null) return "unsure";
  if (!(await facts.live(documentId))) return "eraseNotApplied";
  if (part === "documents") return "bucketNewer";
  if (part === "revisions") {
    const revision = revisionOf(key);
    const names = await facts.names(documentId);
    if (revision === null || names === null) return "unsure";
    return names.has(revision.name) ? "bucketNewer" : "olderRevision";
  }
  // An operation of a live document may have been cleaned up on purpose: not this tool's to judge.
  return "unsure";
}

/** The class of a key both sides hold with different bytes. */
function classifyDiffer(bucketCopy: StoredObject, objectCopy: StoredObject): RepairClass {
  const bucketAt = uploadedAt(bucketCopy);
  const objectAt = uploadedAt(objectCopy);
  if (bucketAt === null || objectAt === null) return "unsure";
  if (objectAt > bucketAt) return "objectNewer";
  if (bucketAt > objectAt + WRITE_BEHIND_LAG_MS) return "bucketNewer";
  return "unsure";
}

const contentTypeOf = (object: StoredObject): string | undefined => object.httpMetadata?.contentType ?? object.contentType ?? undefined;

/** One key classified and, when `apply`, settled. Answers the class and what was done. */
export async function settleKey(
  bucket: BodyStore,
  object: BodyStore,
  key: string,
  facts: Facts,
  apply: boolean,
): Promise<{ verdict: RepairClass; done: "restored" | "erased" | "backedUp" | "raced" | null }> {
  const [bucketCopy, objectCopy] = await Promise.all([bucket.get(key), object.get(key)]);
  if (bucketCopy === null) return { verdict: "same", done: null };
  const bucketBytes = await bucketCopy.arrayBuffer();
  let verdict: RepairClass;
  if (objectCopy === null) verdict = await classifyMissing(key, bucketBytes, facts);
  else if (sameBytes(bucketBytes, await objectCopy.arrayBuffer())) return { verdict: "same", done: null };
  else verdict = classifyDiffer(bucketCopy, objectCopy);
  if (!apply) return { verdict, done: null };
  const contentType = contentTypeOf(bucketCopy);
  if (verdict === "bucketNewer") {
    // Only over the object's copy as it was read, or where it still has none: a save meanwhile wins.
    const onlyIf = objectCopy === null || typeof objectCopy.etag !== "string" ? { absent: true } : { etagMatches: objectCopy.etag };
    const written = await object.put(key, bucketBytes, { ...(contentType ? { contentType } : {}), onlyIf });
    return { verdict, done: written === null ? "raced" : "restored" };
  }
  if (verdict === "eraseNotApplied") {
    if (typeof bucketCopy.etag !== "string") return { verdict, done: "raced" };
    const removed = await bucket.delete(key, { onlyIf: { etagMatches: bucketCopy.etag } });
    return { verdict, done: removed === null ? "raced" : "erased" };
  }
  if (verdict === "objectNewer" && objectCopy !== null) {
    const bytes = await objectCopy.arrayBuffer();
    const objectType = contentTypeOf(objectCopy);
    const onlyIf = typeof bucketCopy.etag === "string" ? { etagMatches: bucketCopy.etag } : undefined;
    const written = await bucket.put(key, bytes, { ...(objectType ? { contentType: objectType } : {}), ...(onlyIf ? { onlyIf } : {}) });
    return { verdict, done: written === null ? "raced" : "backedUp" };
  }
  return { verdict, done: null };
}

/**
 * One page of settling a workspace: up to `limit` bucket keys from `at`, `width` at a time. Answers the counts, each
 * non-`same` class by `<class>#<key shape>`, and the next cursor, `null` when the workspace is done.
 */
export async function repairPage(
  bucket: BodyStore,
  object: BodyStore,
  { at, limit, width = 8, apply, facts, onFailure }: { at: WalkCursor; limit: number; width?: number; apply: boolean; facts: Facts; onFailure?: (error: unknown) => void },
): Promise<{ counts: RepairCounts; shapes: Record<string, number>; next: WalkCursor | null }> {
  const counts = emptyRepairCounts();
  const shapes: Record<string, number> = {};
  const prefix = OBJECT_PREFIXES[at.prefix];
  if (prefix === undefined) return { counts, shapes, next: null };
  const page = await bucket.list({ prefix, ...(at.cursor ? { cursor: at.cursor } : {}), limit });
  const keys = (page.objects ?? []).map((entry) => entry.key).filter(isWorkspaceObjectKey);
  counts.listed = keys.length;
  for (let start = 0; start < keys.length; start += width) {
    await Promise.all(
      keys.slice(start, start + width).map(async (key) => {
        try {
          const { verdict, done } = await settleKey(bucket, object, key, facts, apply);
          counts[verdict] += 1;
          if (done !== null) counts[done] += 1;
          if (verdict !== "same") {
            const label = `${verdict}#${keyShape(key)}`;
            shapes[label] = (shapes[label] ?? 0) + 1;
          }
        } catch (error) {
          counts.failed += 1;
          onFailure?.(error);
        }
      }),
    );
  }
  const next: WalkCursor | null =
    page.truncated === true && typeof page.cursor === "string"
      ? { prefix: at.prefix, cursor: page.cursor }
      : at.prefix + 1 < OBJECT_PREFIXES.length
        ? { prefix: at.prefix + 1 }
        : null;
  return { counts, shapes, next };
}
