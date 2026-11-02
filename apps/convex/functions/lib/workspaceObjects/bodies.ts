/**
 * Copying and comparing a workspace's note bodies between its bucket and its
 * workspace object (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * The keys are the ones the object holds (`isWorkspaceObjectKey`): every
 * `notes/<noteId>.md` and everything under `.context/collaboration/`. Files and
 * Tex keys are not touched here.
 *
 * The copy never overwrites a newer write. While the workspace is `dual`,
 * every save is mirrored into the object as it lands; a copy made from an
 * older read must not undo that. So each key is written only on a condition
 * taken before the bucket was read: absent if the object had no copy, else
 * the object's etag then. A mirrored write in between changes that etag and
 * the copy is refused (`raced`). A note deleted from the bucket while it was
 * being copied is deleted from the object again, on the etag just written.
 *
 * Bytes are compared, never etags: a managed bucket's etag is of the sealed
 * bytes, the object's of the plain ones.
 *
 * Nothing here returns a key, a path or a body; the callers report counts.
 */

import { isWorkspaceObjectKey } from "../../../../mcp/src/workspaceStore/api.js";

/** The prefixes a workspace object holds, walked in this order. */
export const OBJECT_PREFIXES = ["notes/", ".context/collaboration/"] as const;

const HISTORY_ROOT = ".context/collaboration/v1/";
const REVISIONS_PREFIX = `${HISTORY_ROOT}revisions/`;

/** A revision key's document id and revision name, or `null` for any other key. */
export function revisionOf(key: string): { documentId: string; name: string } | null {
  if (!key.startsWith(REVISIONS_PREFIX) || !key.endsWith(".json")) return null;
  const rest = key.slice(REVISIONS_PREFIX.length, -".json".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || rest.indexOf("/", slash + 1) !== -1) return null;
  return { documentId: rest.slice(0, slash), name: rest.slice(slash + 1) };
}

/** The revision names a document's state points at: its accepted one and any pending one. */
export function currentNames(state: unknown): Set<string> {
  const names = new Set<string>();
  if (state && typeof state === "object") {
    const record = state as { revision?: unknown; pending?: { revision?: unknown } | null };
    if (typeof record.revision === "string") names.add(record.revision);
    if (record.pending && typeof record.pending.revision === "string") names.add(record.pending.revision);
  }
  return names;
}

/**
 * Whether the workspace object holds `key`. Every note text and history key,
 * except a revision its document's state no longer names: older revisions stay
 * in the bucket, read only as an offline-merge base (decided by the owner,
 * 2026-11-01). The state is read from the bucket, once per document per
 * `cache`; a revision of a document with no readable state is not held.
 */
export function objectHolds(bucket: BodyStore, cache = new Map<string, Promise<Set<string> | null>>()) {
  const namesOf = (documentId: string) => {
    let names = cache.get(documentId);
    if (names === undefined) {
      names = (async () => {
        const state = await bucket.get(`${HISTORY_ROOT}documents/${documentId}.json`);
        if (state === null) return null;
        try {
          return currentNames(JSON.parse(new TextDecoder().decode(await state.arrayBuffer())));
        } catch {
          return null;
        }
      })();
      cache.set(documentId, names);
    }
    return names;
  };
  return async (key: string): Promise<boolean> => {
    if (!isWorkspaceObjectKey(key)) return false;
    const revision = revisionOf(key);
    if (revision === null) return true;
    return (await namesOf(revision.documentId))?.has(revision.name) === true;
  };
}

/** `items` whose `test` answers true, tested `width` at a time, in order. */
async function filterInWaves<T>(items: T[], width: number, test: (item: T) => Promise<boolean>): Promise<T[]> {
  const kept: T[] = [];
  for (let start = 0; start < items.length; start += width) {
    const slice = items.slice(start, start + width);
    const answers = await settled(slice.map(test));
    slice.forEach((item, index) => {
      if (answers[index]) kept.push(item);
    });
  }
  return kept;
}

