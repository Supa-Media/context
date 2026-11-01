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
}

export const emptyCopyCounts = (): CopyCounts => ({ listed: 0, copied: 0, same: 0, raced: 0, goneMeanwhile: 0, wouldCopy: 0, failed: 0 });

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
  for (let start = 0; start < items.length; start += width) await Promise.all(items.slice(start, start + width).map(work));
}

/** One key copied from the bucket into the object, by the rule in the header. */
export async function copyKey(bucket: BodyStore, object: BodyStore, key: string, dryRun: boolean): Promise<keyof CopyCounts> {
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
  { at, limit, width = 8, dryRun }: { at: WalkCursor; limit: number; width?: number; dryRun: boolean },
): Promise<{ counts: CopyCounts; next: WalkCursor | null }> {
  const counts = emptyCopyCounts();
  const prefix = OBJECT_PREFIXES[at.prefix];
  if (prefix === undefined) return { counts, next: null };
  const page = await bucket.list({ prefix, ...(at.cursor ? { cursor: at.cursor } : {}), limit });
  const keys = (page.objects ?? []).map((entry) => entry.key).filter(isWorkspaceObjectKey);
  counts.listed = keys.length;
  await inWaves(keys, width, async (key) => {
    try {
      counts[await copyKey(bucket, object, key, dryRun)] += 1;
    } catch {
      counts.failed += 1;
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

async function verdictOf(bucket: BodyStore, object: BodyStore, key: string): Promise<Verdict> {
  const [left, right] = await Promise.all([bucket.get(key), object.get(key)]);
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
  const keys = (page.objects ?? []).map((entry) => entry.key).filter(isWorkspaceObjectKey);
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
    for (const key of suspects) {
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
/** Where counting a workspace's size stands: the prefix, the listing cursor in it, and the sum so far. */
export interface SizeCursor {
  prefix: number;
  cursor?: string;
  keys: number;
  bytes: number;
}

/**
 * Counts a workspace's object keys and bytes from listings, until `deadline`
 * or once past `cap`. Answers the sum and `next`, `null` when counting is
 * finished (all listed, or past the cap). A workspace with hundreds of
 * thousands of history keys takes many pages, so a run carries `next` on.
 */
export async function objectBytesPage(
  store: BodyStore,
  at: SizeCursor,
  cap: number,
  deadline: number,
): Promise<{ keys: number; bytes: number; next: SizeCursor | null }> {
  let { prefix, cursor, keys, bytes } = at;
  while (prefix < OBJECT_PREFIXES.length) {
    if (Date.now() >= deadline) return { keys, bytes, next: { prefix, ...(cursor ? { cursor } : {}), keys, bytes } };
    const page = await store.list({ prefix: OBJECT_PREFIXES[prefix], ...(cursor ? { cursor } : {}), limit: 1000 });
    for (const entry of page.objects ?? []) {
      if (!isWorkspaceObjectKey(entry.key)) continue;
      keys += 1;
      bytes += typeof entry.size === "number" ? entry.size : 0;
    }
    if (bytes > cap) return { keys, bytes, next: null };
    if (page.truncated === true && typeof page.cursor === "string") cursor = page.cursor;
    else {
      prefix += 1;
      cursor = undefined;
    }
  }
  return { keys, bytes, next: null };
}

/** The whole count at once, for tests and small workspaces. */
export async function objectBytes(store: BodyStore, cap: number): Promise<{ keys: number; bytes: number }> {
  const { keys, bytes } = await objectBytesPage(store, { prefix: 0, keys: 0, bytes: 0 }, cap, Number.POSITIVE_INFINITY);
  return { keys, bytes };
}
