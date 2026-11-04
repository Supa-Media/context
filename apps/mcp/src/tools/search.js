/** `search_notes`, and ChatGPT's `search` and `fetch`. */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { encryptedNoteRefusal, openStoredNote } from "../notes/sealing.js";
import { forwardPath, readForwarding } from "../forwarding.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { normalizePath, noteUrl } from "../notes/paths.js";
import { NOTE_INDEX_CHAR_CAP } from "../search/maintain.js";
import { noteTitle, splitReducedRecallNotes } from "../search/visible.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { searchVisibleNotes } from "../search/visibleNotes.js";
import {
  MEANING_EXTRA_FLOOR_WITH_WORDS,
  MEANING_ONLY_LABEL,
  MEANING_SNIPPET_READS_LOOSE,
  meaningSearchable,
  searchBothWays,
} from "../search/meaning/serve.js";
import { meaningEmbedderFor } from "../search/meaning/store.js";
import { DEFAULT_SEARCH_SETTINGS, searchSettingsOf } from "../search/settings.js";
import { loadPrivacyState } from "../privacy/state.js";
import { folderPrefix } from "../search/indexable.js";
import { splitMessageAnchor } from "../search/commsIndex.js";
import { toolError, toolText } from "./results.js";
import { holdSearchPasses } from "../search/heldPasses.js";
import { notePrior } from "../search/priors.js";
import { evidenceBonus } from "../search/evidence.js";
import { matchesOnlyInLinks } from "../search/linkMatch.js";
import { looksLikeCode, queryLooksLikeCode } from "../search/codeLike.js";

/** Most hits a search across every workspace shows. */
const EVERYWHERE_HITS = 12;

/** Reciprocal-rank constant, the usual 60. */
const RRF_K = 60;

/** How far down a loose (any-word) hit is counted, so a note that merely shares "team" with the query never outranks a real match. */
const LOOSE_PENALTY = 10;

/** The median of a list of numbers, or null for none. */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * One list from every workspace's, ranked by evidence rather than by
 * workspace: each hit scores its word rank in its own workspace (a loose
 * any-word hit counts as ten places lower) plus its rank among every
 * workspace's meaning matches put together, which are comparable because one
 * model scored them all. A note strong both ways rises; a workspace's first
 * word hit for a query that has nothing to do with it does not outrank
 * another workspace's note the query was about. Ties keep the lists' order,
 * this workspace first.
 *
 * A loose hit's words count only while no workspace has a note holding every
 * word. Each workspace retries with any word only when it found nothing with
 * all of them, so its loose hits are not comparable with another's real
 * matches: an index page holding "note" outranked the person's own note
 * holding all four words (2026-11-03). Such a hit then places by its meaning
 * alone.
 *
 * A strict word hit with no meaning score takes the median meaning rank of the
 * hits that have one, rather than none: the meaning index builds behind
 * searches, so a fresh note has no fingerprint for a while (production
 * benchmark, 2026-11-03).
 *
 * With the query, a counted word hit also adds what its title and file name
 * say about the query, which no workspace's corpus changes (`search/evidence.js`,
 * decided 2026-11-03): `TITLE_WEIGHT` for each share of the query's terms its
 * title holds, and `PHRASE_BONUS` when the whole query is a phrase in it. It
 * goes in before the path prior, so an archived note's bonus is halved too.
 *
 * Meaning-only hits (no word rank: found by what the note is about) are one
 * budget for the whole answer, not one per workspace. Once any workspace has a
 * strict word hit, a meaning-only hit must reach `MEANING_EXTRA_FLOOR_WITH_WORDS`
 * and at most `extraNotes` of them are kept, the closest ones; otherwise at
 * most `MEANING_SNIPPET_READS_LOOSE`. A kept meaning-only hit is marked
 * `meaningOnly: true`, as `withMeaning` marks them.
 *
 * @param {Array<Array<object>>} lists hits per workspace, this workspace's first, each hit
 *   carrying `wordRank`, `loose` and `meaningScore` (`search/meaning/serve.js`)
 * @param {number} [most] how many hits the answer shows
 * @param {{extraNotes?: number, query?: string}} [options] the store's `extraNotes` setting
 *   (`search/settings.js`), and the query whose title and phrase evidence counts (`search/evidence.js`);
 *   without a query the order is the one the ranks give
 */
