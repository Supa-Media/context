import {
  ATTACHMENT_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
} from "../../../mcp/src/store/index.js";

interface ReadableObject {
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
}): Promise<{ copied: number; changes: number }> {
  const sourceRead = await options.source.get(options.key);
  if (sourceRead === null) {
    if (options.listedFromTarget) {
      await options.target.delete(options.key);
      return { copied: 0, changes: 1 };
    }
    return { copied: 0, changes: 0 };
  }
  const bytes = await sourceRead.arrayBuffer();
  if (bytes.byteLength > options.byteCap) throw new Error("OBJECT_TOO_LARGE");
  const targetRead = await options.target.get(options.key);
  if (
    targetRead !== null &&
    sameBytes(bytes, await targetRead.arrayBuffer())
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
  await options.target.put(options.key, bytes, {
    contentType: options.key.toLowerCase().endsWith(".md")
      ? MARKDOWN_CONTENT_TYPE
      : ATTACHMENT_CONTENT_TYPE,
  });
  const verified = await options.target.get(options.key);
  if (verified === null || !sameBytes(bytes, await verified.arrayBuffer())) {
    throw new Error("VERIFY_FAILED");
  }
  return { copied: 1, changes: 1 };
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