export interface StoredObject {
  etag?: string;
  contentType?: string;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BodyStore {
  get(key: string): Promise<StoredObject | null>;
  head?(key: string): Promise<{ etag?: string } | null | undefined>;
  put(key: string, value: ArrayBuffer | Uint8Array, options?: Record<string, unknown>): Promise<{ etag?: string } | null>;
  delete(key: string, options?: Record<string, unknown>): Promise<unknown>;
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects?: Array<{ key: string; size?: number }>;
    truncated?: boolean;
    cursor?: string;
  }>;
}

export interface CopyCounts {
  listed: number;
  copied: number;
  same: number;
  raced: number;
  goneMeanwhile: number;
  wouldCopy: number;
  failed: number;
  /** Revisions their document no longer names: left in the bucket, never copied. */
  olderRevisions: number;
  /** Of those, copies an earlier run had put in the object, taken out again. */
  removedOlder: number;
}

export const emptyCopyCounts = (): CopyCounts => ({ listed: 0, copied: 0, same: 0, raced: 0, goneMeanwhile: 0, wouldCopy: 0, failed: 0, olderRevisions: 0, removedOlder: 0 });

/** `more`'s counts added into `into`, field by field. */
export function addCounts<T extends object>(into: T, more: T): T {
  const target = into as Record<string, number>;
  for (const [key, value] of Object.entries(more as Record<string, number>)) target[key] = (target[key] ?? 0) + value;
  return into;
}

/** Where a walk of one workspace's keys stands: which prefix, and the listing cursor inside it. */
export interface WalkCursor {
  prefix: number;
  cursor?: string;
}

const contentTypeOf = (object: StoredObject): string | undefined => object.httpMetadata?.contentType ?? object.contentType ?? undefined;

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** Whether `key` is there: a metadata read where the store answers one, else a read. */
async function present(store: BodyStore, key: string): Promise<boolean> {
  const head = typeof store.head === "function" ? await store.head(key) : undefined;
  if (head !== undefined) return head !== null;
  return (await store.get(key)) !== null;
}

/** Runs `work` over `items`, `width` at a time. */
async function inWaves<T>(items: T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  for (let start = 0; start < items.length; start += width) await settled(items.slice(start, start + width).map(work));
}

/** Every promise run to its end before the first failure is thrown: none left in flight behind a rejection. */
async function settled<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/**
 * A key described without saying it: which part it is in, how long it is and
 * what kind of characters it holds. A failure that only some keys hit carries
 * this, so the public log can tell what those keys have in common.
 */
export function keyShape(key: string): string {
  const part = key.startsWith("notes/") ? "notes" : (historyPart(key) ?? "elsewhere");
  const length = key.length < 64 ? "<64" : key.length < 256 ? "<256" : key.length < 1024 ? "<1024" : ">=1024";
  const chars = /^[A-Za-z0-9._/-]*$/.test(key)
    ? "plain"
    : /[^\x00-\x7f]/.test(key)
      ? "nonascii"
      : /[\x00-\x1f\x7f]/.test(key)
        ? "control"
        : /^[A-Za-z0-9._/ -]*$/.test(key)
          ? "spaces"
          : "symbols";
  return `${part}/${length}/${chars}`;
}

/** `work`, with any failure it throws marked with the shape of the key it was about. */
async function aboutKey<T>(key: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error !== null && typeof error === "object" && !("keyShape" in error)) {
      try {
        (error as { keyShape?: string }).keyShape = keyShape(key);
      } catch {
        // A frozen error keeps no shape; its reason still says what failed.
      }
    }
    throw error;
  }
}

/** One key copied from the bucket into the object, by the rule in the header. */
export function copyKey(bucket: BodyStore, object: BodyStore, key: string, dryRun: boolean): Promise<keyof CopyCounts> {
  return aboutKey(key, () => copyOne(bucket, object, key, dryRun));
}