export function fuseEverywhere(lists, most = EVERYWHERE_HITS, { extraNotes = DEFAULT_SEARCH_SETTINGS.extraNotes, query } = {}) {
  const texts = (hit) => [hit.title, ...(Array.isArray(hit.snippets) ? hit.snippets : [])].filter((text) => typeof text === "string");
  // A word hit whose terms sit only inside a link's address counts as a loose
  // one (`search/linkMatch.js`): production, 2026-11-03, "workers comp renewal"
  // put a review note that held only a link to the real page above the page.
  const all = lists.flatMap((hits, list) =>
    hits.map((hit, order) => {
      const linkOnly = typeof query === "string" && typeof hit.wordRank === "number" && !hit.loose && matchesOnlyInLinks(query, texts(hit));
      return { hit: linkOnly ? { ...hit, loose: true } : hit, list, order, original: hit };
    }),
  );
  const anyWhole = all.some(({ hit }) => typeof hit.wordRank === "number" && !hit.loose);
  const isMeaningOnly = ({ hit }) => typeof hit.wordRank !== "number";
  // A passage of code found only by meaning is noise for a question asked in
  // prose (`search/codeLike.js`): the same search added three code passages
  // as "Same topic, different words". A query that is itself code keeps them.
  const proseQuery = typeof query === "string" && !queryLooksLikeCode(query);
  const codeOnly = (entry) => proseQuery && isMeaningOnly(entry) && looksLikeCode(texts(entry.hit).slice(1).join(" "));
  // Meaning-only hits must be close to be worth a row once the words found a note with every word.
  const eligible = all.filter(
    (entry) =>
      !codeOnly(entry) &&
      !(anyWhole && isMeaningOnly(entry) && !(typeof entry.hit.meaningScore === "number" && entry.hit.meaningScore >= MEANING_EXTRA_FLOOR_WITH_WORDS)),
  );
  // The meaning ranking is over the eligible hits; the budget below only removes
  // meaning-only hits from the answer, after the ranks are set.
  const byMeaning = eligible
    .filter(({ hit }) => typeof hit.meaningScore === "number")
    .sort((a, b) => b.hit.meaningScore - a.hit.meaningScore);
  const meaningRank = new Map(byMeaning.map((entry, rank) => [entry, rank]));
  // A note not yet fingerprinted (see the test header) takes the middle of the
  // meaning ranking, not nothing: the index builds behind searches.
  const medianRank = median(byMeaning.map((_, rank) => rank));
  const scored = eligible.map((entry) => {
    const { hit } = entry;
    const counted = typeof hit.wordRank === "number" && !(hit.loose && anyWhole);
    const word = counted ? 1 / (RRF_K + hit.wordRank + 1 + (hit.loose ? LOOSE_PENALTY : 0)) : 0;
    const strictWord = typeof hit.wordRank === "number" && !hit.loose;
    let meaning = 0;
    if (meaningRank.has(entry)) meaning = 1 / (RRF_K + meaningRank.get(entry) + 1);
    else if (strictWord && medianRank !== null) meaning = 1 / (RRF_K + medianRank + 1);
    // The title and phrase evidence (`search/evidence.js`): only for a word hit that counts,
    // so a loose hit gets none while a strict one exists, as its words do not count either.
    const title = counted ? evidenceBonus(query, hit) : 0;
    // The path prior (`search/priors.js`): an archived note or a log scores half
    // what the same evidence does on a live note. Hit keys carry `@name/`, which it reads through.
    return { ...entry, score: (word + meaning + title) * notePrior(hit.key) };
  });
  const byScore = (a, b) => b.score - a.score || a.list - b.list || a.order - b.order;
  const budget = anyWhole ? extraNotes : MEANING_SNIPPET_READS_LOOSE;
  const extras = scored.filter(isMeaningOnly).sort(byScore);
  const overBudget = new Set(extras.slice(budget));
  const answer = scored
    .filter((entry) => !overBudget.has(entry))
    .sort(byScore)
    .slice(0, most);
  for (const entry of answer) if (isMeaningOnly(entry)) entry.original.meaningOnly = true;
  // The hits as given: a link-only hit's `loose` was a ranking signal, never part of the answer.
  return answer.map(({ original }) => original);
}

/**
 * The merge shape for a workspace searched as one of several (`searchEverywhere`). `fuseEverywhere` applies the
 * query's rules across workspaces from the evidence it is given, so the workspace's own merge must not apply them
 * again: that would count a code passage or a link-only hit twice, and reorder what the fusion reads.
 */
export const AS_ONE_OF_SEVERAL = Object.freeze({ query: null });

