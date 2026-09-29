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
 *  - Different in the new bucket: the late version is kept beside it as
 *    `name (saved during the move).ext`. We cannot tell which side is newer
 *    without trusting two providers' clocks against ours, and guessing wrong
 *    either way loses an edit; keeping both loses nothing.
 *  - A deletion in the old bucket is not carried: the note stays. A deleted
 *    note coming back is recoverable by deleting it again; a note deleted by a
 *    stale writer is not recoverable at all.
 *  - Context's own plumbing under `.context/` is only ever created, never
 *    duplicated: a copy of an index or a history file under a new name is
 *    noise nobody can use.
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
  ): Promise<unknown>;
}

export type CatchUpOutcome =
  | "same"
  | "copied"
  | "kept_beside"
  | "deletion_not_carried"
  | "plumbing_left"
  | "too_large"
  | "no_room"
  | "gone";

/** The most numbered copies one note gets before a pass gives up on it. */
const MAX_COPIES = 20;

const PLUMBING = ".context/";

/** `notes/plan.md` becomes `notes/plan (saved during the move).md`, then `… 2)`. */
export function catchUpCopyKey(key: string, n: number): string {
  const slash = key.lastIndexOf("/");
  const dot = key.lastIndexOf(".");
  const suffix = n <= 1 ? " (saved during the move)" : ` (saved during the move ${n})`;
  return dot > slash + 1 ? `${key.slice(0, dot)}${suffix}${key.slice(dot)}` : `${key}${suffix}`;
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

/** Create `key` only if it is absent, then prove the bytes landed. */
async function createExactly(
  target: CatchUpStore,
  key: string,
  bytes: ArrayBuffer,
): Promise<boolean> {
  const written = await target.put(key, bytes, {
    contentType: contentTypeFor(key),
    onlyIf: { absent: true },
  });
  if (written === null) return false;
  const verified = await target.get(key);
  if (verified === null || !sameBytes(bytes, await verified.arrayBuffer())) {
    throw new Error("VERIFY_FAILED");
  }
  return true;
}

/** Bring one old-bucket key across without touching anything already there. */
export async function catchUpObject(options: {
  source: CatchUpStore;
  target: CatchUpStore;
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
    if (await createExactly(target, key, bytes)) return "copied";
    // Somebody created it between our read and our write. Theirs stays.
  } else if (sameBytes(bytes, await existing.arrayBuffer())) {
    return "same";
  }
  if (key.startsWith(PLUMBING)) return "plumbing_left";
  // Re-read after a lost create race: the winner may hold these very bytes.
  if (existing === null) {
    const winner = await target.get(key);
    if (winner !== null && sameBytes(bytes, await winner.arrayBuffer())) return "same";
  }

  for (let n = 1; n <= MAX_COPIES; n += 1) {
    const copyKey = catchUpCopyKey(key, n);
    const there = await target.get(copyKey);
    if (there !== null) {
      // Already kept on an earlier pass: nothing to add.
      if (sameBytes(bytes, await there.arrayBuffer())) return "kept_beside";
      continue;
    }
    if (await createExactly(target, copyKey, bytes)) return "kept_beside";
    // Lost a race for this name; look at what won it before moving on.
    const winner = await target.get(copyKey);
    if (winner !== null && sameBytes(bytes, await winner.arrayBuffer())) return "kept_beside";
  }
  return "no_room";
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
    }
  }
  return counts;
}
