/** `rotate_encryption_keys` — resumable, batch by batch. */

import {
  dedupeCapped,
  loadRotationProgress,
  rewrapOneNote,
  ROTATION_BATCH_CAP,
  ROTATION_PROGRESS_PATH,
  ROTATION_RETRY_READ_CAP,
  ROTATION_WROTE_CAP,
  saveRotationProgress,
  uploadedBefore,
} from "../../encryptionKeys/rotation.js";
import { deleteWithLegacyFallback } from "../../storageLayout.js";
import { isPlumbing } from "../../privacy/engine.js";
import { listAllKeys } from "../../notes/storage.js";
import { recordChange } from "../../activity/record.js";
import { toolError, toolText } from "../results.js";

/**
 * Rotate this context's workspace data key.
 *
 * Owner-only through the same masked gate `export_encryption_keys` uses. What
 * happens here is exactly the cost `docs/decisions/encryption.md`'s
 * "Rotation" section names: a new generation is minted (or, if a walk is
 * already under way, this call simply continues it — see
 * `startWorkspaceKeyRotation` in the control plane for why a second caller
 * never mints a second generation), and every note still on the outgoing
 * generation has its **`workspace` recipient** re-wrapped toward it. No note
 * body is ever decrypted or re-encrypted here.
 *
 * **The walk's progress is persisted**, in the customer's own bucket
 * (`ROTATION_PROGRESS_PATH`), as a `cursor`: every note at or below it, in the
 * bucket's own sort order, has been examined at least once during the current
 * pass. A call resumes from the cursor rather than re-listing and re-reading
 * everything before it — which is what bounds *every* call, including the one
 * that finishes the rotation, to a constant number of object reads instead of
 * one read per note in the bucket. **The budget counts reads, not re-wraps**,
 * because a read is what a Worker's subrequest budget counts: at most
 * `ROTATION_BATCH_CAP` for the forward sweep, that plus
 * `ROTATION_RETRY_READ_CAP` for the behind-the-cursor catch-up (it has to be
 * able to get through a full forward batch, or a walk that is otherwise
 * finished never gets to say so), and `ROTATION_RETRY_READ_CAP` for the
 * known-stuck retry. See the measured table in `docs/decisions/encryption.md`.
 *
 * **A note created or moved behind the cursor is not skipped.** `listAllKeys`
 * already returns each object's `uploaded` timestamp at no extra cost — it is
 * part of every storage backend's listing response — so a note whose key
 * sorts at or before the cursor, but whose `uploaded` time is after
 * `confirmedThrough`, is re-examined anyway: it was either moved into that
 * position, or newly created there, after the last call took the listing it
 * worked from, and the cursor sweeping past that key position earlier proves
 * nothing about content that arrived there afterward. This costs one extra
 * read per note touched inside that window — not per note in the bucket. The
 * boundary is captured *before* a call's own listing, and compared through
 * `uploadedBefore` at the resolution the backend's timestamp actually
 * carries; a boundary taken after the writes instead would lose any note that
 * moved behind the cursor while the call was running. The re-reading that
 * earlier boundary would otherwise cause is paid for by `wrote`, the keys the
 * last call moved, which the catch-up skips.
 *
 * **A note this pass cannot move — a conflicting write, or one it cannot
 * open — does not block the cursor from advancing past it.** It is tracked
 * separately, in `stuckKeys`, and retried every call independent of cursor
 * position. Without that, a single such note would pin the cursor at its own
 * position forever, and every call after it would re-walk everything past
 * that point from scratch — the same unbounded cost this design exists to
 * remove, just moved one note earlier.
 *
 * The walk reports complete, and asks the control plane to retire the
 * outgoing generation, only once a full pass finds the cursor has reached the
 * end of the bucket's listing, nothing is left behind it, and `stuckKeys` is
 * empty — never on a partial pass, and never while a single note it could not
 * open still exists.
 */
