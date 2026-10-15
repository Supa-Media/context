/**
 * Why one note's read failed, as a fixed word an operator can act on.
 *
 * The background readers (the Convex tree's facts fill, the search indexers)
 * skip a note whose read throws and try it again on the next pass. That is
 * right for a hiccup and wrong for a note that will never read: the
 * workspace sat on "Indexing 4 of 6" for good with nothing to say why
 * (@segunawe, 2026-10-14). These words are what admin says instead. They
 * are closed and path-free: a storage error's message can quote the key,
 * which is somebody's note name.
 *
 * - `unsealed`: a plain object in a workspace whose reads are sealed-only.
 *   A writer that started before the encryption walk finished saved it plain
 *   afterwards; the walk does not come back on its own, and staff's Seal
 *   again (admin › Search › Indexes) walks the bucket once more.
 * - `sealed`: sealed bytes that do not open (a key, a damaged envelope).
 * - `name`: a key the storage layer refuses to address.
 * - `storage`: the bucket refused the read.
 * - `other`: anything else.
 */

/** Every word `readFailureKind` answers. */
export const READ_FAILURE_KINDS = Object.freeze(["unsealed", "sealed", "name", "storage", "other"]);

/** Kinds no number of retries will cure: said at once, not after a few passes. */
export const LASTING_READ_FAILURES = Object.freeze(["unsealed", "sealed", "name"]);

/** @returns {"unsealed"|"sealed"|"name"|"storage"|"other"} */
export function readFailureKind(error) {
  const shaped = /** @type {{name?: unknown, code?: unknown, detail?: unknown, message?: unknown}|null} */ (error ?? null);
  const message = typeof shaped?.message === "string" ? shaped.message : "";
  if (shaped?.name === "ManagedEncryptionError") {
    return shaped.detail === "plain object in encrypted workspace" ? "unsealed" : "sealed";
  }
  if (message.startsWith("unsafe storage key")) return "name";
  if (/^S3 [A-Z]+ .* failed with \d{3}/.test(message) || /^Dropbox /i.test(message)) return "storage";
  return "other";
}

/** The kind most of `kinds` share, or `null` for none. Ties go to the lasting kind. */
export function commonReadFailure(kinds) {
  const counts = new Map();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  let best = null;
  let most = 0;
  for (const kind of READ_FAILURE_KINDS) {
    const n = counts.get(kind) ?? 0;
    if (n > most) {
      best = kind;
      most = n;
    }
  }
  return best;
}
