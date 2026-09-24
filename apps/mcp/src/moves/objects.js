/**
 * Object-level steps of a move: copy, verify, retire the source, roll back a
 * created destination, and the refusal and summary lines moves report.
 * Moved verbatim out of `src/index.js`.
 */

import { deleteWithLegacyFallback, getWithLegacyFallback } from "../storageLayout.js";
import { TRASH_PREFIX } from "./limits.js";

function buffersEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function objectMatchesMoveItem(object, item) {
  if (!object) return false;
  if (item.etag && object.etag && item.etag !== object.etag) return false;
  return true;
}

export async function copyObjectForMove(store, item) {
  if (item.etag && store?.capabilities?.serverSideCopy === "same-store" && typeof store.copy === "function") {
    const copied = await store.copy(item.source, item.destination, {
      onlyIf: { absent: true },
      sourceOnlyIf: item.etag ? { etagMatches: item.etag } : undefined,
    });
    if (copied) return copied;
  }
  const object = await getWithLegacyFallback(store, item.source);
  if (!object) throw new Error(`source missing during materialization: ${item.source}`);
  if (!objectMatchesMoveItem(object, item)) {
    throw new Error(`source changed during materialization: ${item.source}`);
  }
  if (!store?.capabilities?.conditionalCreate) {
    throw new Error(`store cannot safely create destination only-if-absent: ${item.destination}`);
  }
  const written = await store.put(item.destination, await object.arrayBuffer(), {
    onlyIf: { absent: true },
  });
  if (!written) throw new Error(`destination changed during materialization: ${item.destination}`);
  return written;
}

/**
 * A move's last step: remove the source, or refuse to.
 *
 * ## WHY THIS IS NOT JUST A CONDITIONAL DELETE
 *
 * A move is copy-then-delete, and the delete is the dangerous half: an edit
 * that lands between the two is destroyed by an unconditional delete, and the
 * copy already taken is the *older* version, so the work is simply gone. A
 * delete that carries `If-Match` turns that into a clean refusal, which is why
 * every move here required `conditionalDelete` and refused outright without it.
 *
 * **R2 does not enforce `If-Match` on DELETE.** Measured, not assumed: the
 * capability probe declares it, tests it, and every binding in production came
 * back `conditionalDelete: false`. So "refuse outright" meant *no note could be
 * moved, anywhere, on the storage this product runs on* — while `conditionalWrite`
 * and `conditionalCreate` were true the whole time.
 *
 * ## THE SUBSTITUTE, AND WHY IT IS SAFE
 *
 * A conditional **write** is the guard a conditional delete would have been:
 *
 *   1. PUT the source path, `If-Match` the etag we copied. Atomic. If anybody
 *      changed the note, this fails and nothing has been touched — the same
 *      conflict the conditional delete reported, from the same evidence.
 *   2. The object at that path is now a zero-byte marker of ours, so the
 *      DELETE that follows cannot destroy a customer's bytes. It does not need
 *      a precondition, because there is nothing left there worth protecting.
 *
 * The residual window is between (1) and (2), and it takes an unconditional
 * writer racing a move on the same path to reach it. The window the old code
 * had instead was "this feature does not work".
 *
 * ## THREE OUTCOMES, NAMED
 *
 * `"conflict"` and `"unguarded"` are different facts and the callers want them
 * apart: a move has already refused an unguarded store in `moveSafetyRefusal`
 * and can treat anything but success as a conflict, while `archive_note` —
 * which deleted its source unconditionally long before this existed — uses the
 * guard where there is one and keeps its old behaviour where there is not.
 * Returning a falsy value for both is how "no guard available" would quietly
 * read as "went fine".
 *
 * @returns {Promise<"retired" | "conflict" | "unguarded">}
 */
