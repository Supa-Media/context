/**
 * Key-rotation progress: batch caps, the MAC'd progress record that lets a
 * rotation resume, and rewrapping one note. Moved verbatim out of
 * `src/index.js`; the `rotate_encryption_keys` tool stays beside the privacy
 * engine it reads through.
 */

import { encodeBase64, timingSafeEqual } from "../crypto/bytes.js";
import {
  encryptedNoteKeyId,
  isEncryptedNote,
  NoteCryptoError,
  rewrapWorkspaceRecipient,
} from "../encryption.js";
import { getWithLegacyFallback } from "../storageLayout.js";

/* ------------------------------ key rotation -------------------------------- */

/**
 * How many notes one `rotate_encryption_keys` call re-wraps before reporting
 * back rather than continuing.
 *
 * Small next to `FOLDER_MOVE_CAP`'s 500 on purpose: a re-wrap is two
 * subrequests per note (`get`, then a conditional `put`) plus whatever the
 * listing itself costs, against the same 50-subrequest Worker budget
 * `docs/decisions/storage-and-credentials.md` already measures every bulk
 * operation in this file against. Call the tool again to continue — that is
 * the entire resumption protocol, and it is safe to call as many times as it
 * takes, because a note already on the target generation is skipped rather
 * than re-wrapped.
 *
 * Not exported: this file's only export is the default worker
 * (`scripts/check-gateway-imports.mjs`/`gatewayFormat.helpers.ts` in
 * `apps/convex/__tests__` both assume it), and `apps/mcp/test/encryptionRotation.test.mjs`
 * asserts this same number as a plain literal rather than importing it.
 */
export const ROTATION_BATCH_CAP = 200;

/**
 * Where a rotation walk's own progress is tracked. Plumbing: never listed,
 * never a note, never containing key material — only generation ids and note
 * paths already visible in every affected note's own frontmatter.
 *
 * **This is bookkeeping about the walk, not a second copy of the truth.** A
 * note's own frontmatter is still the only thing that says which generation
 * it is on; this file only says where the walk last looked, so a lost,
 * corrupted, or concurrently-overwritten copy costs a wider re-scan next
 * call, never a wrong answer. See `loadRotationProgress`.
 *
 * Lives in the customer's own bucket rather than the control plane, matching
 * `EXPORT_RATE_LIMIT_PATH` elsewhere in this file: the control plane holds
 * the one fact that has to be authoritative across every Worker isolate —
 * whether a rotation may be *started* (`workspaceKeyRotations`) — and the
 * walk's own progress over the customer's content lives beside that content,
 * on the same "one source of truth" the bucket already is for "which notes
 * exist".
 */
export const ROTATION_PROGRESS_PATH = ".context/rotation-progress.json";

/**
 * How many object reads ONE call may spend on the retry sweeps — the
 * known-stuck set, and the behind-the-cursor catch-up — before it carries the
 * rest to the next call.
 *
 * The forward sweep is the only one that advances the cursor, so it is the
 * only one that makes a large bucket finish. Without a separate, smaller
 * budget for the two retry sweeps, a call whose `stuckKeys` list had grown
 * past `ROTATION_BATCH_CAP` would spend its entire budget re-reading notes it
 * already knows about and never move the cursor at all — a starvation with
 * exactly the shape of the bug this whole file exists to remove.
 */
export const ROTATION_RETRY_READ_CAP = Math.floor(ROTATION_BATCH_CAP / 4);

/**
 * How many "this walk wrote it" keys the progress file will carry. Four
 * batches, so a caller hammering the tool inside one second of a backend's
 * listing resolution still has its own recent output recognised, and the file
 * still cannot grow with the bucket.
 */
export const ROTATION_WROTE_CAP = ROTATION_BATCH_CAP * 4;

/** First `limit` distinct entries, in order. */
export function dedupeCapped(values, limit) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Was this object definitely written before the boundary the last call
 * confirmed through? Compared at WHOLE-SECOND resolution, with a strict `<`,
 * because that is the resolution the timestamp actually carries.
 *
 * **S3's `ListObjectsV2` and Dropbox's `server_modified` report whole
 * seconds.** A note that lands behind the cursor at 12.900s is reported as
 * 12.000s, and a boundary of 12.750s compared exactly would call it older
 * than the last sweep and never look at it again. Measured on a
 * second-granularity store stub, exactly that lost a note moved behind the
 * cursor in four of eight runs — and the walk retired the generation anyway.
 * Rounding both sides down and demanding a strictly earlier second is the
 * comparison the data supports: it can only ever be over-inclusive, by at
 * most the writes that share one second with the boundary.
 *
 * What it does not cover, said rather than assumed: skew between the storage
 * backend's clock and this Worker's beyond a second. A backend running more
 * than a second behind can under-report an arrival into the swept range, and
 * that note stays on the outgoing generation — readable, under a generation
 * this codebase never deletes, and moved by the next rotation.
 */
