import {
  ATTACHMENT_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
  LOGICAL_DELETE_CONTENT_TYPE,
} from "../../../mcp/src/store/index.js";
import { isLogicalDeleteMarker } from "../../../mcp/src/store/logicalDelete.js";
import { canStream, streamObject } from "../../../mcp/src/store/s3Stream.js";

interface ReadableObject {
  contentType?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MigrationStore {
  get(key: string): Promise<ReadableObject | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options: { contentType: string },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** The half of a listed object the walk reads: its key, and its size if given. */
export interface MigrationListedObject {
  key: string;
  size?: number;
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

/** Reconcile one listed key without ever deleting it from the source. */
export async function reconcileMigrationObject(options: {
  source: MigrationStore;
  target: MigrationStore;
  key: string;
  listedFromTarget: boolean;
  byteCap: number;
  /**
   * Whether a destination key the source does not have may be deleted.
   *
   * Only when the destination is known to hold nothing but this move's own
   * writes — see `targetClaimed` on the migration row. A key in somebody's
   * bucket that Context did not put there is theirs, and is left alone.
   *
   * **Absent means keep.** The destination of a move out of managed storage is
   * a customer's own bucket, and the deletion this flag governs is not
   * recoverable. Absent is not `false` here any more than it is on
   * `storageBindings`' capability fields: it means nobody established that the
   * destination holds only this move's writes, and the honest answer to that
   * is to delete nothing. One call site passes it explicitly today; the
   * default is what the second one inherits.
   */
  deleteUnmatchedTarget?: boolean;
  /**
   * Narrows that deletion to keys under this prefix. A move out of managed
   * storage passes `.context/`: past a start-fresh bucket's one up-front
   * emptying, the only files it may remove are Context's own plumbing, so a
   * file the owner adds to their bucket mid-move is kept.
   */
  deleteOnlyUnder?: string;
  /**
   * Before writing over a destination file that differs, keep the old one as
   * `name (from your bucket).ext` — once. For a move merged into a bucket that
   * already held the customer's files, so a shared name loses neither.
   */
  keepTargetConflicts?: boolean;
}): Promise<{ copied: number; changes: number }> {
  const sourceRead = await options.source.get(options.key);
  if (sourceRead === null) {
    if (
      options.listedFromTarget &&
      options.deleteUnmatchedTarget === true &&
      (options.deleteOnlyUnder === undefined || options.key.startsWith(options.deleteOnlyUnder))
    ) {
      await options.target.delete(options.key);
      return { copied: 0, changes: 1 };
    }
    return { copied: 0, changes: 0 };
  }
  const bytes = await sourceRead.arrayBuffer();
  if (bytes.byteLength > options.byteCap) throw new Error("OBJECT_TOO_LARGE");
  const marker = sourceRead.contentType === LOGICAL_DELETE_CONTENT_TYPE ||
    (bytes.byteLength < 512 && isLogicalDeleteMarker(new TextDecoder().decode(bytes)));
  const targetRead = await options.target.get(options.key);
  // Read once: a stored body is a stream, and the conflict copy needs it too.
  const targetBytes = targetRead === null ? null : await targetRead.arrayBuffer();
  if (
    targetRead !== null &&
    targetBytes !== null &&
    (!marker || targetRead.contentType === LOGICAL_DELETE_CONTENT_TYPE) &&
    sameBytes(bytes, targetBytes)
  ) {
    /*
      Already identical, so there is nothing to write and nothing to verify.

      The read-back below exists to prove that a write landed intact. When no
      write happened, the read that just proved equality *is* that proof, and
      fetching the same bytes a second time only asks the question again. On a
      verification pass over an unchanged context that is every object in the
      bucket downloaded a third time for an answer already in hand — the single
      largest avoidable cost in a pass, because the passes that matter for
      cutover are exactly the ones where almost nothing has changed.
    */
    return { copied: 1, changes: 0 };
  }
  if (targetRead !== null && targetBytes !== null && options.keepTargetConflicts === true) {
    await keepConflictingTarget(options.target, options.key, targetBytes, targetRead.contentType);
  }
  await options.target.put(options.key, bytes, {
    contentType: marker
      ? LOGICAL_DELETE_CONTENT_TYPE
      : options.key.toLowerCase().endsWith(".md")
        ? MARKDOWN_CONTENT_TYPE
        : ATTACHMENT_CONTENT_TYPE,
  });
  const verified = await options.target.get(options.key);
  if (verified === null || (marker && verified.contentType !== LOGICAL_DELETE_CONTENT_TYPE) ||
      !sameBytes(bytes, await verified.arrayBuffer())) {
    throw new Error("VERIFY_FAILED");
  }
  return { copied: 1, changes: 1 };
}

/** `notes/plan.md` becomes `notes/plan (from your bucket).md`. */
export function conflictCopyKey(key: string): string {
  const slash = key.lastIndexOf("/");
  const dot = key.lastIndexOf(".");
  const suffix = " (from your bucket)";
  return dot > slash + 1 ? `${key.slice(0, dot)}${suffix}${key.slice(dot)}` : `${key}${suffix}`;
}

async function keepConflictingTarget(
  target: MigrationStore,
  key: string,
  bytes: ArrayBuffer,
  contentType: string | undefined,
): Promise<void> {
  if (contentType === LOGICAL_DELETE_CONTENT_TYPE) return;
  const copyKey = conflictCopyKey(key);
  if ((await target.get(copyKey)) !== null) return;
  await target.put(copyKey, bytes, {
    contentType: copyKey.toLowerCase().endsWith(".md") ? MARKDOWN_CONTENT_TYPE : ATTACHMENT_CONTENT_TYPE,
  });
  const verified = await target.get(copyKey);
  if (verified === null || !sameBytes(bytes, await verified.arrayBuffer())) {
    throw new Error("VERIFY_FAILED");
  }
}

/**
 * Split a listed page into waves that are bounded by *both* count and bytes.
 *
 * Count alone is the wrong bound on its own. Reconciling one object holds the
 * source body and the target body in memory at the same time, and the byte cap
 * admits objects of 25MB — so a wave of sixteen bounded only by count is a wave
 * that can be holding hundreds of megabytes, and the action dies on the one
 * page that happened to list the attachments rather than the notes.
 *
 * Bytes alone is the wrong bound too: a page of small notes carries almost no
 * weight and would open an unbounded number of sockets.
 *
 * So a wave closes when either bound would be exceeded. An object bigger than
 * the whole budget still gets a wave, alone — the split only ever happens with
 * something already in the wave, so a large object can never be starved out of
 * being reconciled. A listing without sizes (an adapter that does not report
 * them) contributes zero bytes and is bounded by the count alone, which is the
 * behaviour to degrade to rather than refusing to walk.
 *
 * The blind spot, documented rather than hidden: the budget weighs the size the
 * *listing* reported, and on the `verify_target` pass the listing is the
 * destination's. An object that has since grown in the source is therefore
 * budgeted at its old size. It is bounded — no single object may exceed the byte
 * cap, whatever the listing said, because `reconcileMigrationObject` measures
 * the bytes it actually read — but a wave of keys that are all small in the
 * destination and all near the cap in the source would be heavier than the
 * budget intends. Reaching it needs a whole wave of adjacent keys replaced by
 * near-cap attachments since the copy; the three phases that list the *source*,
 * which is where the walk spends nearly all of its time, weigh the same bytes
 * they are about to read.
 */
export function planReconcileWaves<T extends MigrationListedObject>(
  objects: readonly T[],
  limits: { maxWidth: number; byteBudget: number },
): T[][] {
  const maxWidth = Math.max(1, Math.floor(limits.maxWidth));
  const waves: T[][] = [];
  let wave: T[] = [];
  let waveBytes = 0;
  for (const object of objects) {
    const size =
      typeof object.size === "number" && Number.isFinite(object.size)
        ? Math.max(0, object.size)
        : 0;
    if (
      wave.length > 0 &&
      (wave.length >= maxWidth || waveBytes + size > limits.byteBudget)
    ) {
      waves.push(wave);
      wave = [];
      waveBytes = 0;
    }
    wave.push(object);
    waveBytes += size;
  }
  if (wave.length > 0) waves.push(wave);
  return waves;
}

/**
 * Reconcile one listed page, a bounded wave at a time.
 *
 * Every object on a page is independent of every other — separate keys, no
 * ordering between them — so awaiting them one at a time buys nothing and costs
 * a round trip each. A page of a hundred objects walked serially is a hundred
 * round trips laid end to end, which is what made a verification pass over a
 * twenty-thousand-object context take about an hour and put the whole job on a
 * timescale where an ordinary afternoon of editing could outrun it.
 *
 * Failure keeps the semantics the serial loop had: the page fails with the
 * error belonging to the *earliest listed* object that failed, whatever order
 * the responses happen to land in. Anything else would make the error a caller
 * sees depend on network timing — an `OBJECT_TOO_LARGE` surfacing ahead of a
 * transient failure that the serial walk would have hit first turns a page that
 * should be retried into a migration that is failed for good.
 *
 * Every wave is awaited to settlement before the error is raised, so a sibling
 * that is still in flight cannot reject into an empty stack after its page has
 * already been abandoned.
 */
export async function reconcileMigrationPage(options: {
  source: MigrationStore;
  target: MigrationStore;
  objects: readonly MigrationListedObject[];
  listedFromTarget: boolean;
  byteCap: number;
  maxWidth: number;
  byteBudget: number;
  deleteUnmatchedTarget?: boolean;
  deleteOnlyUnder?: string;
  keepTargetConflicts?: boolean;
}): Promise<{ copied: number; changes: number }> {
  let copied = 0;
  let changes = 0;
  const waves = planReconcileWaves(options.objects, {
    maxWidth: options.maxWidth,
    byteBudget: options.byteBudget,
  });
  for (const wave of waves) {
    const settled = await Promise.allSettled(
      wave.map((object) =>
        reconcileMigrationObject({
          source: options.source,
          target: options.target,
          key: object.key,
          listedFromTarget: options.listedFromTarget,
          byteCap: options.byteCap,
          deleteUnmatchedTarget: options.deleteUnmatchedTarget,
          deleteOnlyUnder: options.deleteOnlyUnder,
          keepTargetConflicts: options.keepTargetConflicts,
        }),
      ),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure !== undefined && failure.status === "rejected") {
      throw failure.reason;
    }
    for (const result of settled) {
      if (result.status === "fulfilled") {
        copied += result.value.copied;
        changes += result.value.changes;
      }
    }
  }
  return { copied, changes };
}

/**
 * Past the whole-object cap, an object is copied in parts
 * (`mcp/src/store/s3Stream.js`, project file `move-engine/plan.md` step D) —
 * up to this size, which one action copies well inside its ten minutes at a
 * pessimistic 10 MiB a second. Larger still fails as `OBJECT_TOO_LARGE`,
 * named, as every oversized object did before.
 */
export const STREAM_MAX_BYTES = 3 * 1024 ** 3;
/** The pace a streamed copy is planned at, to decide whether one more fits this action. */
const STREAM_PLANNED_BYTES_PER_SECOND = 10 * 1024 * 1024;
/** Streamed copies start only while the page's action has this much of its time left to spend. */
const STREAM_ACTION_BUDGET_MS = 6 * 60 * 1000;

/** The page ran out of its action's time between two large objects: run it again, nothing failed. */
export class PageContinues extends Error {
  constructor() {
    super("PAGE_CONTINUES");
  }
}

/** Objects this move cannot copy, named so the owner is shown which. */
export class ObjectsTooLarge extends Error {
  constructor(readonly keys: string[]) {
    super("OBJECT_TOO_LARGE");
  }
}

interface StreamingStore extends MigrationStore {
  head(key: string): Promise<{ etag: string; size?: number; copyOf?: string; contentType?: string } | null>;
  copy?(source: string, destination: string, options: Record<string, unknown>): Promise<{ etag?: string } | null>;
  managedEncryption?: { mode: string };
}

/** Whether a large object can be streamed from `source` into `target` at all. */
function streamable(source: unknown, target: unknown): boolean {
  if (!canStream(source) || !canStream(target)) return false;
  if (typeof (source as StreamingStore).head !== "function" || typeof (target as StreamingStore).head !== "function") return false;
  // A destination that seals what it is given needs the whole object to seal it.
  const sealing = (target as StreamingStore).managedEncryption?.mode;
  return sealing === undefined || sealing === "decrypting";
}

/** One object past the whole-object cap, reconciled as `reconcileMigrationObject` does, a part at a time. */
export async function reconcileLargeObject(options: {
  source: StreamingStore;
  target: StreamingStore;
  key: string;
  listedFromTarget: boolean;
  byteCap: number;
  deleteUnmatchedTarget?: boolean;
  deleteOnlyUnder?: string;
  keepTargetConflicts?: boolean;
}): Promise<{ copied: number; changes: number }> {
  const { source, target, key } = options;
  const from = await source.head(key);
  // Gone, or no longer large: the whole-object path decides, with its own rules.
  if (from === null || typeof from.size !== "number" || from.size <= options.byteCap) {
    return await reconcileMigrationObject(options);
  }
  if (from.size > STREAM_MAX_BYTES) throw new ObjectsTooLarge([key]);
  const there = await target.head(key);
  // Ours already: the same version, as its etag or as the stamp a copy in parts carries.
  if (there !== null && there.size === from.size && (there.etag === from.etag || there.copyOf === from.etag)) {
    return { copied: 1, changes: 0 };
  }
  if (there !== null && options.keepTargetConflicts === true) {
    const copyKey = conflictCopyKey(key);
    if ((await target.head(copyKey)) === null) {
      const kept = await target.copy?.(key, copyKey, {
        onlyIf: { absent: true },
        sourceOnlyIf: { etagMatches: there.etag },
        ...(typeof there.size === "number" ? { size: there.size } : {}),
        ...(there.contentType ? { contentType: there.contentType } : {}),
      });
      if (!kept && (await target.head(copyKey)) === null) throw new Error("VERIFY_FAILED");
    }
  }
  const streamed = await streamObject(source, target, key, {
    size: from.size,
    etag: from.etag,
    contentType: key.toLowerCase().endsWith(".md") ? MARKDOWN_CONTENT_TYPE : ATTACHMENT_CONTENT_TYPE,
  });
  // A sealed managed object is one encrypted piece: it cannot be opened a part at a time.
  if (streamed.state === "sealed") throw new ObjectsTooLarge([key]);
  // Edited mid-copy: nothing landed; the page is retried and copies the new version.
  if (streamed.state === "changed") throw new Error("SOURCE_CHANGED");
  const landed = await target.head(key);
  if (landed === null || landed.size !== from.size || landed.copyOf !== from.etag) throw new Error("VERIFY_FAILED");
  return { copied: 1, changes: 1 };
}

/**
 * One listed page of a whole-bucket move: each object past the cap streamed,
 * one at a time, then the rest through `reconcileMigrationPage`.
 *
 * An object no streamed copy can carry (a store that cannot stream, past
 * `STREAM_MAX_BYTES`) fails the page before anything on it is written, as every
 * oversized object did before. Large objects go first and start only while the
 * action has time for them; past that the page throws `PageContinues` and runs
 * again, where the copies already made are recognised by their stamp and skipped.
 */
export async function reconcileListedPage(
  options: Parameters<typeof reconcileMigrationPage>[0] & { startedAt?: number; now?: () => number },
): Promise<{ copied: number; changes: number }> {
  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();
  const isLarge = (object: MigrationListedObject) => typeof object.size === "number" && object.size > options.byteCap;
  const large = options.objects.filter(isLarge);
  const canStreamHere = streamable(options.source, options.target);
  const unstreamable = large.filter((object) => !canStreamHere || (object.size ?? 0) > STREAM_MAX_BYTES);
  if (unstreamable.length > 0) throw new ObjectsTooLarge(unstreamable.slice(0, 50).map((object) => object.key));

  // Large objects first, while the action is fresh; the first always starts, so
  // a page with one big object moves. A re-run skips the ones already copied.
  const result = { copied: 0, changes: 0 };
  let first = true;
  for (const object of large) {
    const planned = ((object.size ?? 0) / STREAM_PLANNED_BYTES_PER_SECOND) * 1000;
    if (!first && now() - startedAt + planned > STREAM_ACTION_BUDGET_MS) throw new PageContinues();
    first = false;
    const one = await reconcileLargeObject({
      source: options.source as StreamingStore,
      target: options.target as StreamingStore,
      key: object.key,
      listedFromTarget: options.listedFromTarget,
      byteCap: options.byteCap,
      deleteUnmatchedTarget: options.deleteUnmatchedTarget,
      deleteOnlyUnder: options.deleteOnlyUnder,
      keepTargetConflicts: options.keepTargetConflicts,
    });
    result.copied += one.copied;
    result.changes += one.changes;
  }
  // The rest of the page is bounded (a page of objects under the cap), but not
  // after a long stream: then the page runs again, past its finished copies.
  if (large.length > 0 && now() - startedAt > STREAM_ACTION_BUDGET_MS) throw new PageContinues();
  const small = await reconcileMigrationPage({ ...options, objects: options.objects.filter((object) => !isLarge(object)) });
  result.copied += small.copied;
  result.changes += small.changes;
  return result;
}
