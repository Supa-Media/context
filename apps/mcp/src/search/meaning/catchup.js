/**
 * Search by meaning's catch-up pass: bring a workspace's meaning index level
 * with its notes, a bounded piece at a time.
 *
 * The write path (`store.js`) embeds a note the moment an AI client or a form
 * saves it. Everything else reaches the index here: the notes that existed
 * before the index did, what a move or a restore adds, edits made in the live
 * editor (which skips the write path, `writeProjection.js`), and edits made
 * outside the product altogether, in Obsidian or straight in the bucket.
 *
 * ## The diff, and why it lives in the bucket
 *
 * The census is `[path, version]` for every note, from a listing of the
 * bucket (the control plane's `meaningProjection.ts`; never the R2 shard
 * index, which a large workspace can leave behind). This pass keeps a second map beside it,
 * at `MEANING_STATE_KEY`, of the version it last embedded for each path. A
 * note whose census version differs, or that the state has never seen, is
 * embedded; a path the state holds and the census does not is deleted.
 *
 * Fast search keeps its cursor in its own database. A Vectorize index has
 * nowhere to keep one, and the control plane holds metadata only, never a list
 * of somebody's note paths, so the map lives with the other disposable search
 * plumbing under `.context/search/`, inside the customer's own bucket. Losing
 * it costs one full re-embed, never a wrong answer: every search still goes
 * through `canSee`.
 *
 * `generation` ties the map to one life of the index. Turning search by
 * meaning off deletes the index; turning it back on makes a new, empty one
 * under the same name, and a map from the old one would claim every note was
 * already in it.
 *
 * ## What it never does
 *
 * It never fails anything a person is waiting on (nobody is: it is a scheduled
 * job), and it never writes the map past a note whose passages did not land.
 * A failure ends the pass with a closed code and the map saved up to the last
 * note that did.
 */

import { SEARCH_PREFIX } from "../../../../../packages/shared/src/storageLayout.cjs";
import { compareIndexingOrder, countByIndexingPriority } from "../../../../../packages/shared/src/folderRoles.cjs";
import { MeaningError } from "./errors.js";
import { meaningChangeFor, meaningIdsFor } from "./project.js";

export const MEANING_STATE_KEY = `${SEARCH_PREFIX}meaning/v1/state.json`;

/**
 * Notes one pass may embed. Twelve passages each at most, 32 to a model call.
 * Each pass also lists the bucket for its census, so a pass does enough
 * embedding to make that listing worth it: a 9,000-note workspace is about
 * ninety passes, inside one chain of `MEANING_PASS_CHAIN`.
 */
export const MEANING_PASS_NOTE_CAP = 100;

/** Notes read and embedded at once within a pass. */
export const MEANING_PASS_CONCURRENCY = 8;

/** Vectors held before an upsert is sent. Under the client's own batch. */
const MEANING_HELD_VECTORS = 240;

const STATE_VERSION = 1;

/**
 * The map of what was embedded, for this generation of the index, or an empty
 * one. A map from another generation, or one this build cannot read, is the
 * same as none: the safe reading of "I don't know" is "embed it again".
 */
export async function readMeaningState(store, generation) {
  try {
    const object = await store.get(MEANING_STATE_KEY);
    if (!object) return new Map();
    const parsed = JSON.parse(await object.text());
    if (
      !parsed ||
      parsed.v !== STATE_VERSION ||
      parsed.generation !== generation ||
      !parsed.notes ||
      typeof parsed.notes !== "object" ||
      Array.isArray(parsed.notes)
    ) {
      return new Map();
    }
    const notes = new Map();
    for (const [path, version] of Object.entries(parsed.notes)) {
      if (typeof version === "string") notes.set(path, version);
    }
    return notes;
  } catch {
    return new Map();
  }
}