async function copyOne(bucket: BodyStore, object: BodyStore, key: string, dryRun: boolean): Promise<keyof CopyCounts> {
  // The object's state BEFORE the bucket is read: the condition the write is made on.
  const before = await object.get(key);
  const source = await bucket.get(key);
  if (source === null) return "goneMeanwhile";
  const bytes = await source.arrayBuffer();
  if (before !== null && sameBytes(await before.arrayBuffer(), bytes)) return "same";
  if (dryRun) return "wouldCopy";
  const contentType = contentTypeOf(source);
  const onlyIf = before === null || typeof before.etag !== "string" ? { absent: true } : { etagMatches: before.etag };
  const written = await object.put(key, bytes, { ...(contentType ? { contentType } : {}), onlyIf });
  if (written === null) return "raced";
  // Deleted from the bucket while it was being copied: take the copy back out, unless something newer is there.
  if (!(await present(bucket, key))) {
    if (typeof written.etag === "string") await object.delete(key, { onlyIf: { etagMatches: written.etag } });
    return "goneMeanwhile";
  }
  return "copied";
}

/**
 * One page of a workspace's copy: up to `limit` bucket keys from `at`, copied
 * `width` at a time. Answers the counts and the next cursor, `null` when the
 * workspace is done.
 */
export async function copyPage(
  bucket: BodyStore,
  object: BodyStore,
  {
    at,
    limit,
    width = 8,
    dryRun,
    onFailure,
  }: { at: WalkCursor; limit: number; width?: number; dryRun: boolean; onFailure?: (error: unknown) => void },
): Promise<{ counts: CopyCounts; next: WalkCursor | null }> {
  const counts = emptyCopyCounts();
  const prefix = OBJECT_PREFIXES[at.prefix];
  if (prefix === undefined) return { counts, next: null };
  const page = await bucket.list({ prefix, ...(at.cursor ? { cursor: at.cursor } : {}), limit });
  const listed = (page.objects ?? []).map((entry) => entry.key).filter(isWorkspaceObjectKey);
  counts.listed = listed.length;
  const keys = await filterInWaves(listed, width, objectHolds(bucket));
  counts.olderRevisions = listed.length - keys.length;
  if (!dryRun && keys.length < listed.length) {
    // An older revision an earlier copy put in the object comes out again, on the etag seen: a reader that
    // misses it there reads it from the bucket.
    const kept = new Set(keys);
    await inWaves(
      listed.filter((key) => !kept.has(key)),
      width,
      async (key) => {
        try {
          const held = await object.get(key);
          if (held === null) return;
          await object.delete(key, typeof held.etag === "string" ? { onlyIf: { etagMatches: held.etag } } : {});
          counts.removedOlder += 1;
        } catch (error) {
          counts.failed += 1;
          onFailure?.(error);
        }
      },
    );
  }
  await inWaves(keys, width, async (key) => {
    try {
      counts[await copyKey(bucket, object, key, dryRun)] += 1;
    } catch (error) {
      counts.failed += 1;
      onFailure?.(error);
    }
  });
  const next: WalkCursor | null =
    page.truncated === true && typeof page.cursor === "string"
      ? { prefix: at.prefix, cursor: page.cursor }
      : at.prefix + 1 < OBJECT_PREFIXES.length
        ? { prefix: at.prefix + 1 }
        : null;
  return { counts, next };
}

export interface BodyParity {
  bucketKeys: number;
  objectKeys: number;
  missingInObject: number;
  extraInObject: number;
  differ: number;
}

export const emptyBodyParity = (): BodyParity => ({ bucketKeys: 0, objectKeys: 0, missingInObject: 0, extraInObject: 0, differ: 0 });

/** Where a paged comparison stands: walking the bucket's keys (side 0), then the object's (side 1). */
export interface ParityCursor {
  side: 0 | 1;
  prefix: number;
  cursor?: string;
}

