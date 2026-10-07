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
 * The census is the R2 index's own docmap, `[path, version]` for every note
 * (`d1/backfill.js`'s `loadCensus`). This pass keeps a second map beside it,
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
import { MeaningError } from "./errors.js";
import { meaningChangeFor, meaningIdsFor } from "./project.js";

export const MEANING_STATE_KEY = `${SEARCH_PREFIX}meaning/v1/state.json`;

/** Notes one pass may embed. Twelve passages each at most, 32 to a model call. */
export const MEANING_PASS_NOTE_CAP = 40;

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
 * What the census and the map disagree about: paths to embed (new or changed,
 * in path order so a long walk resumes where it stopped) and paths to delete.
 */
export function meaningDiff(census, notes) {
  const changed = [];
  for (const [path, version] of census) {
    if (notes.get(path) !== version) changed.push(path);
  }
  changed.sort();
  const removed = [];
  for (const path of notes.keys()) {
    if (!census.has(path)) removed.push(path);
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
 * @param {number} [options.indexPending] notes the R2 index itself has not reached
 * @returns {Promise<{embedded: number, deleted: number, notesIndexed: number,
 *   notesPending: number, ready: boolean, moved: boolean, failure: string|null,
 *   failureCause: string|null}>} counts only: no path, no title, no text.
 */
export async function meaningPass(
  store,
  { client, embed, census, visibilityOf, generation, noteCap = MEANING_PASS_NOTE_CAP, indexPending = 0 },
) {
  const notes = await readMeaningState(store, generation);
  const { changed, removed } = meaningDiff(census, notes);
  const result = { embedded: 0, deleted: 0, failure: null, failureCause: null };
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
    const left = meaningDiff(census, notes);
    const notesPending = left.changed.length + left.removed.length;
    let notesIndexed = 0;
    for (const path of census.keys()) if (notes.has(path)) notesIndexed += 1;
    return {
      embedded: result.embedded,
      deleted: result.deleted,
      notesIndexed,
      notesPending,
      ready: result.failure === null && notesPending === 0 && indexPending === 0,
      moved: result.embedded > 0 || result.deleted > 0,
      failure: result.failure,
      failureCause: result.failureCause,
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

    for (const path of changed.slice(0, cap)) {
      let object;
      try {
        object = await store.get(path);
      } catch {
        // One unreadable note must not cost the rest of the pass. It stays
        // unrecorded and the next pass tries it again.
        continue;
      }
      if (!object) {
        // Gone between the docmap and now: the next pass's census drops it.
        continue;
      }
      const change = await meaningChangeFor(
        path,
        { content: await object.text(), visibility: visibilityOf(path) },
        embed,
      );
      held.push(...change.vectors);
      heldDeletes.push(...change.deleteIds);
      heldPaths.push([path, census.get(path)]);
      if (held.length >= MEANING_HELD_VECTORS) await flush();
    }
    await flush();
  } catch (error) {
    result.failure = error instanceof MeaningError ? error.code : "REFUSED";
    // Our closed set of causes, or "internal" for an error of our own code:
    // which call failed is what an operator needs, and never its message.
    result.failureCause = error instanceof MeaningError ? (error.failureCause ?? null) : "internal";
  }
  return await finish();
}
