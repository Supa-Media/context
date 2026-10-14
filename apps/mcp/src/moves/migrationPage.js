/**
 * One page of a whole-bucket move (into managed storage, or out to the
 * customer's own bucket), reconciled source to target.
 *
 * Shared by the two places a page can run: the gateway's mover
 * (`moves/mover.js`), where the bytes stay inside Cloudflare's network, and
 * the control plane's own action (`apps/convex/functions/managedProvisioning.ts`),
 * kept as the fallback while the mover proves itself. One implementation, so
 * the two cannot disagree about what a page does.
 *
 * Nothing here ever deletes from the source.
 */

import {
  ATTACHMENT_CONTENT_TYPE,
  LOGICAL_DELETE_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
} from "../store/contentTypes.js";
import { isLogicalDeleteMarker } from "../store/logicalDelete.js";
import { managedEncryptionForStore, storeForBinding } from "../store/factory.js";

/**
 * @typedef {{ contentType?: string, arrayBuffer(): Promise<ArrayBuffer> }} MigrationReadable
 * @typedef {{
 *   get(key: string): Promise<MigrationReadable | null>,
 *   put(key: string, value: ArrayBuffer, options: { contentType: string }): Promise<unknown>,
 *   delete(key: string): Promise<unknown>,
 * }} MigrationStore
 * @typedef {{ key: string, size?: number }} MigrationListedObject
 * @typedef {{
 *   deleteUnmatchedTarget?: boolean,
 *   deleteOnlyUnder?: string,
 *   keepTargetConflicts?: boolean,
 * }} MigrationPageRules
 */

/** @param {ArrayBuffer} left @param {ArrayBuffer} right */
function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * Reconcile one listed key without ever deleting it from the source.
 *
 * `deleteUnmatchedTarget`: whether a destination key the source does not have
 * may be deleted. Only when the destination is known to hold nothing but this
 * move's own writes (`targetClaimed` on the migration row). **Absent means
 * keep**: a key in somebody's bucket that Context did not put there is theirs.
 *
 * `deleteOnlyUnder` narrows that deletion to keys under a prefix: a move out of
 * managed storage passes `.context/`, so a file the owner adds to their bucket
 * mid-move is kept.
 *
 * `keepTargetConflicts`: before writing over a destination file that differs,
 * keep the old one as `name (from your bucket).ext`, once. For a move merged
 * into a bucket that already held the customer's files.
 *
 * @param {{ source: MigrationStore, target: MigrationStore, key: string, listedFromTarget: boolean, byteCap: number } & MigrationPageRules} options
 * @returns {Promise<{ copied: number, changes: number }>}
 */
export async function reconcileMigrationObject(options) {
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
    // Already identical: the read that proved equality is the proof a
    // read-back would give, so a quiet verification pass reads each object
    // once rather than three times.
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

/**
 * `notes/plan.md` becomes `notes/plan (from your bucket).md`.
 * @param {string} key
 */
export function conflictCopyKey(key) {
  const slash = key.lastIndexOf("/");
  const dot = key.lastIndexOf(".");
  const suffix = " (from your bucket)";
  return dot > slash + 1 ? `${key.slice(0, dot)}${suffix}${key.slice(dot)}` : `${key}${suffix}`;
}

/**
 * @param {MigrationStore} target
 * @param {string} key
 * @param {ArrayBuffer} bytes
 * @param {string | undefined} contentType
 */
async function keepConflictingTarget(target, key, bytes, contentType) {
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
 * Split a listed page into waves bounded by *both* count and bytes.
 *
 * Reconciling one object holds its source and target bodies in memory at once,
 * so a wave bounded by count alone can hold hundreds of megabytes; one bounded
 * by bytes alone opens unbounded sockets on a page of small notes. A wave closes
 * when either bound would be exceeded. An object bigger than the whole budget
 * still gets a wave, alone, so it is never starved. A listing without sizes
 * contributes zero bytes and is bounded by count alone.
 *
 * The blind spot: on the `verify_target` pass the sizes are the destination's,
 * so an object grown in the source since is budgeted at its old size. No single
 * object can exceed the byte cap whatever the listing said, because
 * `reconcileMigrationObject` measures what it actually read.
 *
 * @template {MigrationListedObject} T
 * @param {readonly T[]} objects
 * @param {{ maxWidth: number, byteBudget: number }} limits
 * @returns {T[][]}
 */
export function planReconcileWaves(objects, limits) {
  const maxWidth = Math.max(1, Math.floor(limits.maxWidth));
  /** @type {T[][]} */
  const waves = [];
  /** @type {T[]} */
  let wave = [];
  let waveBytes = 0;
  for (const object of objects) {
    const size =
      typeof object.size === "number" && Number.isFinite(object.size)
        ? Math.max(0, object.size)
        : 0;
    if (wave.length > 0 && (wave.length >= maxWidth || waveBytes + size > limits.byteBudget)) {
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
 * Failure keeps the semantics a serial walk had: the page fails with the error
 * of the *earliest listed* object that failed, whatever order responses land
 * in, so a transient failure is never outranked by a terminal one by timing.
 * Every wave settles before the error is raised, so no sibling rejects into an
 * abandoned page.
 *
 * @param {{
 *   source: MigrationStore,
 *   target: MigrationStore,
 *   objects: readonly MigrationListedObject[],
 *   listedFromTarget: boolean,
 *   byteCap: number,
 *   maxWidth: number,
 *   byteBudget: number,
 * } & MigrationPageRules} options
 * @returns {Promise<{ copied: number, changes: number }>}
 */
export async function reconcileMigrationPage(options) {
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
    if (failure !== undefined && failure.status === "rejected") throw failure.reason;
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
 * List one page and reconcile it: the whole of one page, wherever it runs.
 * The census (`count`) only lists; it opens no object at all.
 *
 * @param {object} page what the page needs: both bindings, the source's
 *   encryption, the phase, the cursor, the limits and the rules
 * @param {{ buildStore?: typeof storeForBinding }} [deps] seam for tests
 */
export async function runMigrationPage(page, { buildStore = storeForBinding } = {}) {
  // Leaving managed storage the source is read through its encryption, so the
  // customer's bucket gets plain files; every other source has none.
  const source = buildStore(page.source, undefined, {
    rawObjects: true,
    managedEncryption: managedEncryptionForStore(page, page.source),
  });
  const target = buildStore(page.target, undefined, { rawObjects: true });
  const fromTarget = page.phase === "verify_target";
  const listed = await (fromTarget ? target : source).list({
    cursor: page.cursor,
    limit: page.limits.pageSize,
  });
  const objects = Array.isArray(listed?.objects) ? listed.objects : [];
  const nextCursor = listed?.truncated === true && typeof listed.cursor === "string" ? listed.cursor : null;
  if (page.phase === "count") return { copied: 0, changes: 0, processed: objects.length, nextCursor, skipped: [] };
  // Past the file limit a file stays where it is, named, and the move carries
  // on. On the last pass, which lists the destination, a big file there is
  // the owner's own and is left alone the same way, without being named.
  const over = (object) => typeof object.size === "number" && object.size > page.limits.byteCap;
  const skipped = fromTarget ? [] : objects.filter(over).map((object) => object.key);
  const { copied, changes } = await reconcileMigrationPage({
    source,
    target,
    objects: objects.filter((object) => !over(object)),
    listedFromTarget: fromTarget,
    byteCap: page.limits.byteCap,
    maxWidth: page.limits.maxWidth,
    byteBudget: page.limits.byteBudget,
    ...page.rules,
  });
  return { copied, changes, processed: objects.length, nextCursor, skipped };
}