type Verdict = "same" | "missingInObject" | "extraInObject" | "differ" | "neither";

function verdictOf(bucket: BodyStore, object: BodyStore, key: string): Promise<Verdict> {
  return aboutKey(key, () => compareOne(bucket, object, key));
}

async function compareOne(bucket: BodyStore, object: BodyStore, key: string): Promise<Verdict> {
  const [left, right] = await settled([bucket.get(key), object.get(key)]);
  if (left === null && right === null) return "neither";
  if (right === null) return "missingInObject";
  if (left === null) return "extraInObject";
  return sameBytes(await left.arrayBuffer(), await right.arrayBuffer()) ? "same" : "differ";
}

/**
 * One page of comparing a workspace's bodies. Side 0 walks the bucket and
 * reads each key from both; side 1 walks the object and only looks for keys
 * the bucket lacks. Each disagreement is asked again after `recheckMs` (a save
 * in flight is mirrored by then) and counted only if it still stands.
 */
export async function parityPage(
  bucket: BodyStore,
  object: BodyStore,
  { at, limit, width = 8, recheckMs, sleep }: { at: ParityCursor; limit: number; width?: number; recheckMs: number; sleep: (ms: number) => Promise<void> },
): Promise<{ parity: BodyParity; next: ParityCursor | null }> {
  const parity = emptyBodyParity();
  const prefix = OBJECT_PREFIXES[at.prefix];
  if (prefix === undefined) return { parity, next: null };
  const walked = at.side === 0 ? bucket : object;
  const page = await walked.list({ prefix, ...(at.cursor ? { cursor: at.cursor } : {}), limit });
  const listed = (page.objects ?? []).map((entry) => entry.key).filter(isWorkspaceObjectKey);
  // The bucket's older revisions are not the object's to hold; the object's own keys are all compared.
  const keys = at.side === 0 ? await filterInWaves(listed, width, objectHolds(bucket)) : listed;
  if (at.side === 0) parity.bucketKeys = keys.length;
  else parity.objectKeys = keys.length;
  const suspects: string[] = [];
  await inWaves(keys, width, async (key) => {
    if (at.side === 0) {
      if ((await verdictOf(bucket, object, key)) !== "same") suspects.push(key);
    } else if (!(await present(bucket, key))) suspects.push(key);
  });
  if (suspects.length > 0) {
    await sleep(recheckMs);
    // Asked again with the state as it is now: a save meanwhile may have made a revision older.
    const holds = objectHolds(bucket);
    for (const key of suspects) {
      if (at.side === 0 && !(await holds(key))) continue;
      const verdict = await verdictOf(bucket, object, key);
      // Side 1 counts only what side 0 cannot see: a key the object holds and the bucket does not.
      if (at.side === 1 && verdict !== "extraInObject") continue;
      if (verdict === "missingInObject" || verdict === "extraInObject" || verdict === "differ") parity[verdict] += 1;
    }
  }
  let next: ParityCursor | null;
  if (page.truncated === true && typeof page.cursor === "string") next = { side: at.side, prefix: at.prefix, cursor: page.cursor };
  else if (at.prefix + 1 < OBJECT_PREFIXES.length) next = { side: at.side, prefix: at.prefix + 1 };
  else next = at.side === 0 ? { side: 1, prefix: 0 } : null;
  return { parity, next };
}

/** The bytes a workspace's object keys take in the bucket, from listings alone, stopping once past `cap`. */
/** Where counting a workspace's size stands: the prefix, the listing cursor in it, and the sums so far. */
export interface SizeCursor {
  prefix: number;
  cursor?: string;
  keys: number;
  bytes: number;
  /** Keys and bytes under each of `OBJECT_PREFIXES`, in order, and the largest single key's size. */
  byPrefix?: Array<{ keys: number; bytes: number }>;
  largest?: number;
  /** Editing history split by what it is (`historyPart`). */
  parts?: Record<string, PartCount>;
}

