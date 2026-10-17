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
 * The census is `[key, version]` for every note, from a listing of the
 * tree (the control plane's `meaningProjection.ts`; never the R2 shard
 * index, which a large workspace can leave behind). A note's key is its note
 * id where it has one, else its path (`meaningKeyOf`), and `pathOf` says
 * where each key's note is now. This pass keeps a second map beside it, at
 * `MEANING_STATE_KEY`, of the version it last embedded for each key, and the
 * path each id's passages carry. A note whose census version differs, or
 * that the state has never seen, is embedded; one at the same version under
 * a new path (a move or a rename) is re-pathed from the vectors already held,
 * with no model call (`repathPassages`); a key the state holds and the census
 * does not is deleted.
 *
 * ## From path keys to note ids
 *
 * A map written before passages were filed by id holds paths. Each such note
 * is now in the census under its id. Where the map's path holds the same
 * version, its passages are copied under the id from the vectors already held
 * (no model call), and the path's are deleted once the copy has landed; a
 * note that changed meanwhile is embedded under the id the ordinary way, and
 * its path's passages deleted on the pass after. Either way a search keeps
 * finding the note under the old ids until the new ones are there.
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
import { isNoteId } from "../../store/noteIdKeys.js";
import {
  MEANING_MAX_PASSAGES,
  MEANING_PASSAGE_CHARS,
  MEANING_PASSAGE_OVERLAP,
  deleteStaleTails,
  meaningChangeFor,
  removePassages,
  repathPassages,
} from "./project.js";

export const MEANING_STATE_KEY = `${SEARCH_PREFIX}meaning/v1/state.json`;

/**
 * Notes one pass may embed. 48 passages each at most, 32 to a model call.
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
 * The per-note passage cap a map written without `passages` was built under.
 * A map records which version of a note was embedded, not how much of it, so
 * a note that filled this cap looks finished to a pass with a larger one.
 */
const LEGACY_MAP_PASSAGES = 12;

/**
 * The map of what was embedded, for this generation of the index, or an empty
 * one. A map from another generation, or one this build cannot read, is the
 * same as none: the safe reading of "I don't know" is "embed it again".
 */
export async function readMeaningState(store, generation) {
  return (await readState(store, generation)).notes;
}

/** The map, the path each id's passages carry, and the passage cap it was written under. */
async function readState(store, generation) {
  const none = { notes: new Map(), paths: new Map(), passages: MEANING_MAX_PASSAGES };
  try {
    const object = await store.get(MEANING_STATE_KEY);
    if (!object) return none;
    const parsed = JSON.parse(await object.text());
    if (
      !parsed ||
      parsed.v !== STATE_VERSION ||
      parsed.generation !== generation ||
      !parsed.notes ||
      typeof parsed.notes !== "object" ||
      Array.isArray(parsed.notes)
    ) {
      return none;
    }
    const notes = new Map();
    for (const [key, version] of Object.entries(parsed.notes)) {
      if (typeof version === "string") notes.set(key, version);
    }
    // Only for ids the map holds: a path the map names for nothing is dropped.
    const paths = new Map();
    const recorded = parsed.paths && typeof parsed.paths === "object" && !Array.isArray(parsed.paths) ? parsed.paths : {};
    for (const [key, path] of Object.entries(recorded)) {
      if (notes.has(key) && isNoteId(key) && typeof path === "string" && path) paths.set(key, path);
    }
    const passages = Number.isInteger(parsed.passages) && parsed.passages > 0 ? parsed.passages : LEGACY_MAP_PASSAGES;
    return { notes, paths, passages };
  } catch {
    return none;
  }
}

/**
 * Bytes a note can be and still have fit a cap of `passages` whole. A passage
 * advances by its length less the overlap, and the title, headings and front
 * matter are not body, so a note smaller than this did not reach the cap's
 * last passage; one this size or over may have, and is embedded again. Bytes
 * are never fewer than characters, so this only ever over-counts.
 */
export function bytesThatFit(passages) {
  return passages * (MEANING_PASSAGE_CHARS - MEANING_PASSAGE_OVERLAP);
}

const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

async function writeMeaningState(store, generation, notes, paths) {
  const sorted = [...notes.entries()].sort(byKey);
  const held = [...paths.entries()].filter(([key]) => notes.has(key)).sort(byKey);
  await store.put(
    MEANING_STATE_KEY,
    JSON.stringify({
      v: STATE_VERSION,
      generation,
      passages: MEANING_MAX_PASSAGES,
      notes: Object.fromEntries(sorted),
      ...(held.length > 0 ? { paths: Object.fromEntries(held) } : {}),
    }),
  );
}