/** Word search and search by meaning in one workspace, as `search_notes` has always asked. */
export function searchOne(store, scope, rules, overrides, query, prefix, embed, shape = undefined) {
  return searchBothWays(
    store,
    () => searchVisibleNotes(store, scope, rules, overrides, query, prefix),
    // A folder, never the start of a sibling's name: see `folderPrefix`. The
    // app answers alike (`apps/convex/__tests__/searchParity.test.ts`).
    { query, scope, prefix: folderPrefix(prefix), isVisible: (path) => canSee(path, scope, rules, overrides), ...(embed ? { embed } : {}) },
    shape,
  );
}

/**
 * One query, one fingerprint: the embedder of the connection's own store,
 * remembered after the first call, so a search across six workspaces embeds
 * the query once. Undefined when this store has no meaning index, and each
 * workspace then embeds on its own terms.
 */
function sharedEmbedder(store) {
  if (!meaningSearchable(store)) return undefined;
  // The promise, not the vector: every workspace asks at once, and the
  // ones that ask while the first embedding is still out wait for it.
  let vector = null;
  return async (texts) => {
    vector ??= meaningEmbedderFor(store)(texts).then(([first]) => first);
    return [await vector];
  };
}

/**
 * `search_notes` across every workspace the person can reach: the default
 * since 2026-10-10 (the setting `everywhere`, `../search/settings.js`; asked
 * for by the owner so an assistant need not guess which workspace an answer
 * lives in, and made the default by him once the benchmark showed it finds
 * everything a one-workspace search finds and more). A call that names a
 * workspace with `context:`, or narrows with `prefix`, searches that one.
 *
 * Each other workspace is opened the way a tool call addressed with
 * `context: "@name"` opens it (`store.openContext`), so it is searched under
 * the person's role *there* and its own `privacy.md`: a note held back from a
 * member is as absent through this as through a direct search. A workspace
 * that cannot be opened or read right now is left out, never guessed at. The
 * lists are fused by evidence (`fuseEverywhere`), and a hit from another
 * workspace carries its name in front of the path.
 */
async function searchEverywhere(store, searchingHere, names, query, embed) {
  // Every workspace at once, this one included: waiting for this one first
  // put a whole search in front of the others. `searchingHere` is null when
  // the app's search page left this workspace out of its scope.
  const [here, ...answers] = await Promise.all([
    searchingHere,
    ...names.map(async (name) => {
      try {
        const { session: target, store: targetStore } = await store.openContext(name);
        const privacy = await loadPrivacyState(targetStore);
        if (privacy.error) return null;
        const found = await searchOne(targetStore, target.scope, privacy.rules, privacy.overrides, query, "", embed, AS_ONE_OF_SEVERAL);
        return { name, found };
      } catch {
        return null;
      }
    }),
  ]);
  const elsewhere = answers.filter(Boolean);
  const annotated = (found, name = null) =>
    found.hits.map((hit) => ({ ...hit, ...(found.evidence?.[hit.key] ?? {}), key: name ? `${name}/${hit.key}` : hit.key }));
  const hits = fuseEverywhere(
    [...(here ? [annotated(here)] : []), ...elsewhere.map(({ name, found }) => annotated(found, name))],
    EVERYWHERE_HITS,
    { extraNotes: searchSettingsOf(store).extraNotes, query },
  );
  const base = here ?? { hits: [], matchCount: 0, matchCountIsFloor: false };
  return {
    ...base,
    hits,
    matchCount: elsewhere.reduce((total, { found }) => total + found.matchCount, base.matchCount),
    matchCountIsFloor: base.matchCountIsFloor || elsewhere.some(({ found }) => found.matchCountIsFloor),
    crossWorkspace: hits.some((hit) => hit.key.startsWith("@")),
  };
}

/**
 * What `search_notes` finds, before it is written out: the hits (a key with `@name/` in front where it is another
 * workspace's), the counts, and the index's state. One path for an AI client's search and the app's search bar
 * (`http/appSearch.js`; the search revamp, 2026-11-04).
 *
 * `only`, from the app's scope picker, narrows the workspaces asked to those it names (`@slug`); without it, the
 * person's setting (`everywhere`) decides, as for an AI client.
 */