async function writeMeaningState(store, generation, notes) {
  const sorted = [...notes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  await store.put(
    MEANING_STATE_KEY,
    JSON.stringify({ v: STATE_VERSION, generation, notes: Object.fromEntries(sorted) }),
  );
}

/**
 * What the census and the map disagree about: paths to embed (new or changed)
 * and paths to delete. Embeds go in indexing order (`compareIndexingOrder`):
 * everything but the Inbox and Archive first, then the Inbox, then the
 * Archive (decided by the owner, 2026-10-08), by path within each, so a long
 * walk resumes where it stopped.
 */
export function meaningDiff(census, notes, regionComplete = () => true) {
  const changed = [];
  for (const [path, version] of census) {
    if (notes.get(path) !== version) changed.push(path);
  }
  changed.sort(compareIndexingOrder);
  const removed = [];
  for (const path of notes.keys()) {
    // Absent from a listing that never reached its folder is not gone.
    if (!census.has(path) && regionComplete(path)) removed.push(path);
  }
  removed.sort();
  return { changed, removed };
}

/**
 * One bounded pass.
 *
 * @param {object} store the workspace's store (`get`, `put`)
 * @param {object} options
 * @param {{upsert: Function, deleteByIds: Function}} options.client this workspace's index
 * @param {(texts: string[]) => Promise<number[][]>} options.embed
 * @param {Map<string,string>} options.census path → version, from the R2 index
 * @param {(path: string) => string} options.visibilityOf `privacy.md`'s answer
 * @param {string} options.generation this life of the index
 * @param {number} [options.noteCap]
 * @param {number} [options.indexPending] notes the census itself has not reached
 * @param {(path: string) => boolean} [options.regionComplete] whether the
 *   listing behind the census reached the part of the bucket `path` is in;
 *   a path the census lacks is deleted only where it did
 * @returns {Promise<{embedded: number, deleted: number, notesIndexed: number,
 *   notesPending: number, priorities: Array<{priority: number, indexed: number,
 *   pending: number}>, ready: boolean, moved: boolean, failure: string|null,
 *   failureCause: string|null}>} counts only: no path, no title, no text.
 */
export async function meaningPass(
  store,
  {
    client,
    embed,
    census,
    visibilityOf,
    generation,
    noteCap = MEANING_PASS_NOTE_CAP,
    indexPending = 0,
    regionComplete = () => true,
  },
) {
  const notes = await readMeaningState(store, generation);
  const { changed, removed } = meaningDiff(census, notes, regionComplete);
  const result = { embedded: 0, deleted: 0, failure: null, failureCause: null, failureOperation: null, providerCodes: [] };
  let dirty = false;

  const finish = async () => {
    if (dirty) {
      try {
        await writeMeaningState(store, generation, notes);
      } catch {
        // The vectors landed; the map did not. The next pass re-embeds what
        // this one did, which costs a model call and changes no answer.
        if (result.failure === null) {
          result.failure = "STORE_FAILED";
          result.failureCause = "store";
        }
      }
    }
    const left = meaningDiff(census, notes, regionComplete);
    const notesPending = left.changed.length + left.removed.length;
    let notesIndexed = 0;
    for (const path of census.keys()) if (notes.has(path)) notesIndexed += 1;
    // Per priority: a census path is indexed when the map holds its current
    // version, as `meaningDiff` decides; a delete still owed is pending.
    const priorities = countByIndexingPriority(
      census.keys(),
      (path) => notes.get(path) === census.get(path),
      left.removed,
    );
    return {
      embedded: result.embedded,
      deleted: result.deleted,
      notesIndexed,
      notesPending,
      priorities,
      ready: result.failure === null && notesPending === 0 && indexPending === 0,
      moved: result.embedded > 0 || result.deleted > 0,
      failure: result.failure,
      failureCause: result.failureCause,
      failureOperation: result.failureOperation,
      providerCodes: result.providerCodes,
    };
  };

  try {
    // Deletes first: a passage of a note that is gone is the one wrong thing
    // this index can put in front of somebody, and deleting costs no model call.
    if (removed.length > 0) {
      const ids = (await Promise.all(removed.map((path) => meaningIdsFor(path)))).flat();
      await client.deleteByIds(ids);
      for (const path of removed) notes.delete(path);
      result.deleted = removed.length;
      dirty = true;
    }

    const cap = Number.isFinite(noteCap) ? Math.max(0, Math.floor(noteCap)) : MEANING_PASS_NOTE_CAP;
    let held = [];
    let heldDeletes = [];
    let heldPaths = [];
    const flush = async () => {
      if (held.length > 0) await client.upsert(held);
      if (heldDeletes.length > 0) await client.deleteByIds(heldDeletes);
      for (const [path, version] of heldPaths) notes.set(path, version);
      if (heldPaths.length > 0) dirty = true;
      result.embedded += heldPaths.length;
      held = [];
      heldDeletes = [];
      heldPaths = [];
    };

    // A note is a bucket read and a model call, each a round trip, so notes
    // go `MEANING_PASS_CONCURRENCY` at a time rather than one after another:
    // one at a time, a 9,000-note workspace took most of a day. Results are
    // still recorded in order, and a refused call still ends the pass with
    // nothing of its group recorded, so the next pass redoes it.
    const todo = changed.slice(0, cap);
    for (let start = 0; start < todo.length; start += MEANING_PASS_CONCURRENCY) {
      const group = todo.slice(start, start + MEANING_PASS_CONCURRENCY);
      const changes = await Promise.all(
        group.map(async (path) => {
          let object;
          try {
            object = await store.get(path);
          } catch {
            // One unreadable note must not cost the rest of the pass. It stays
            // unrecorded and the next pass tries it again.
            return null;
          }
          if (!object) {
            // Gone between the docmap and now: the next pass's census drops it.
            return null;
          }
          return await meaningChangeFor(
            path,
            { content: await object.text(), visibility: visibilityOf(path) },
            embed,
          );
        }),
      );
      for (let index = 0; index < group.length; index += 1) {
        const change = changes[index];
        if (change === null) continue;
        held.push(...change.vectors);
        heldDeletes.push(...change.deleteIds);
        heldPaths.push([group[index], census.get(group[index])]);
      }
      if (held.length >= MEANING_HELD_VECTORS) await flush();
    }
    await flush();
  } catch (error) {
    result.failure = error instanceof MeaningError ? error.code : "REFUSED";
    // Our closed set of causes, or "internal" for an error of our own code:
    // which call failed is what an operator needs, and never its message.
    result.failureCause = error instanceof MeaningError ? (error.failureCause ?? null) : "internal";
    result.failureOperation = error instanceof MeaningError ? (error.operation ?? null) : null;
    result.providerCodes = error instanceof MeaningError ? error.providerCodes : [];
  }
  return await finish();
}