/**
 * What the census and the map disagree about: keys to embed (new or changed),
 * ids to re-path (the same version at a new path), ids to adopt (passages
 * still filed under the path, at the census's version), and keys to delete. Embeds
 * and re-paths go in indexing order (`compareIndexingOrder`, by path):
 * everything but the Inbox and Archive first, then the Inbox, then the
 * Archive (decided by the owner, 2026-10-08), by path within each, so a long
 * walk resumes where it stopped.
 *
 * A path key whose note the census now names by id is deleted only once the
 * id holds that note's current version (see the header); until then both
 * answer for it. An id the census lacks is deleted only from a listing that
 * reached everything (`complete`): a moved note's new folder may be the part
 * a cut-short listing never got to.
 *
 * @param {Map<string,string>} census key → version
 * @param {Map<string,string>} notes key → version embedded
 * @param {(path: string) => boolean} [regionComplete]
 * @param {{pathOf?: (key: string) => string, paths?: Map<string,string>, complete?: boolean}} [options]
 */
export function meaningDiff(census, notes, regionComplete = () => true, { pathOf = (key) => key, paths = new Map(), complete = true } = {}) {
  const byPath = (a, b) => compareIndexingOrder(pathOf(a), pathOf(b));
  const changed = [];
  const repathed = [];
  const adopted = [];
  const idAt = new Map();
  for (const [key, version] of census) {
    if (!notes.has(key) && isNoteId(key) && notes.get(pathOf(key)) === version) adopted.push(key);
    else if (notes.get(key) !== version) changed.push(key);
    else if (isNoteId(key) && paths.get(key) !== pathOf(key)) repathed.push(key);
    if (isNoteId(key)) idAt.set(pathOf(key), key);
  }
  changed.sort(byPath);
  repathed.sort(byPath);
  adopted.sort(byPath);
  const removed = [];
  for (const key of notes.keys()) {
    if (census.has(key)) continue;
    if (isNoteId(key)) {
      if (complete && regionComplete(paths.get(key) ?? "")) removed.push(key);
      continue;
    }
    const id = idAt.get(key);
    if (id !== undefined) {
      if (notes.get(id) === census.get(id)) removed.push(key);
      continue;
    }
    // Absent from a listing that never reached its folder is not gone.
    if (regionComplete(key)) removed.push(key);
  }
  removed.sort();
  return { changed, repathed, adopted, removed };
}