export async function findNotes(store, scope, rules, overrides, query, prefix = "", { only = null } = {}) {
  const reachable = typeof store.openContext === "function"
    ? (store.contexts ?? []).filter((entry) => !entry.current && typeof entry.name === "string").map((entry) => entry.name)
    : [];
  const currentName = (store.contexts ?? []).find((entry) => entry.current)?.name ?? null;
  const asked = Array.isArray(only) ? new Set(only) : null;
  const searchHere = asked === null || (currentName !== null && asked.has(currentName));
  // A prefix names a folder in this workspace, so a search with one stays here.
  const names = prefix
    ? []
    : asked !== null
    ? reachable.filter((name) => asked.has(name))
    : searchSettingsOf(store).everywhere
    ? reachable
    : [];
  if (!searchHere && names.length === 0) return { hits: [], matchCount: 0, matchCountIsFloor: false };
  const embed = names.length > 0 ? sharedEmbedder(store) : undefined;
  // The index passes these searches start wait until every workspace has
  // answered, so none of them queues behind another's (`search/heldPasses.js`).
  const passes = names.length > 0 ? holdSearchPasses(store) : null;
  try {
    const here = searchHere ? searchOne(store, scope, rules, overrides, query, prefix, embed, names.length > 0 ? AS_ONE_OF_SEVERAL : undefined) : null;
    return names.length > 0 ? await searchEverywhere(store, here, names, query, embed) : await here;
  } finally {
    passes?.release();
  }
}

export async function toolSearchNotes(store, scope, rules, overrides, query, prefixArg) {
  if (!query || typeof query !== "string") return toolError("query required");
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix");
  const found = await findNotes(store, scope, rules, overrides, query, prefix);
  const hits = found.hits.map(({ key, snippets, title, meaningOnly }) =>
    meaningOnly
      ? // Found by what it is about, not by the words typed: said so, so an
        // agent does not quote the snippet as if it carried the term.
        `${key}\n    (${MEANING_ONLY_LABEL})\n${(snippets.length ? snippets : [title])
          .map((line) => `    ${line}`)
          .join("\n")}`
      : snippets.length
      ? `${key}\n${snippets.map((line) => `    ${line}`).join("\n")}`
      : // Indexed, then edited: it matched when it was indexed and its current
        // text does not carry the term. The title was actually read; a snippet
        // here would be invented.
        `${key}\n    ${title}`
  );
  // An empty search is the moment an agent decides the context is useless and
  // answers from its own head. It is almost always the wrong conclusion — the
  // note exists under a word the user would have used and this query did not —
  // so the miss says what to try instead of stopping the sentence at "no".
  let out = hits.length
    ? `${found.matchCount}${found.matchCountIsFloor ? "+" : ""} matching note${
        found.matchCount === 1 && !found.matchCountIsFloor ? "" : "s"
      }${hits.length < found.matchCount ? ` — the ${hits.length} best shown` : ""}\n\n${hits.join(
        "\n\n"
      )}`
    : "(no matches)\n\nA miss usually means the wrong word rather than the wrong assumption — " +
      (found.meaning === "off"
        ? "this searches the words in the notes, not their meaning. "
        : "this searched the words in the notes and what they are about, and nothing was close. ") +
      "Before concluding it is not " +
      "written down: try the term the user would have typed, drop the prefix if you passed " +
      "one, or call orient / list_notes to see which folders exist. And if the note is long, " +
      `a note is indexed by its opening ${NOTE_INDEX_CHAR_CAP.toLocaleString("en-US")} characters, ` +
      "so a term deep inside a saved session or a long log will not match here even though " +
      "read_note returns the whole file.";
  // The floor, in the language the census and orient already use. Deliberately
  // no number: how many notes are still unindexed is a fact about the whole
  // bucket, private notes included, and this connection may not be able to see
  // them.
  if (found.indexIncomplete) {
    out +=
      "\n\n[note: the search index is still catching up on this context, so these results may " +
      "be incomplete — searching again continues the backfill]";
  }
  // Distinct from the banner above on purpose (`docs/decisions/search.md`,
  // sizing section): that one resolves by searching again, and this one does
  // not — a channel-day note past the index's per-shard capacity keeps
  // exactly one summary document until the note itself shrinks or the index
  // gets more room. Named rather than counted, and only the notes this
  // caller may already see: `found.reducedRecallNotes` is pre-filtered by
  // `isVisible`, the same as every hit above it.
  if (found.reducedRecall && found.reducedRecallNotes?.length) {
    // Bounded for the same reason `orient`'s copy is: unbounded, a mailbox
    // that sheds by the day turns a one-hit answer into 23,000 characters of
    // warning, which buries the hits this search did find. The overflow is
    // counted rather than dropped — see `RENDERED_RECALL_NOTE_LIMIT`.
    const { shown, rest } = splitReducedRecallNotes(found.reducedRecallNotes);
    out +=
      "\n\n[note: these notes hold more messages than the search index can keep in full, so a " +
      "term that appeared only in a message it had to drop will not surface here even though " +
      "the note itself still exists and read_note always returns it whole — a miss on one of " +
      `these is not proof the content is gone, only that this search cannot reach all of it: ` +
      `${shown.join(", ")}${rest ? ` (+${rest} more)` : ""}]`;
  }
  if (found.degraded && (found.totalCount > found.scannedCount || found.totalIsFloor)) {
    out += `\n\n[note: scanned ${found.scannedCount} of ${found.totalCount}${
      found.totalIsFloor ? "+" : ""
    } notes — narrow with a prefix if needed]`;
  }
  if (found.crossWorkspace) {
    out +=
      '\n\nA path that starts with @name/ is in that workspace: pass context: "@name" with its path to read_note, or to any other tool, to reach it.';
  }
  return toolText(out);
}

