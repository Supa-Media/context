/**
 * "Rank across workspaces" (`fuse` in search's config, `config/searchConfig.json`): one list from every workspace's,
 * by evidence. Its knobs are that step's settings (`ranking.js`); main's when a caller hands none.
 */
import { DEFAULT_SEARCH_SETTINGS } from "./settings.js";
import { FUSE_RANKING } from "./ranking.js";
import { notePrior } from "./priors.js";
import { evidenceBonus } from "./evidence.js";
import { matchesOnlyInLinks } from "./linkMatch.js";
import { looksLikeCode, queryLooksLikeCode } from "./codeLike.js";

/** Most hits a search across every workspace shows (`ranking.hits`). */
const EVERYWHERE_HITS = FUSE_RANKING.hits;

/**
 * The multiplier a named workspace's hits get (`fuseEverywhere`'s `boost`). A ranking nudge only: the
 * ranks of two hits 1.5 places apart near the top come out in the named workspace's favour.
 */
export const BOOST_FACTOR = FUSE_RANKING.boostFactor;

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
 * `boost` is the set of list indices a caller named (the workspace a question names as its topic): a hit in one
 * of those lists has its score multiplied by `BOOST_FACTOR`, after the path prior. A boost ranks, it never
 * filters: nothing is dropped or added because of it, and the same hits come back in another order.
 *
 * @param {Array<Array<object>>} lists hits per workspace, this workspace's first, each hit
 *   carrying `wordRank`, `loose` and `meaningScore` (`search/meaning/serve.js`)
 * @param {number} [most] how many hits the answer shows
 * @param {{extraNotes?: number, query?: string, boost?: Set<number> | null}} [options] the store's `extraNotes` setting
 *   (`search/settings.js`), and the query whose title and phrase evidence counts (`search/evidence.js`);
 *   without a query the order is the one the ranks give
 */
export function fuseEverywhere(lists, most = EVERYWHERE_HITS, { extraNotes = DEFAULT_SEARCH_SETTINGS.extraNotes, query, boost = null, ranking = FUSE_RANKING } = {}) {
  // Reciprocal-rank constant (the usual 60), and how far down a loose (any-word) hit is counted, so a note that
  // merely shares "team" with the query never outranks a real match (`search/ranking.js`).
  const { rrfK: RRF_K, loosePenalty: LOOSE_PENALTY } = ranking;
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
      !(anyWhole && isMeaningOnly(entry) && !(typeof entry.hit.meaningScore === "number" && entry.hit.meaningScore >= ranking.meaningFloor)),
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
  // The reranker's scores (`search/rerank.js`, when its step ran): one model read every workspace's first rows, so
  // like meaning's they rank together; a row it did not read adds nothing.
  const byRerank = eligible.filter(({ hit }) => typeof hit.rerankScore === "number").sort((a, b) => b.hit.rerankScore - a.hit.rerankScore);
  const rerankRank = new Map(byRerank.map((entry, rank) => [entry, rank]));
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
    const title = counted ? evidenceBonus(query, hit, ranking) : 0;
    const reread = rerankRank.has(entry) ? (ranking.rerankWeight ?? 1) / (RRF_K + rerankRank.get(entry) + 1) : 0;
    // The path prior (`search/priors.js`): an archived note or a log scores half
    // what the same evidence does on a live note. Hit keys carry `@name/`, which it reads through.
    const nudge = boost?.has(entry.list) ? ranking.boostFactor : 1;
    return { ...entry, score: (word + meaning + title + reread) * notePrior(hit.key, ranking) * nudge };
  });
  const byScore = (a, b) => b.score - a.score || a.list - b.list || a.order - b.order;
  const budget = anyWhole ? extraNotes : ranking.looseReads;
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
