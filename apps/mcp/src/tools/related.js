/**
 * `related_notes`: the notes around one note, each with why.
 *
 * - `linked_from_here` and `links_here` come from the Convex tree's link
 *   facts (`ask: "neighbors"`, `apps/convex/functions/lib/nodes/neighbors.ts`),
 *   never from reading other notes. The tree judges every path at this
 *   grant's clearance and this gateway judges them again with its own engine.
 * - `related_text` is one search over the note's title and headings, through
 *   the same `searchVisibleNotes` that `search_notes` answers from, so it reads
 *   the search database where the context has one and the bucket index where
 *   it does not.
 *
 * The seed is opened by `read_note` itself, so a note this caller may not see
 * is refused exactly as an absent one is, at the same cost, before anything
 * else is asked about it; its path, text and encryption come from what that
 * read opened, never from its printed header. An encrypted seed is related by
 * its links only: its headings are not sent to a search. A drawing is searched
 * by its file name.
 *
 * Nothing here throws into the response: a part that cannot answer leaves the
 * rest standing and the answer ends `may be incomplete`.
 */

import { canSee } from "../privacy/engine.js";
import { searchVisibleNotes } from "../search/visibleNotes.js";
import { toolReadNote } from "./notes/read.js";
import { toolText } from "./results.js";

export const RELATED_DEFAULT_LIMIT = 10;
export const RELATED_MAX_LIMIT = 25;
/** Words of the title and headings one similarity search carries. */
export const RELATED_QUERY_TERMS = 12;

export async function toolRelatedNotes(store, scope, rules, overrides, args) {
  const read = await toolReadNote(store, scope, rules, overrides, args.path);
  if (read.isError) return read;
  const { path, text: body, encrypted } = read.opened;
  const limit = Math.min(RELATED_MAX_LIMIT, Math.max(1, Number.isInteger(args.limit) ? args.limit : RELATED_DEFAULT_LIMIT));
  const visible = (candidate) => typeof candidate === "string" && candidate !== path && canSee(candidate, scope, rules, overrides);

  let incomplete = false;
  const [neighbors, similar] = await Promise.all([
    neighborsOf(store, path),
    encrypted ? [] : similarTo(store, scope, rules, overrides, path, body),
  ]);
  if (neighbors === null || neighbors.complete !== true) incomplete = true;
  if (similar === null) incomplete = true;

  const reasons = new Map();
  const add = (candidate, reason) => {
    if (!visible(candidate)) return;
    if (!reasons.has(candidate)) reasons.set(candidate, []);
    if (!reasons.get(candidate).includes(reason)) reasons.get(candidate).push(reason);
  };
  for (const candidate of neighbors?.backlinks ?? []) add(candidate, "links_here");
  for (const candidate of neighbors?.links ?? []) add(candidate, "linked_from_here");
  const textRank = new Map((similar ?? []).filter(visible).map((candidate, rank) => [candidate, rank]));
  for (const candidate of textRank.keys()) add(candidate, "related_text");

  // Linked notes first, then by how close the text is, then by path.
  const linked = (candidate) => (reasons.get(candidate).some((reason) => reason !== "related_text") ? 0 : 1);
  const ranked = [...reasons.keys()].sort(
    (a, b) =>
      linked(a) - linked(b) ||
      (textRank.get(a) ?? Infinity) - (textRank.get(b) ?? Infinity) ||
      (a < b ? -1 : a > b ? 1 : 0)
  );
  const lines = ranked.slice(0, limit).map((candidate) => `${printable(candidate)} (${reasons.get(candidate).join(", ")})`);
  const out = lines.length ? lines.join("\n") : "(no related notes found)";
  return toolText(incomplete ? `${out}\nmay be incomplete` : out);
}

/** The tree's links and backlinks for `path`; `null` where it cannot answer. */
async function neighborsOf(store, path) {
  if (typeof store.treeFacts !== "function") return null;
  try {
    const answer = await store.treeFacts({ ask: "neighbors", path });
    const found = answer?.served === true ? answer.neighbors : null;
    if (!found || !Array.isArray(found.links) || !Array.isArray(found.backlinks)) return null;
    return found;
  } catch {
    return null;
  }
}

/** Paths whose text is like the seed's title and headings, best first; `null` where search could not answer. */
async function similarTo(store, scope, rules, overrides, path, body) {
  const query = seedQuery(path, body);
  if (query === "") return [];
  try {
    const found = await searchVisibleNotes(store, scope, rules, overrides, query, "");
    // A fallback scan that read every note is a whole answer; one that stopped short is not.
    if (found.indexIncomplete || found.totalIsFloor || (found.degraded && found.scannedCount < found.totalCount)) return null;
    return found.hits.map((hit) => hit.key);
  } catch {
    return null;
  }
}

/** The title (first heading, else the file name) and headings, as up to `RELATED_QUERY_TERMS` distinct words. */
export function seedQuery(path, body) {
  const headings = body
    .split("\n")
    .filter((line) => /^#{1,6}\s/.test(line))
    .map((line) => line.replace(/^#+\s*/, ""));
  const title = headings.length ? [] : [path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "")];
  const words = [];
  for (const word of [...title, ...headings].join(" ").toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (word.length < 3 || words.includes(word)) continue;
    words.push(word);
    if (words.length === RELATED_QUERY_TERMS) break;
  }
  return words.join(" ");
}

/** A path on one line: no terminator a client would read as a new one. */
function printable(path) {
  return path.replace(/[\r\n\u2028\u2029\u0085]/g, " ");
}