/**
 * One bounded pass.
 *
 * @param {object} store the workspace's store (`get`, `put`)
 * @param {object} options
 * @param {{upsert: Function, deleteByIds: Function, existingIds: Function, getByIds: Function}} options.client this workspace's index
 * @param {(texts: string[]) => Promise<number[][]>} options.embed
 * @param {Map<string,string>} options.census key → version, from the tree's listing
 * @param {(key: string) => string} [options.pathOf] where a census key's note
 *   is now; a key that is a path is its own (the default)
 * @param {(path: string) => string} options.visibilityOf `privacy.md`'s answer
 * @param {string} options.generation this life of the index
 * @param {number} [options.noteCap]
 * @param {number} [options.indexPending] notes the census itself has not reached
 * @param {(path: string) => boolean} [options.regionComplete] whether the
 *   listing behind the census reached the part of the bucket `path` is in;
 *   a path the census lacks is deleted only where it did
 * @param {(key: string) => number|null} [options.sizeOf] a census note's size
 *   in bytes, from the same listing; `null` where it reported none
 * @returns {Promise<{embedded: number, repathed: number, deleted: number, notesIndexed: number,
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
    pathOf = (key) => key,
    visibilityOf,
    generation,
    noteCap = MEANING_PASS_NOTE_CAP,
    indexPending = 0,
    regionComplete = () => true,
    sizeOf = () => null,
  },
) {
  const { notes, paths, passages: mapPassages } = await readState(store, generation);
  const diffOf = () => meaningDiff(census, notes, regionComplete, { pathOf, paths, complete: indexPending === 0 });
  const result = { embedded: 0, repathed: 0, deleted: 0, failure: null, failureCause: null, failureOperation: null, providerCodes: [], probeStatus: null, inputChars: null };
  let dirty = false;

  const finish = async () => {
    if (dirty) {
      try {
        await writeMeaningState(store, generation, notes, paths);
      } catch {
        // The vectors landed; the map did not. The next pass re-embeds what
        // this one did, which costs a model call and changes no answer.
        if (result.failure === null) {
          result.failure = "STORE_FAILED";
          result.failureCause = "store";
        }
      }
    }
    const left = diffOf();
    const notesPending = left.changed.length + left.repathed.length + left.adopted.length + left.removed.length;
    let notesIndexed = 0;
    for (const key of census.keys()) if (notes.has(key)) notesIndexed += 1;
    // Per priority, by where each note is: a census note is indexed when the
    // map holds its current version, as `meaningDiff` decides; a re-path or a
    // delete still owed is pending.
    const keyAt = new Map([...census.keys()].map((key) => [pathOf(key), key]));
    const waiting = new Set([...left.repathed, ...left.adopted]);
    const priorities = countByIndexingPriority(
      keyAt.keys(),
      (path) => {
        const key = keyAt.get(path);
        return notes.get(key) === census.get(key) && !waiting.has(key);
      },
      left.removed.map((key) => (isNoteId(key) ? (paths.get(key) ?? key) : key)),
    );
    return {
      embedded: result.embedded,
      repathed: result.repathed,
      deleted: result.deleted,
      notesIndexed,
      notesPending,
      priorities,
      ready: result.failure === null && notesPending === 0 && indexPending === 0,
      moved: result.embedded > 0 || result.repathed > 0 || result.deleted > 0,
      failure: result.failure,
      failureCause: result.failureCause,
      failureOperation: result.failureOperation,
      providerCodes: result.providerCodes,
      probeStatus: result.probeStatus,
      inputChars: result.inputChars,
    };
  };

  let changed = [];
  let repathed = [];
  let adopted = [];
  let removed = [];
  try {
    // A map written under a smaller passage cap: the notes big enough to
    // have filled it forget their version, so they are embedded again, whole.
    // Sizes come from the census's own listing, so this costs no request.
    // Only paths the census still has: one that is gone keeps its entry and
    // is deleted below with every id it can have. Once; then the map says
    // the new cap. A size the listing did not report counts as big.
    if (mapPassages < MEANING_MAX_PASSAGES) {
      const fit = bytesThatFit(mapPassages);
      for (const key of [...notes.keys()]) {
        if (!census.has(key)) continue;
        const size = sizeOf(key);
        if (!Number.isFinite(size) || size >= fit) notes.delete(key);
      }
      dirty = true;
    }
    ({ changed, repathed, adopted, removed } = diffOf());

    // Deletes first: a passage of a note that is gone is the one wrong thing
    // this index can put in front of somebody, and deleting costs no model call.
    if (removed.length > 0) {
      await removePassages(client, removed);
      for (const key of removed) {
        notes.delete(key);
        paths.delete(key);
      }
      result.deleted = removed.length;
      dirty = true;
    }

    const cap = Number.isFinite(noteCap) ? Math.max(0, Math.floor(noteCap)) : MEANING_PASS_NOTE_CAP;

    // Then moves and renames, from the vectors already held. A note whose
    // passages are not there to re-path (written before they were filed by
    // id) joins the embeds below.
    // Adopted notes are the same, read from the passages filed under their
    // path, whose old ids go once the copy has landed.
    const adopting = new Set(adopted.slice(0, cap));
    const moving = [...repathed.slice(0, cap), ...adopting];
    if (moving.length > 0) {
      const missing = new Set(
        await repathPassages(
          client,
          moving.map((key) => ({
            noteId: key,
            path: pathOf(key),
            visibility: visibilityOf(pathOf(key)),
            ...(adopting.has(key) ? { from: pathOf(key) } : {}),
          })),
        ),
      );
      const copied = [];
      for (const key of moving) {
        if (missing.has(key)) {
          notes.delete(key);
          changed.push(key);
          continue;
        }
        if (adopting.has(key)) {
          notes.set(key, census.get(key));
          copied.push(pathOf(key));
        }
        paths.set(key, pathOf(key));
        result.repathed += 1;
      }
      dirty = true;
      if (copied.length > 0) {
        await removePassages(client, copied);
        for (const path of copied) notes.delete(path);
        result.deleted += copied.length;
      }
    }
    let held = [];
    let heldTails = [];
    let heldPaths = [];
    const flush = async () => {
      if (held.length > 0) await client.upsert(held);
      await deleteStaleTails(client, heldTails);
      for (const [key, version] of heldPaths) {
        notes.set(key, version);
        if (isNoteId(key)) paths.set(key, pathOf(key));
      }
      if (heldPaths.length > 0) dirty = true;
      result.embedded += heldPaths.length;
      held = [];
      heldTails = [];
      heldPaths = [];
    };

    // A note is a bucket read and a model call, each a round trip, so notes
    // go `MEANING_PASS_CONCURRENCY` at a time rather than one after another:
    // one at a time, a 9,000-note workspace took most of a day. Results are
    // still recorded in order, and a refused call still ends the pass with
    // nothing of its group recorded, so the next pass redoes it.
    const todo = changed.slice(0, cap);
    const noteIdOf = (key) => (isNoteId(key) ? key : null);
    for (let start = 0; start < todo.length; start += MEANING_PASS_CONCURRENCY) {
      const group = todo.slice(start, start + MEANING_PASS_CONCURRENCY);
      const changes = await Promise.all(
        group.map(async (key) => {
          const path = pathOf(key);
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
            { content: await object.text(), visibility: visibilityOf(path), noteId: noteIdOf(key) },
            embed,
          );
        }),
      );
      for (let index = 0; index < group.length; index += 1) {
        const change = changes[index];
        if (change === null) continue;
        held.push(...change.vectors);
        if (change.deleteIds.length > 0) heldTails.push(change.deleteIds);
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
    result.probeStatus = error instanceof MeaningError ? (error.probeStatus ?? null) : null;
    result.inputChars = error instanceof MeaningError ? (error.inputChars ?? null) : null;
  }
  return await finish();
}
