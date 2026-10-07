/**
 * Search by meaning, on the read side: the notes a query is *about*, merged
 * into the word search's answer as one list (the owner's pick, 2026-10-07:
 * best answer first, and a note found only by meaning is marked "Same topic,
 * different words").
 *
 * ## Privacy is decided here, not by the index
 *
 * The index's `tier` filter keeps a team caller's top matches from filling up
 * with private notes, and that is all it does. Every match goes through the
 * caller's `isVisible` (the live `privacy.md`, `canSee`) before it is used for
 * anything, ranking included, so a note made private a minute ago is gone from
 * the next search rather than the next re-index. A path under plumbing, or
 * outside the caller's prefix, is dropped the same way.
 *
 * ## It never costs the word search anything
 *
 * Absent index, a model that is down, a Vectorize that refuses: the word
 * answer comes back exactly as it would have, and the failure is one log line
 * with a closed code. The extra work is bounded: one embedding, one query, and
 * at most `MEANING_SNIPPET_READS` note reads for the matches the words missed.
 */

import { ACTIVITY_PATH } from "../../../../../packages/shared/src/activity.cjs";
import { isPlumbing } from "../../privacy/engine.js";
import { extractFields } from "../indexer.js";
import { noteTitle } from "../resultText.js";
import { createMeaningClient } from "./client.js";
import { meaningPassages, rankMeaningMatches } from "./project.js";
import { meaningEmbedderFor } from "./store.js";

/**
 * The closeness below which a match is noise rather than "the same topic".
 * bge-m3 cosine; unrelated English sits well under this. Tunable, and the
 * only number here a search quality review should need to touch.
 */
export const MEANING_MIN_SCORE = 0.55;

/** Notes found only by meaning that one search may read for a snippet. */
export const MEANING_SNIPPET_READS = 3;

/** The words a person reads beside a note found only by meaning. */
export const MEANING_ONLY_LABEL = "Same topic, different words";

/** Reciprocal-rank constant: the usual 60, so neither list's top dominates. */
const RRF_K = 60;

/** Does this store have a meaning index worth asking? A filling one is: its notes are real. */
export function meaningSearchable(store) {
  const state = store?.meaningIndex?.state;
  return state === "ready" || state === "backfilling";
}

/**
 * The notes `query` is about, best first, that this caller may see: `[{path,
 * score, chunk}]`, or `null` when meaning search is off or failed (which the
 * caller treats as "words only", never as "nothing found").
 */
export async function meaningMatches(store, { query, scope, isVisible, prefix = "", fetchImpl, embed } = {}) {
  if (!meaningSearchable(store) || typeof query !== "string" || !query.trim()) return null;
  try {
    const [vector] = await (embed ?? meaningEmbedderFor(store, { fetchImpl }))([query.trim()]);
    const client = createMeaningClient(store.meaningIndex, { fetchImpl });
    // A team caller's search is answered from team notes only (`canSee` with
    // no granted groups, as the word search calls it), so asking the index
    // for anything else would only crowd the top of the list.
    const raw = await client.query(vector, { tiers: scope === "private" ? null : ["team"] });
    return rankMeaningMatches(raw).filter(
      (match) =>
        match.score >= MEANING_MIN_SCORE &&
        match.path.endsWith(".md") &&
        match.path !== ACTIVITY_PATH &&
        !isPlumbing(match.path) &&
        (!prefix || match.path.startsWith(prefix)) &&
        isVisible(match.path),
    );
  } catch (error) {
    try {
      console.error(
        JSON.stringify({
          event: "meaning-search-failed",
          workspace: store.actor?.workspaceId,
          code: typeof error?.code === "string" ? error.code : "UNKNOWN",
        }),
      );
    } catch {
      // A log line cannot fail a search.
    }
    return null;
  }
}

/**
 * One list from two: reciprocal rank fusion over the word hits' order and the
 * meaning matches' order, so a note both find rises and a note only one finds
 * still places. Ties keep the word search's order.
 *
 * @returns {Array<{key: string, word: object|null, meaning: object|null}>}
 */
export function mergeHits(wordHits, matches) {
  const merged = new Map();
  wordHits.forEach((hit, rank) => {
    merged.set(hit.key, { key: hit.key, word: hit, meaning: null, score: 1 / (RRF_K + rank + 1), order: rank });
  });
  (matches ?? []).forEach((match, rank) => {
    const entry = merged.get(match.path);
    const add = 1 / (RRF_K + rank + 1);
    if (entry) {
      entry.meaning = match;
      entry.score += add;
    } else {
      merged.set(match.path, {
        key: match.path,
        word: null,
        meaning: match,
        score: add,
        order: wordHits.length + rank,
      });
    }
  });
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ key, word, meaning }) => ({ key, word, meaning }));
}

/** A snippet for a note found only by meaning: the start of the passage that matched. */
async function meaningSnippet(store, match) {
  let text;
  try {
    const object = await store.get(match.path);
    if (!object) return null; // moved or deleted since it was embedded
    text = await object.text();
  } catch {
    return null;
  }
  // An encrypted note's passages are its title alone (`meaningPassages` reads
  // through `indexableText`), so its snippet is empty and no ciphertext shows.
  const passages = meaningPassages(match.path, text);
  const passage = passages[match.chunk] ?? passages[0] ?? "";
  // A passage is the indexed title, a blank line, then its slice of the body
  // (`meaningPassages`), so the snippet is what follows that title.
  const indexedTitle = String(extractFields(match.path, text).title ?? "").trim();
  const body = passage.startsWith(indexedTitle) ? passage.slice(indexedTitle.length) : passage;
  const line = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return { title: noteTitle(match.path, text), snippets: line ? [line] : [] };
}

/**
 * The word search's answer with the meaning matches folded in, in the word
 * search's own hit shape plus `meaningOnly`. Every word hit stays; at most
 * `MEANING_SNIPPET_READS` notes the words missed are added among them. A
 * meaning-only note that cannot be read (moved, deleted) is dropped rather
 * than shown without a snippet that was actually read.
 *
 * `matches` is `meaningMatches`'s answer, asked for alongside the word search
 * rather than after it, so the two cost one wait, not two.
 */
export async function withMeaning(store, found, matches) {
  if (!matches || matches.length === 0) return { ...found, meaning: matches ? "none" : "off" };
  const out = [];
  let reads = 0;
  for (const entry of mergeHits(found.hits, matches)) {
    if (entry.word) {
      out.push({ ...entry.word, meaningOnly: false });
      continue;
    }
    if (reads >= MEANING_SNIPPET_READS) continue;
    reads += 1;
    const read = await meaningSnippet(store, entry.meaning);
    if (read) out.push({ key: entry.key, title: read.title, snippets: read.snippets, meaningOnly: true });
  }
  const added = out.filter((hit) => hit.meaningOnly).length;
  return { ...found, hits: out, matchCount: found.matchCount + added, meaning: "on" };
}

/** Word search and search by meaning, asked together and merged. */
export async function searchBothWays(store, wordSearch, options) {
  const [found, matches] = await Promise.all([wordSearch(), meaningMatches(store, options)]);
  return await withMeaning(store, found, matches);
}
