/**
 * `related_notes`: the notes around one note, each with why.
 *
 * - `linked_from_here` and `links_here` come from the Convex tree's link
 *   facts (`ask: "neighbors"`, `apps/convex/functions/lib/nodes/neighbors.ts`),
 *   never from reading other notes. The tree judges every path at this
 *   grant's clearance and this gateway judges them again with its own engine.
 * - `related_text` is one search over what the note's prose is about (`seedQuery`), through
 *   the same `searchVisibleNotes` that `search_notes` answers from, so it reads
 *   the search database where the context has one and the bucket index where
 *   it does not.
 *
 * The seed is opened by `read_note` itself, so a note this caller may not see
 * is refused exactly as an absent one is, at the same cost, before anything
 * else is asked about it; its path, text and encryption come from what that
 * read opened, never from its printed header. An encrypted seed is related by
 * its links only: its words are not sent to a search. A drawing is searched
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
/** Words of what a note is about that one similarity search carries (`seedQuery`). */
export const RELATED_QUERY_TERMS = 12;
/** Fewer prose words than this and the title joins the query. */
export const MIN_BODY_TERMS = 3;

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
  const textRank = new Map((similar ?? []).filter((candidate) => visible(candidate) && (isTemplatePath(path) || !isTemplatePath(candidate))).map((candidate, rank) => [candidate, rank]));
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

/** Paths whose text is like what the seed is about, best first; `null` where search could not answer. */
async function similarTo(store, scope, rules, overrides, path, body) {
  const query = seedQuery(path, body);
  if (query === "") return [];
  try {
    // The seed holds every word of its own query; asked apart, the notes holding most of them answer instead.
    const found = await searchVisibleNotes(store, scope, rules, overrides, query, "", { apart: path });
    // A fallback scan that read every note is a whole answer; one that stopped short is not.
    if (found.indexIncomplete || found.totalIsFloor || (found.degraded && found.scannedCount < found.totalCount)) return null;
    return found.hits.map((hit) => hit.key);
  } catch {
    return null;
  }
}

/**
 * What a note is about, as up to `RELATED_QUERY_TERMS` distinct words: the words of its prose, names first (a word
 * written capitalised mid-sentence: Gibeah, Benjamin), then by how often it says them. Headings, link lines and
 * navigation lines are left out: notes made from one template share every heading, so a query of headings finds the
 * template and its copies, never the note that is about the same thing (Judges 19 found Galatians 2 and the chapter
 * template, never Genesis 19; 2026-11-20). The title, else the file name, is the query only when the prose gives
 * fewer than `MIN_BODY_TERMS` words.
 */
export function seedQuery(path, body) {
  const headings = body.split("\n").filter((line) => /^#{1,6}\s/.test(line)).map((line) => line.replace(/^#+\s*/, ""));
  const counts = new Map();
  const named = new Set();
  for (const line of body.split("\n")) {
    if (/^\s*(#{1,6}\s|[-*_]{3,}\s*$|[\w ]{1,20}:\s*(\[\[|\[|$))/.test(line)) continue;
    const prose = line.replace(/!?\[\[[^\]]*\]\]/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ");
    let sentenceStart = true;
    for (const token of prose.split(/([^\p{L}\p{N}_']+)/u)) {
      if (!/[\p{L}\p{N}]/u.test(token)) {
        if (/[.!?:;]/.test(token)) sentenceStart = true;
        continue;
      }
      const word = token.toLowerCase().replace(/'s$/, "").replace(/'/g, "");
      if (word.length >= 3 && !SEED_STOP_WORDS.has(word) && !/^\d+$/.test(word)) {
        counts.set(word, (counts.get(word) ?? 0) + 1);
        if (!sentenceStart && /^\p{Lu}/u.test(token)) named.add(word);
      }
      sentenceStart = false;
    }
  }
  const order = [...counts.keys()];
  const ranked = order.sort((a, b) => Number(named.has(b)) - Number(named.has(a)) || counts.get(b) - counts.get(a));
  if (ranked.length >= MIN_BODY_TERMS) return ranked.slice(0, RELATED_QUERY_TERMS).join(" ");
  const title = headings.length ? headings[0] : path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  const words = [...ranked];
  for (const word of title.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (word.length < 3 || words.includes(word)) continue;
    words.push(word);
  }
  return words.slice(0, RELATED_QUERY_TERMS).join(" ");
}

/** A note under a folder named Templates is a blank form, never related by its text, unless the seed is one too. */
export function isTemplatePath(path) {
  return /(^|\/)templates?\//i.test(String(path ?? ""));
}

/** Prose words that say nothing about what a note is about. */
const SEED_STOP_WORDS = new Set(
  ("the and for are but not you all any can had her was one our out his has him how its may new now old see two who " +
    "did get got let say she too use way why yes also back been both came come does done down each even ever from " +
    "gave give goes gone have here into just keep kept know last like look made make many more most much must next " +
    "only onto other over same seem some such take than that them then there these they this those thus time very " +
    "want were what when where which while whom will with would your about above after again being below could every " +
    "first going might never often quite really shall should since still their thing think though three under until " +
    "upon whole whose without").split(" ")
);
/** A path on one line: no terminator a client would read as a new one. */
function printable(path) {
  return path.replace(/[\r\n\u2028\u2029\u0085]/g, " ");
}
