/**
 * Search by meaning, on a request's store: the index it may write, and the
 * write-behind that keeps a saved note's passages in it.
 *
 * The descriptor comes off `/gateway/binding` beside the bucket binding, on
 * `searchIndex`'s terms (`apps/convex/functions/controlPlane.ts`): absent is the
 * ordinary case, and only an index that is `backfilling` or `ready` takes
 * writes, so a note saved while the catch-up pass runs is not missed by it.
 *
 * Nothing here may fail a write. The canonical note is already safe in the
 * customer's bucket; a passage that did not land is one note missing from the
 * meaning half of search until the next catch-up pass, never a lost note.
 */

import { createMeaningClient, readMeaningIndexBinding } from "./client.js";
import { bindingEmbedder, createRestEmbedder } from "./embed.js";
import { meaningChangeFor, meaningIdsFor } from "./project.js";

/**
 * Attach the meaning index's descriptor and the Workers AI binding to a store.
 *
 * **Non-enumerable, because the descriptor carries a token**, for exactly
 * `store.searchIndex`'s reason (`session.js`): one `{...store}` or one
 * `JSON.stringify` must not put an account-wide write token in a log line.
 */
export function attachMeaningIndex(store, descriptor, ai) {
  Object.defineProperty(store, "meaningIndex", {
    value: readMeaningIndexBinding({ meaningIndex: descriptor }),
    enumerable: false,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(store, "ai", {
    value: ai && typeof ai.run === "function" ? ai : null,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return store;
}

/** Does this store have a meaning index that takes writes? */
export function meaningWritable(store) {
  const state = store?.meaningIndex?.state;
  return state === "backfilling" || state === "ready";
}

/** The Workers AI binding where the host has one, Cloudflare's REST API where not. */
export function meaningEmbedderFor(store, { fetchImpl } = {}) {
  return (
    bindingEmbedder(store.ai) ??
    createRestEmbedder({
      accountId: store.meaningIndex.accountId,
      apiToken: store.meaningIndex.apiToken,
      fetchImpl,
    })
  );
}

function reportFailure(store, event, error) {
  try {
    console.error(
      JSON.stringify({
        event,
        workspace: store.actor?.workspaceId,
        // A closed code from `MeaningError`, never a message: a provider's
        // words can name the index, the account or the note.
        code: typeof error?.code === "string" ? error.code : "UNKNOWN",
      }),
    );
  } catch {
    // Reporting a derivative failure cannot fail the write either.
  }
}

/**
 * Put one written note's passages in the index and take away any it no longer
 * has. Upsert first, so a note is never briefly absent; the delete then drops
 * passages past the new end, or every passage of a note that may not be indexed.
 *
 * @returns {Promise<boolean>} whether it landed. Never rejects.
 */
export async function writeMeaningNote(store, { path, content, visibility }, { fetchImpl, embed } = {}) {
  if (!meaningWritable(store) || typeof path !== "string" || !path) return false;
  try {
    const client = createMeaningClient(store.meaningIndex, { fetchImpl });
    const change = await meaningChangeFor(
      path,
      { content: typeof content === "string" ? content : "", visibility },
      embed ?? meaningEmbedderFor(store, { fetchImpl }),
    );
    if (change.vectors.length > 0) await client.upsert(change.vectors);
    if (change.deleteIds.length > 0) await client.deleteByIds(change.deleteIds);
    return true;
  } catch (error) {
    reportFailure(store, "meaning-write-behind-failed", error);
    return false;
  }
}

/**
 * Take every passage of notes that are gone (a move's source, a delete, an
 * archive) out of the index. Ids are derived from the path, so this needs no
 * lookup and no text.
 *
 * @returns {Promise<boolean>} whether it landed. Never rejects.
 */
export async function removeMeaningNotes(store, paths, { fetchImpl } = {}) {
  if (!meaningWritable(store)) return false;
  const wanted = [...new Set((paths ?? []).filter((path) => typeof path === "string" && path))];
  if (wanted.length === 0) return false;
  try {
    const client = createMeaningClient(store.meaningIndex, { fetchImpl });
    const ids = (await Promise.all(wanted.map((path) => meaningIdsFor(path)))).flat();
    await client.deleteByIds(ids);
    return true;
  } catch (error) {
    reportFailure(store, "meaning-remove-behind-failed", error);
    return false;
  }
}
