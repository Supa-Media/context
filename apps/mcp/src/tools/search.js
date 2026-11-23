/** `search_notes`, and ChatGPT's `search` and `fetch`. */

import { canSee } from "../privacy/engine.js";
import { normalizePath, noteUrl } from "../notes/paths.js";
import { NOTE_INDEX_CHAR_CAP } from "../search/maintain.js";
import { splitReducedRecallNotes } from "../search/visible.js";
import { searchVisibleNotes } from "../search/visibleNotes.js";
import { MEANING_ONLY_LABEL, searchBothWays } from "../search/meaning/serve.js";
import { toolError, toolText } from "./results.js";
import { reportCountedSearch } from "../search/quality.js";
import { runSearch } from "../search/config/nodes.js";

export { BOOST_FACTOR, fuseEverywhere } from "../search/fuse.js";
export { AS_ONE_OF_SEVERAL, searchOne } from "../search/config/nodes.js";

/**
 * What `search_notes` finds, before it is written out: the hits (a key with `@name/` in front where it is another
 * workspace's), the counts, and the index's state. One path for an AI client's search and the app's search bar
 * (`http/appSearch.js`; the search revamp, 2026-11-04), run from search's own config (`search/config/searchConfig.json`,
 * its steps in `search/config/nodes.js`; Dev2, 2026-11-21).
 *
 * `only`, from the app's scope picker, narrows the workspaces asked to those it names (`@slug`); without it, the
 * person's setting (`everywhere`) decides, as for an AI client.
 *
 * `boost`, from an assistant's call (`search_notes` with `boost: "@name"`), ranks the named workspace's hits
 * higher and never filters: every workspace the person reaches is still searched, and the answer names them all
 * in `searched`. The named one is reached even when it is the pinned workspace (`PINNED_CONTEXT_NAME`), as `only` reaches it.
 *
 * `config` is a Lab draft's search config, to search on it instead of main's.
 *
 * `record`, false from the Lab's try-outs, answers the same and writes no counted row (`reportCountedSearch`): a
 * try-out is not a real search, so it does not count in the search-quality numbers.
 *
 * The answer carries `searched` (who actually answered, this workspace first, by its `@name`, else "their own
 * workspace") and `unreached` (the names that could not be opened, read or searched).
 */
/** One line for a search's steps (`findNotes`): each step's start after the first, and its time, in ms. */
function logStepTimes(steps) {
  if (steps.length === 0) return;
  const t0 = Math.min(...steps.map((row) => (typeof row.at === "number" ? row.at : Infinity)));
  const start = Number.isFinite(t0) ? t0 : 0;
  const end = Math.max(...steps.map((row) => (typeof row.at === "number" ? row.at - start : 0) + row.ms));
  console.log(JSON.stringify({ event: "step_times", total: end, steps: steps.map((row) => [row.node, typeof row.at === "number" ? row.at - start : null, row.ms]) }));
}

export async function findNotes(store, scope, rules, overrides, query, prefix = "", { only = null, boost = null, config = undefined, log = null, record = true } = {}) {
  store.lastSearch = null;
  // The one counted row for this search is written from here, after the answer is fused (`search/quality.js`).
  store.searchRowPending = true;
  try {
    // Each step's start and time, one line per search (`step_times`): where a live search's time goes, step by step,
    // with no word of the query or of a note in it.
    const steps = [];
    const keep = (row) => {
      if (row && typeof row.node === "string" && typeof row.ms === "number") steps.push(row);
      if (log) log(row);
    };
    // A bench run's draft (`search/config/benchDraft.js`) when no config is named.
    const chosen = config ?? store.searchConfig
    const answer = await runSearch({ store, scope, rules, overrides, query, prefix, only, boost, ...(chosen ? { config: chosen } : {}), log: keep });
    logStepTimes(steps);
    if (record) reportCountedSearch(store, answer.hits.map((hit) => hit.key));
    return answer;
  } finally {
    store.searchRowPending = false;
  }
}


export async function toolSearchNotes(store, scope, rules, overrides, query, prefixArg, { boost } = {}) {
  if (!query || typeof query !== "string") return toolError("query required");
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix: pass a folder path, like projects/, or leave prefix out");
  const found = await findNotes(store, scope, rules, overrides, query, prefix, { boost });
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
  // Last, so the list of workspaces a search read is what an agent sees at the end of its answer. Left off a
  // one-workspace search, so that search's text stays byte-identical to what other clients have always read.
  const askedBoost = typeof boost === "string" && boost.trim() !== "";
  // A workspace that could not be opened is always named, so a miss is never told as covering it.
  if (found.searched.length > 1 || askedBoost || found.unreached.length > 0) {
    out += `\n\nSearched: ${found.searched.join(", ")}.`;
    if (found.unreached.length > 0) out += ` Not reachable just now, so not searched: ${found.unreached.join(", ")}.`;
  }
  return found.unreached.length > 0 ? { ...toolText(out), searched: found.searched, unreached: found.unreached } : { ...toolText(out), searched: found.searched };
}

/** The first heading if the note has one, else its filename. */
export async function toolOpenAiSearch(store, scope, rules, overrides, query, prefixArg) {
  if (!query || typeof query !== "string") return toolError("query required");
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix: pass a folder path, like projects/, or leave prefix out");
  store.lastSearch = null;
  store.searchRowPending = true;
  let hits;
  try {
    ({ hits } = await searchBothWays(
      store,
      () => searchVisibleNotes(store, scope, rules, overrides, query, prefix),
      { query, scope, isVisible: (path) => canSee(path, scope, rules, overrides) && (!prefix || path === prefix || path.startsWith(`${prefix}/`)) },
    ));
    reportCountedSearch(store, hits.map((hit) => hit.key));
  } finally {
    store.searchRowPending = false;
  }
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