export function uploadedBefore(uploadedMs, confirmedThrough) {
  if (!Number.isFinite(uploadedMs)) return false; // no timestamp: always re-examine
  return Math.floor(uploadedMs / 1000) < Math.floor(confirmedThrough / 1000);
}

/**
 * The label this file's authentication tag is derived under, so the tag can
 * never be replayed from, or onto, anything else signed with the same key.
 */
const ROTATION_PROGRESS_MAC_LABEL = "context/rotation-progress/v1";

/**
 * Authenticate the progress file under the generation the walk is moving
 * *to*, so a resume point is only ever trusted if this gateway wrote it.
 *
 * **Why a rotation's own bookkeeping needs a tag when the export rate-limit
 * counter next door does not.** This file is the only bucket object whose
 * contents can make `rotate_encryption_keys` report "complete" without having
 * looked at a note. A `cursor` that sorts after every key, in a file that
 * otherwise parses, is a two-line JSON document that makes the walk retire the
 * outgoing generation with every note still wrapped under it — silently, and
 * with the tool's own success message as the evidence. `docs/decisions/encryption.md`
 * then tells an operator to delete a retired generation's row once a re-run
 * says nothing names it, and that is the step at which those notes stop
 * opening for good. A leaked bucket credential is the threat that table calls
 * "the one that matters"; this change gave it a lever on the remediation
 * itself, and this closes it.
 *
 * The key is the new generation's material, which the gateway already holds
 * in-process for the length of this request and an attacker holding only the
 * bucket does not. It is used through one HMAC derivation step rather than
 * directly, so nothing here is the same key input as the AES-GCM wrap it also
 * performs. A tag that does not verify is treated exactly as a missing file:
 * the walk starts fresh and re-reads, which is slower and always correct.
 */