/** The first heading if the note has one, else its filename. */
export async function toolOpenAiSearch(store, scope, rules, overrides, query) {
  if (!query || typeof query !== "string") return toolError("query required");
  const { hits } = await searchBothWays(
    store,
    () => searchVisibleNotes(store, scope, rules, overrides, query, ""),
    { query, scope, isVisible: (path) => canSee(path, scope, rules, overrides) },
  );
  // Titles come from the text already fetched for the snippets, so a result
  // costs no read of its own. This used to spend a second GET per hit, which
  // doubled the most expensive part of the old scan.
  const results = hits.map(({ key, title, snippets }) => ({
    id: key,
    title,
    text: (snippets.length ? snippets.join(" … ") : title).slice(0, 400),
    url: noteUrl(key),
  }));
  return toolText(JSON.stringify({ results }));
}

export async function toolOpenAiFetch(store, scope, rules, overrides, idArg) {
  // `search` answers a message inside a channel-day note with the id
  // `<notePath>#<anchor>`, and `fetch(id)` is the only thing ChatGPT does
  // with an id it was given. Split before the `.md` test, which that id
  // would otherwise fail one line before the read ever happened.
  const path = splitMessageAnchor(normalizePath(idArg) ?? "").path;
  if (!path || !path.endsWith(".md")) return toolError("invalid id");
  if (isPlumbing(path)) return toolError("not found");
  /*
    `read_note`'s rule, because this is `read_note`: the resolution runs the
    same way for everybody and the decision is taken once both answers are in,
    so the refusal for a note being held back costs what the refusal for an
    absent one costs. It resolves on metadata and fetches the body only after
    both questions have passed — this door was the widest of the four, 1 trip
    against 3.
  */
  const seen = canSee(path, scope, rules, overrides);
  let present = Boolean(await probeWithLegacyFallback(store, path));
  // Metadata can report a logical-delete marker as present. Resolve the
  // authorized logical object before deciding whether the stale path needs
  // forwarding, exactly as read_note does; otherwise a tombstone suppresses
  // the forwarding lookup and the fetch ends as a false not-found.
  let obj = seen && present ? await getWithLegacyFallback(store, path) : null;
  if (seen && present && !obj) present = false;
  if (!seen || !present) {
    const forwarded = forwardPath(await readForwarding(store), path);
    if (forwarded !== null && forwarded !== path && canSee(forwarded, scope, rules, overrides)) {
      const landed = await probeWithLegacyFallback(store, forwarded);
      if (landed && seen && !present) {
        const landedObject = await getWithLegacyFallback(store, forwarded);
        if (landedObject) {
          present = true;
          obj = landedObject;
        }
      }
    }
  }
  if (!seen || !present) return toolError("not found");
  if (!obj) return toolError("not found");
  const stored = await obj.text();
  // The same decrypt `read_note` does, because this is `read_note` wearing
  // OpenAI's contract and "a second path is a second place for a bug". A note
  // this request cannot open is refused rather than answered with its envelope
  // — returning the ciphertext as `text` would put it in a chat transcript.
  const opened = await openStoredNote(store, stored);
  if (!opened.ok) return encryptedNoteRefusal(path);
  return toolText(
    JSON.stringify({
      id: path,
      title: noteTitle(path, opened.text),
      text: opened.text,
      url: noteUrl(path),
      metadata: { etag: obj.etag, encrypted: opened.encrypted || undefined },
    })
  );
}
