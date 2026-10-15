/**
 * Turning one note into the passages its meaning index holds.
 *
 * ## Passages, not notes
 *
 * A fingerprint of a whole long note is a blur of everything in it; a search
 * for one thing it says lands far from it. So a note is cut into overlapping
 * passages of about a paragraph or three, each fingerprinted on its own, with
 * the note's title in front so a passage deep in a note still carries what the
 * note is about. The best passage decides where the note ranks.
 *
 * **At most `MEANING_MAX_PASSAGES` per note.** The rest of a very long note is
 * still found by its words (exact search has no such cap); it is not found by
 * meaning past that point. The cap keeps one enormous note from costing more
 * model time than a whole ordinary workspace, and it is what makes ids
 * enumerable: a note's ids are the same fixed list every time, so deleting a
 * note, or the old half of a move, needs no record of how many passages it had.
 *
 * It was 12 (about 16,000 characters) until 2026-10-10, which cut a recorded
 * meeting off a little past its half-hour mark: the owner searched "leaving
 * the team" for a 51-minute call where someone talks about not doing their
 * role anymore, and that part of the transcript was never in the index. 48
 * covers about 65,000 characters, a call of an hour and a half. Raising it
 * again is safe the same way: the catch-up pass re-embeds the notes that
 * filled the old cap (`catchup.js`, `passages` in its map).
 *
 * ## Ids carry no path
 *
 * An id is a hash of the path plus the passage number. The path itself rides as
 * metadata (it is what a hit is turned back into), but an id that is a hash can
 * be computed for deletion from the path alone, and is the same length whatever
 * the path is — Vectorize caps ids at 64 bytes and paths have no such cap.
 *
 * ## Tier, and what it is not
 *
 * The visibility a note had when it was written, `private` or `team` (a group
 * rule counts as private: narrower than everyone, and the safe side). It lets a
 * team member's query skip private passages so their few dozen candidates are
 * spent on notes they can open. It is never the access check — `canSee` runs on
 * every hit at search time — and an unknown visibility indexes nothing.
 */

import { extractFields } from "../indexer.js";
import { chunkText } from "../d1/project.js";
import { indexableText } from "../../encryption.js";

export const MEANING_PASSAGE_CHARS = 1_500;
export const MEANING_PASSAGE_OVERLAP = 150;
export const MEANING_MAX_PASSAGES = 48;

/** The tier one visibility's passages are written at, or `undefined`. */
export function meaningTierFor(visibility) {
  if (visibility === "team") return "team";
  if (visibility === "private") return "private";
  if (typeof visibility === "string" && visibility.startsWith("@")) return "private";
  return undefined;
}

async function pathHash(path) {
  const bytes = new TextEncoder().encode(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 20), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Every id one note's passages can have, in passage order. */
export async function meaningIdsFor(path) {
  const hash = await pathHash(path);
  return Array.from({ length: MEANING_MAX_PASSAGES }, (_, index) => `${hash}-${index}`);
}

/**
 * The texts to fingerprint for one note, in passage order.
 *
 * Always at least one when the note has a title or any words, so a note with
 * only a title is still findable by what its title means. An empty file still
 * has a title (its file name, `extractFields`'s fallback), so it yields one.
 */
export function meaningPassages(path, content) {
  // An encrypted note is its title and nothing else, exactly as fast search
  // projects it (`d1/backfill.js`): no plaintext reaches an index we hold, and
  // no ciphertext either, which would embed as noise.
  const fields = extractFields(path, indexableText(typeof content === "string" ? content : ""));
  const title = typeof fields.title === "string" ? fields.title.trim() : "";
  const body = typeof fields.body === "string" ? fields.body.trim() : "";
  if (!title && !body) return [];
  const bodies = body ? chunkText(body, MEANING_PASSAGE_CHARS, MEANING_PASSAGE_OVERLAP) : [""];
  return bodies
    .slice(0, MEANING_MAX_PASSAGES)
    .map((part) => [title, part].filter((piece) => piece.length > 0).join("\n\n"));
}

/**
 * What writing one note means for its index: vectors to upsert, and ids to
 * delete (the passages a longer earlier version had and this one does not).
 *
 * An unknown visibility writes nothing and deletes every id, so a note is
 * removed rather than guessed into a tier.
 */
export async function meaningChangeFor(path, { content, visibility }, embed) {
  const ids = await meaningIdsFor(path);
  const tier = meaningTierFor(visibility);
  const passages = tier === undefined ? [] : meaningPassages(path, content);
  if (passages.length === 0) return { vectors: [], deleteIds: ids };
  const values = await embed(passages);
  const vectors = passages.map((_, index) => ({
    id: ids[index],
    values: values[index],
    metadata: { path, chunk: index, tier },
  }));
  return { vectors, deleteIds: ids.slice(passages.length) };
}

/**
 * Notes ranked by their best passage, best first, without repeats.
 *
 * `matches` are `client.query` results; scores are cosine similarity, higher
 * is closer. Ties fall to the path, so the order is stable.
 */
export function rankMeaningMatches(matches) {
  const best = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const seen = best.get(match.path);
    if (!seen || match.score > seen.score) best.set(match.path, match);
  }
  return [...best.values()].sort(
    (a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

/**
 * Delete the passages past each rewritten note's new end, where it has any.
 * `tails` are `meaningChangeFor`'s non-empty `deleteIds`, one list a note.
 *
 * A note's passages in the index are always a run from 0: every write upserts
 * passages 0 to n-1 and then deletes from n on, and a removal deletes them
 * all. So whether passage n exists says whether anything past it does, and
 * one `get_by_ids` of 20 such ids answers for 20 notes. Deleting every id a
 * note could have instead costs two or three requests a note, and Cloudflare's
 * API answers 1,200 requests in five minutes for everything this token does.
 *
 * The one way to break the run is a delete refused part-way (its groups go in
 * parallel): what it left past a gap stays until that note is next written by
 * an AI client, or removed, both of which delete every id. That is a note
 * ranking for words it no longer has, never one shown to somebody who could
 * not open it: `canSee` runs on every hit.
 */
export async function deleteStaleTails(client, tails) {
  if (tails.length === 0) return;
  const present = await client.existingIds(tails.map((ids) => ids[0]));
  const stale = tails.filter((ids) => present.has(ids[0])).flat();
  if (stale.length > 0) await client.deleteByIds(stale);
}

/** Passages of a removed note deleted without asking first: the old cap's worth. */
const REMOVE_HEAD = 12;

/**
 * Take every passage of `paths` out of the index. The first `REMOVE_HEAD` of
 * each go unasked, which is all most notes have; the rest only where the
 * note has any (`deleteStaleTails`), so removing a moved folder of short
 * notes costs what it did before the cap grew. Tails go first, so a delete
 * refused part-way leaves each note's passages a run from 0.
 */
export async function removePassages(client, paths) {
  const all = await Promise.all(paths.map((path) => meaningIdsFor(path)));
  await deleteStaleTails(client, all.map((ids) => ids.slice(REMOVE_HEAD)).filter((tail) => tail.length > 0));
  await client.deleteByIds(all.flatMap((ids) => ids.slice(0, REMOVE_HEAD)));
}