export interface PartCount {
  keys: number;
  bytes: number;
  largest: number;
}

/**
 * Which part of the editing history `key` is, by the layout in
 * `packages/collaboration/src/storage.js`: `heads`, `documents` (a current
 * document, `documents/<id>.json`), `operations` (`documents/<id>/operations/`),
 * `revisions`, `structural`, else `other`. `null` for a key outside the history.
 */
export function historyPart(key: string): string | null {
  const root = ".context/collaboration/v1/";
  if (!key.startsWith(".context/collaboration/")) return null;
  if (!key.startsWith(root)) return "other";
  const rest = key.slice(root.length);
  const [top, ...tail] = rest.split("/");
  if (top === "heads" || top === "revisions" || top === "structural") return top;
  if (top === "documents") {
    if (tail.length === 1) return "documents";
    if (tail[1] === "operations") return "operations";
  }
  return "other";
}

export interface SizeCount {
  keys: number;
  bytes: number;
  byPrefix: Array<{ keys: number; bytes: number }>;
  largest: number;
  parts: Record<string, PartCount>;
}

/**
 * Counts a workspace's object keys and bytes from listings, until `deadline`
 * or once past `cap`. Answers the sums and `next`, `null` when counting is
 * finished (all listed, or past the cap). A workspace with hundreds of
 * thousands of history keys takes many pages, so a run carries `next` on.
 */
export async function objectBytesPage(
  store: BodyStore,
  at: SizeCursor,
  cap: number,
  deadline: number,
): Promise<SizeCount & { next: SizeCursor | null }> {
  let { prefix, cursor, keys, bytes } = at;
  const byPrefix = OBJECT_PREFIXES.map((_, index) => ({ ...(at.byPrefix?.[index] ?? { keys: 0, bytes: 0 }) }));
  let largest = at.largest ?? 0;
  const parts: Record<string, PartCount> = Object.fromEntries(Object.entries(at.parts ?? {}).map(([name, count]) => [name, { ...count }]));
  const done = () => ({ keys, bytes, byPrefix, largest, parts, next: null });
  while (prefix < OBJECT_PREFIXES.length) {
    if (Date.now() >= deadline) return { keys, bytes, byPrefix, largest, parts, next: { prefix, ...(cursor ? { cursor } : {}), keys, bytes, byPrefix, largest, parts } };
    const page = await store.list({ prefix: OBJECT_PREFIXES[prefix], ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const entry of page.objects ?? []) {
      if (!isWorkspaceObjectKey(entry.key)) continue;
      const size = typeof entry.size === "number" ? entry.size : 0;
      const part = historyPart(entry.key);
      if (part !== null) {
        const count = (parts[part] ??= { keys: 0, bytes: 0, largest: 0 });
        count.keys += 1;
        count.bytes += size;
        if (size > count.largest) count.largest = size;
      }
      // Revisions are left out of the sum the cap is held to: only current ones are copied, one per
      // document beside its state, and telling them apart takes a read per document, not a listing.
      if (part === "revisions") continue;
      keys += 1;
      bytes += size;
      byPrefix[prefix]!.keys += 1;
      byPrefix[prefix]!.bytes += size;
      if (size > largest) largest = size;
    }
    if (bytes > cap) return done();
    if (page.truncated === true && typeof page.cursor === "string") cursor = page.cursor;
    else {
      prefix += 1;
      cursor = undefined;
    }
  }
  return done();
}

/** The whole count at once, for tests and small workspaces. */
export async function objectBytes(store: BodyStore, cap: number): Promise<{ keys: number; bytes: number }> {
  const { keys, bytes } = await objectBytesPage(store, { prefix: 0, keys: 0, bytes: 0 }, cap, Number.POSITIVE_INFINITY);
  return { keys, bytes };
}