export async function retireMovedSource(store, key, etag, trashBody) {
  if (store?.capabilities?.conditionalDelete) {
    if (!etag) return "unguarded";
    const deleted = await deleteWithLegacyFallback(store, key, { onlyIf: { etagMatches: etag } });
    return deleted === null ? "conflict" : "retired";
  }
  if (!store?.capabilities?.conditionalWrite || !etag) return "unguarded";
  // Written before the source is claimed: a trash copy taken after the marker
  // lands would archive the marker. Only-if-absent because the key carries a
  // timestamp and the original path, and a collision means something else is
  // already there.
  if (trashBody !== undefined && trashBody !== null) {
    const trashKey = `${TRASH_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}/${key}`;
    try {
      await store.put(trashKey, trashBody, { onlyIf: { absent: true } });
    } catch {
      // A trash copy is a courtesy for a move whose destination is in another
      // bucket, not the safety property — that is the conditional write below.
      // Failing the move over it would take away the feature to protect a
      // convenience.
    }
  }
  const claimed = await store.put(key, new Uint8Array(0), { onlyIf: { etagMatches: etag } });
  if (!claimed) return "conflict";
  try {
    await deleteWithLegacyFallback(store, key);
  } catch {
    // The marker is zero bytes at a path whose content is already at the
    // destination, and the next pass of a materialization — or a retry of the
    // tool — removes it. Reporting the move as failed here would be the false
    // half of a move that did happen.
  }
  return "retired";
}

export async function deleteObjectForMove(store, item) {
  if (!store?.capabilities?.conditionalDelete && !store?.capabilities?.conditionalWrite) {
    throw new Error(`store cannot safely retire a copied source: ${item.source}`);
  }
  if (!item.etag) {
    throw new Error(`source has no captured etag for safe cleanup: ${item.source}`);
  }
  const retired = await retireMovedSource(store, item.source, item.etag);
  if (retired !== "retired") throw new Error(`source changed before cleanup: ${item.source}`);
}

export function moveSafetyRefusal(store) {
  if (!store?.capabilities?.conditionalCreate) {
    return "move requires a storage provider that supports conditional create";
  }
  // Either guard will do, and the second is the one R2 actually has. See
  // `retireMovedSource` for why a conditional write is a sound substitute for a
  // conditional delete, and why requiring the delete alone meant no note could
  // be moved on the storage this product runs on.
  if (!store?.capabilities?.conditionalDelete && !store?.capabilities?.conditionalWrite) {
    return "move requires a storage provider that supports conditional delete or conditional write";
  }
  return null;
}

export async function deleteCreatedDestination(store, path, etag) {
  if (!etag) return false;
  try {
    // The same substitute the forward path uses, for the same reason: without
    // it a store with no conditional delete could create a destination and
    // then be unable to take it back, which turns an aborted move into a
    // duplicate note.
    const retired = await retireMovedSource(store, path, etag);
    if (retired !== "retired") return false;
    await clearExactVisibilityIfAbsent(store, path);
    return true;
  } catch {
    return false;
  }
}

export async function clearExactVisibilityIfAbsent(store, path) {
  // There is no compare-and-delete primitive for an ACL entry keyed to an
  // absent object. A separate "object is absent" check followed by a privacy
  // edit can race a writer that recreates the path, and exposing that writer's
  // private note is worse than leaving a stale exact rule behind.
  return false;
}

async function readBytes(store, key) {
  const object = await getWithLegacyFallback(store, key);
  return object ? await object.arrayBuffer() : null;
}

function canVerifyMoveByEtag(store, pair) {
  return store?.capabilities?.serverSideCopy === "same-store" && typeof pair.etag === "string" && pair.etag;
}

export async function destinationMatchesMoveSource(store, pair) {
  const destination = await getWithLegacyFallback(store, pair.destination);
  if (!destination) return false;
  if (canVerifyMoveByEtag(store, pair) && destination.etag === pair.etag) return true;
  const sourceBytes = await readBytes(store, pair.source);
  if (sourceBytes === null) return false;
  const destinationBytes = await destination.arrayBuffer();
  return buffersEqual(sourceBytes, destinationBytes);
}

/**
 * How many notes a move will read looking for references to what moved.
 *
 * A move is rare and deliberate, so spending a full walk on one is the right
 * trade — but "full" has to have a number, because a bucket is a customer's and
 * can be any size. Past this the move still happens and the rewrite is
 * **reported as not done**, which is the honest failure: a partial rewrite that
 * announced success would leave a person believing their links were fixed.
 */
export const LINK_SCAN_CAP = 4000;

/** One line a move prints about its references, or nothing to say. */
export function referencesLine(result) {
  if (result.capped) {
    return "\nreferences: not rewritten (this context is too large to walk for one move)";
  }
  if (result.notes === 0) return "";
  const links = result.links === 1 ? "1 link" : `${result.links} links`;
  const notes = result.notes === 1 ? "1 note" : `${result.notes} notes`;
  return `\nreferences: ${links} updated in ${notes}`;
}