export async function toolRotateEncryptionKeys(store, scope) {
  if (!store.encryptionKey) {
    return toolText(
      "this context has never encrypted a note; there is nothing to rotate.",
    );
  }
  const workspaceId = store?.actor?.workspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) {
    return toolError("this connection has no workspace to rotate a key for");
  }

  // Idempotently starts a rotation, or reports the one already in progress —
  // either way, this is the one call that guarantees `keys` includes the
  // TARGET generation's material, freshly minted a moment ago if this is what
  // started it.
  const { encryptionKey, rotation } = await store.rotateEncryptionKeys({ start: true });
  if (!rotation || !encryptionKey) {
    return toolError(
      "this context's workspace key could not be rotated right now; nothing was changed. Try again shortly.",
    );
  }
  const { fromGeneration, toGeneration } = rotation;
  const newKeyMaterial = encryptionKey.keys[toGeneration];
  if (typeof newKeyMaterial !== "string" || newKeyMaterial === "") {
    return toolError(
      "the new key generation is not yet available to this connection; try again shortly.",
    );
  }

  /*
    THE BOUNDARY, TAKEN BEFORE THE LISTING THIS CALL WILL WORK FROM.

    Everything this call knows about the bucket comes from the listing below.
    A note that lands behind the cursor after that listing was taken — a
    `move_note` into an earlier folder while this call is mid-sweep, an
    Obsidian sync landing a restored file — is invisible to this call by
    construction. So the boundary the NEXT call compares `uploaded` against
    has to be a moment no later than this listing, or that note falls into the
    gap between the two calls and is never examined again.

    Taking it at the END of the call instead (after this call's own writes)
    buys one thing — a call never re-reads its own rewrites — and costs
    exactly that note. Measured: a note moved behind the cursor while a call
    was running was left on the outgoing generation and the walk retired the
    generation anyway. The re-read is bounded by the previous call's own
    batch and comes back "clean"; the missed note is not bounded by anything.

    Compared through `uploadedBefore`, because `uploaded` is the storage
    backend's clock and carries only whole seconds on S3 and Dropbox.
  */
  const boundary = Date.now();

  const allKeys = await listAllKeys(store, "");
  const noteKeys = allKeys
    .filter(({ key }) => key.endsWith(".md") && !isPlumbing(key))
    .map(({ key, uploaded }) => ({ key, uploadedMs: new Date(uploaded).getTime() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const uploadedByKey = new Map(noteKeys.map(({ key, uploadedMs }) => [key, uploadedMs]));

  const progress = await loadRotationProgress(store, fromGeneration, toGeneration, newKeyMaterial);
  const rewrapContext = { fromGeneration, toGeneration, keys: encryptionKey.keys, newKeyMaterial, workspaceId };

  let rewrapped = 0;
  const stillStuck = new Set();
  /*
    THE KEYS THIS CALL ITSELF WROTE.

    Carried to the next call so the behind-the-cursor catch-up does not spend
    its budget re-reading this call's own output. Without it the boundary
    above — deliberately taken *before* this call's writes — makes every note
    this call re-wrapped look freshly arrived to the next one, and on a
    backend whose listing timestamps carry only whole seconds a fast sequence
    of calls can keep an entire bucket inside that window and never converge:
    measured at 600 notes, calls four through twelve each re-read 252 objects,
    re-wrapped nothing, and the walk never reported complete.

    A key is skipped for exactly one call — the next one — because only that
    call's file names it. The residue, stated rather than hidden: a write
    somebody else lands on that exact key, in the window between our own write
    and the next call, is not re-examined by this rotation. Through the
    gateway that write is already on the target generation (a rotation retires
    the outgoing generation the moment it starts, so `sealNoteContent` seals
    under the new one from then on), so the only shape left is a direct-to-
    bucket restore of pre-rotation ciphertext — the first of the three cases
    "The grace period is a policy, not a sweep" already exists for.
  */
  const wroteThisCall = [];

  /*
    THE BUDGET IS READS, NOT RE-WRAPS.

    Every one of the sweeps below spends an object read per note it examines,
    whatever that read turns out to say. Counting only the notes actually
    MOVED lets a call read the whole bucket for free whenever most of what it
    passes over comes back "clean" — a bucket where encryption is on for a
    subset of the notes, which is the ordinary shape of a workspace, not a corner
    case. Measured on this branch before this line changed: a 10,000-note
    bucket with 200 encrypted notes issued 10,002 reads in a single call, the
    exact ceiling the persisted cursor exists to remove. The cap has to count
    the quantity a Worker's subrequest budget counts.
  */
  let reads = 0;

  // Retry known-stuck notes first — a separately tracked set (see the
  // function doc) so one of them never blocks the cursor loops below from
  // making progress on everything after it, under its own smaller budget so
  // a large stuck set can never starve the forward sweep either.
  let retryReads = 0;
  for (const key of progress.stuckKeys) {
    if (retryReads >= ROTATION_RETRY_READ_CAP) {
      stillStuck.add(key);
      continue;
    }
    reads += 1;
    retryReads += 1;
    const result = await rewrapOneNote(store, key, rewrapContext);
    if (result === "rewrapped") {
      rewrapped += 1;
      wroteThisCall.push(key);
    } else if (result === "stuck") stillStuck.add(key);
    // "clean" is dropped: e.g. `set_encryption` turned encryption off for it
    // since the last call left it stuck.
  }

  // The cursor's own frontier: notes not yet examined (`key > cursor`), plus
  // notes at or before the cursor that were touched — moved in, or written
  // to — since `confirmedThrough` (see the function doc for why the boundary
  // is taken before this call's listing).
  let cursor = progress.cursor;
  let aheadDone = true;
  for (const { key } of noteKeys) {
    if (key <= cursor) continue;
    if (reads >= ROTATION_BATCH_CAP) {
      aheadDone = false;
      break;
    }
    reads += 1;
    const result = await rewrapOneNote(store, key, rewrapContext);
    if (result === "rewrapped") {
      rewrapped += 1;
      wroteThisCall.push(key);
    } else if (result === "stuck") stillStuck.add(key);
    cursor = key; // advance past every examined key regardless of outcome —
    // a "stuck" one is retried through `stuckKeys`, never by revisiting this
    // position.
  }

  // The behind-the-cursor catch-up gets its own budget rather than sharing
  // the forward sweep's, because in the steady state it re-reads the previous
  // call's own batch (the boundary above is taken before this call's writes,
  // on purpose) and would otherwise leave the forward sweep nothing to spend.
  // Sized a little above a full forward batch for the same reason: a walk
  // that is otherwise finished has to be able to get through its predecessor's
  // output plus whatever genuinely arrived, or it never gets to say so.
  let behindDone = true;
  let behindReads = 0;
  const behindReadCap = ROTATION_BATCH_CAP + ROTATION_RETRY_READ_CAP;
  for (const { key, uploadedMs } of noteKeys) {
    if (key > progress.cursor || uploadedBefore(uploadedMs, progress.confirmedThrough)) continue;
    if (progress.wrote.has(key)) continue; // the last call's own output, not an arrival
    if (behindReads >= behindReadCap) {
      behindDone = false;
      break;
    }
    reads += 1;
    behindReads += 1;
    const result = await rewrapOneNote(store, key, rewrapContext);
    if (result === "rewrapped") {
      rewrapped += 1;
      wroteThisCall.push(key);
    } else if (result === "stuck") stillStuck.add(key);
    // Cursor is not moved here: every one of these keys is already at or
    // below it.
  }

  const passComplete = aheadDone && behindDone && stillStuck.size === 0;

  if (passComplete) {
    const completed = await store.rotateEncryptionKeys({ complete: toGeneration });
    try {
      await deleteWithLegacyFallback(store, ROTATION_PROGRESS_PATH);
    } catch {
      // Best-effort cleanup. A leftover file naming this now-finished
      // generation pair is harmless — the next rotation names a different
      // pair, and `loadRotationProgress` starts fresh the moment it does not
      // match.
    }
    await recordChange(store, "rotate_encryption_keys", scope, [], {
      from_generation: fromGeneration,
      to_generation: toGeneration,
      notes_rewrapped: rewrapped,
      status: "complete",
    });
    const stillRotating = completed.rotation !== null;
    return toolText(
      `rotation complete: ${fromGeneration} → ${toGeneration}\n` +
        `${rewrapped} note(s) re-wrapped this call.\n` +
        (stillRotating
          ? "Another rotation is already in progress for this context; call this tool again to continue it."
          : `The ${fromGeneration} generation is retired. It is not deleted — see "Rotation" in ` +
            "docs/decisions/encryption.md for the grace-period policy — and every note now names " +
            `${toGeneration}.`),
    );
  }

  // `boundary`, not `Date.now()`: it was taken before the listing this call
  // worked from, so anything that landed while this call was running is still
  // ahead of it and the next call looks at it. See where `boundary` is
  // captured for what taking it later costs.
  await saveRotationProgress(store, {
    fromGeneration,
    toGeneration,
    cursor,
    confirmedThrough: boundary,
    stuckKeys: [...stillStuck],
    // Plus whatever an earlier call wrote that the boundary still cannot rule
    // out — a caller looping this tool as fast as it will go can fit several
    // calls inside one second of a backend's listing resolution, and dropping
    // the older entries would put every one of those batches back in front of
    // the catch-up sweep. Bounded, because an entry ages out the moment its
    // listed second is strictly earlier than the boundary.
    wrote: dedupeCapped(
      [...wroteThisCall, ...[...progress.wrote].filter((key) => uploadedByKey.has(key) && !uploadedBefore(uploadedByKey.get(key), boundary))],
      ROTATION_WROTE_CAP,
    ),
    etag: progress.etag,
    newKeyMaterial,
  });
  /*
    WHAT THIS CALL CAN HONESTLY SAY IS LEFT.

    `stuckKeys` is a census: those notes were read, are still on the outgoing
    generation, and this call could not move them. The unexamined remainder is
    not — since the budget counts reads rather than re-wraps, a call can spend
    it entirely on notes that turn out to be clean, and there may be nothing at
    all left behind the frontier. So the sentence separates the two rather than
    adding a note that might not exist to a count that is exact.
  */
  const unexamined = !(aheadDone && behindDone);
  const stillPending = stillStuck.size;
  await recordChange(store, "rotate_encryption_keys", scope, [], {
    from_generation: fromGeneration,
    to_generation: toGeneration,
    notes_rewrapped: rewrapped,
    status: "in_progress",
  });
  return toolText(
    `rotation in progress: ${fromGeneration} → ${toGeneration}\n` +
      `${rewrapped} note(s) re-wrapped this call, at least ${stillPending} left on ${fromGeneration}` +
      (unexamined ? ", and the bucket is not swept to the end yet.\n" : ".\n") +
      "Call this tool again to continue. The retiring generation stays readable until the walk completes.",
  );
}