async function rotationProgressMac(keyMaterial, body) {
  const encoder = new TextEncoder();
  const rootKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(keyMaterial)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const subKeyBytes = await crypto.subtle.sign("HMAC", rootKey, encoder.encode(ROTATION_PROGRESS_MAC_LABEL));
  const subKey = await crypto.subtle.importKey(
    "raw",
    subKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeBase64(new Uint8Array(await crypto.subtle.sign("HMAC", subKey, encoder.encode(body))));
}

/** The exact bytes the tag covers. Order is fixed so a re-serialisation verifies. */
function rotationProgressPayload({ fromGeneration, toGeneration, cursor, confirmedThrough, stuckKeys, wrote }) {
  return JSON.stringify({ fromGeneration, toGeneration, cursor, confirmedThrough, stuckKeys, wrote });
}

/**
 * Read the walk's own resume point, or a fresh one if there is none, it does
 * not parse, its authentication tag does not verify, or it names a different
 * generation pair than the one being walked right now — which is exactly
 * right for a rotation that just started on top of a previous one's leftover
 * file, and costs nothing extra to check.
 *
 * @returns {Promise<{cursor: string, confirmedThrough: number, stuckKeys: string[], etag: string|undefined}>}
 *   `cursor` — every note key at or below this one, in the bucket's own sort
 *   order, has been examined at least once as of `confirmedThrough`.
 *   `confirmedThrough` — a moment in time captured BEFORE the listing the
 *   call that produced this file worked from, less `ROTATION_CLOCK_MARGIN_MS`.
 *   A note whose `uploaded` time is at or before this was in that listing and
 *   was therefore accounted for; anything later than it may have landed in
 *   the window between that listing and now, at any key, and gets looked at
 *   again whatever its position (see `toolRotateEncryptionKeys` for what a
 *   later boundary saves, and what it costs).
 *   `stuckKeys` — notes still on the outgoing generation that a previous call
 *   could not move (a conflicting write, or an envelope this pass cannot
 *   open), tracked separately from `cursor` so one bad note never blocks the
 *   walk from moving past it.
 */
export async function loadRotationProgress(store, fromGeneration, toGeneration, newKeyMaterial) {
  const fresh = () => ({ cursor: "", confirmedThrough: 0, stuckKeys: [], wrote: new Set(), etag: undefined });
  const existing = await getWithLegacyFallback(store, ROTATION_PROGRESS_PATH);
  if (!existing) return fresh();
  let parsed;
  try {
    parsed = JSON.parse(await existing.text());
  } catch {
    return fresh(); // corrupt file: treated as absent, never as a reason to refuse
  }
  if (
    !parsed ||
    parsed.fromGeneration !== fromGeneration ||
    parsed.toGeneration !== toGeneration ||
    typeof parsed.cursor !== "string" ||
    typeof parsed.confirmedThrough !== "number" ||
    !Array.isArray(parsed.stuckKeys) ||
    !Array.isArray(parsed.wrote)
  ) {
    return fresh(); // a different rotation's leftover file, or one this build cannot read
  }
  const stuckKeys = parsed.stuckKeys.filter((k) => typeof k === "string");
  const wrote = parsed.wrote.filter((k) => typeof k === "string");
  // Authenticated, not merely shaped: an unsigned or wrongly-signed resume
  // point is a resume point somebody other than this gateway chose, and the
  // one thing a chosen cursor buys is a walk that reports "complete" without
  // reading a note. See `rotationProgressMac`.
  const expected = await rotationProgressMac(
    newKeyMaterial,
    rotationProgressPayload({
      fromGeneration,
      toGeneration,
      cursor: parsed.cursor,
      confirmedThrough: parsed.confirmedThrough,
      stuckKeys,
      wrote,
    }),
  );
  if (typeof parsed.mac !== "string" || !timingSafeEqual(parsed.mac, expected)) return fresh();
  return {
    cursor: parsed.cursor,
    confirmedThrough: parsed.confirmedThrough,
    stuckKeys,
    wrote: new Set(wrote),
    etag: existing.etag,
  };
}

/**
 * Persist the walk's resume point after a call that did not finish the
 * rotation. Best-effort, like `checkAndConsumeExportRateLimit`'s counter: this
 * file is never the source of truth for whether a note is on the outgoing
 * generation — a note's own frontmatter always is — only for where to resume
 * *looking*. A lost conditional-write race (two overlapping calls against the
 * same rotation) costs a wider re-scan on the next call, never a wrong
 * completion: every note this call actually rewrapped was written directly,
 * unconditionally on its own etag, whether or not this file's write lands.
 */
export async function saveRotationProgress(
  store,
  { fromGeneration, toGeneration, cursor, confirmedThrough, stuckKeys, wrote, etag, newKeyMaterial },
) {
  const payload = rotationProgressPayload({
    fromGeneration,
    toGeneration,
    cursor,
    confirmedThrough,
    stuckKeys,
    wrote,
  });
  const mac = await rotationProgressMac(newKeyMaterial, payload);
  const body = JSON.stringify({ ...JSON.parse(payload), mac });
  if (!etag) {
    await store.put(ROTATION_PROGRESS_PATH, body);
    return;
  }
  const written = await store.put(ROTATION_PROGRESS_PATH, body, { onlyIf: { etagMatches: etag } });
  if (written) return;
  /*
    THE CONDITIONAL WRITE IS POLITENESS, NOT SAFETY, AND LOSING IT MUST NOT
    STALL THE WALK.

    `cursor` means "every key at or below this one has been examined", which
    is true of whichever overlapping call wrote it — so overwriting the other
    call's position with our own is always a true statement, at worst a
    narrower one that costs a re-read. What is NOT survivable is giving up:
    the read budget is spent on reads rather than re-wraps, so a call that
    cannot persist its cursor re-reads the same first batch next time and a
    bucket larger than the cap never finishes. Losing the race twice in a row
    is left alone — the next call reads whatever did land, which is a valid
    position either way.
  */
  await store.put(ROTATION_PROGRESS_PATH, body);
}

/**
 * Try to move one note off `fromGeneration`.
 *
 * @returns {Promise<"rewrapped"|"clean"|"stuck">} `"rewrapped"` — moved to the
 *   target generation this call. `"clean"` — nothing to do: deleted since it
 *   was listed, not encrypted, or already off `fromGeneration` (on the target
 *   generation, on some other still-retired one, or a passphrase-only note
 *   with no workspace recipient to move at all). `"stuck"` — still on
 *   `fromGeneration` and this call could not move it: a conflicting
 *   concurrent write, or an envelope this pass cannot open. Left exactly as
 *   it is either way — the one outcome worse than leaving a note behind is
 *   guessing at its content — for a later call to retry.
 */
export async function rewrapOneNote(store, key, { fromGeneration, toGeneration, keys, newKeyMaterial, workspaceId }) {
  const object = await getWithLegacyFallback(store, key);
  if (!object) return "clean";
  const text = await object.text();
  if (!isEncryptedNote(text) || encryptedNoteKeyId(text) !== fromGeneration) return "clean";
  let rewrappedText;
  try {
    rewrappedText = await rewrapWorkspaceRecipient(text, { workspaceId, keys, newGeneration: toGeneration, newKeyMaterial });
  } catch (error) {
    if (error instanceof NoteCryptoError) return "stuck";
    throw error;
  }
  // Conditional on the etag this pass read: a note edited concurrently (its
  // plaintext changed, or `set_encryption` turned it off) is left for the
  // next call rather than overwritten.
  const put = await store.put(key, rewrappedText, { onlyIf: { etagMatches: object.etag } });
  return put ? "rewrapped" : "stuck";
}
