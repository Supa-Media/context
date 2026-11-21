/**
 * SEARCH'S STEPS, RUN FROM ITS CONFIG (Dev2, 2026-11-21: search gets a config graph of its own, edited in the Lab).
 *
 * Each step of `searchConfig.json` is one function here, by its id; the wires between them are never here: the shared
 * graph runner (`packages/tex/src/texGraph.cjs`, the one interpreter of wires, Tex's and search's) reads them from the
 * config. A step's settings are its node's (`io.node.settings`), so a Lab draft that changes one runs a search on it.
 *
 *   search    which workspaces a search asks.
 *   each      every workspace asked, at once, each through the steps below (its `uses` wires), each a run of its own:
 *     open      the workspace opened as the person: their role there and its privacy rules.
 *     words     the word index's hits, only notes the person may see.
 *     meaning   the nearest passages to the query's embedding, only notes the person may see.
 *     merge     the two lists fused: reciprocal ranks, the meaning floor, title and phrase evidence.
 *     prior     logs and archive scaled down.
 *     snippets  the closest notes only meaning found, read for a snippet and added.
 *   fuse      every workspace's hits ranked together by `fuse`'s ranking (only when several answered).
 *
 * `runSearch` is the one entry: `findNotes` (`tools/search.js`) for an AI client's search_notes, the app's search
 * bar and Tex, and a Lab draft's search with that draft's config.
 */
import graphLib from "../../../../../packages/tex/src/texGraph.cjs";
import { canSee } from "../../privacy/engine.js";
import { loadPrivacyState } from "../../privacy/state.js";
import { PINNED_CONTEXT_NAME } from "../../orient/globalNote.js";
import { searchVisibleNotes } from "../visibleNotes.js";
import { meaningMatches, meaningSearchable, readMeaningOnly, searchBothWays } from "../meaning/serve.js";
import { addEvidence, answerHits, closeMeaning, dropProbes, lowerByPath, meaningBudget, mergeLists, rankingFor } from "../stages.js";
import { phase } from "../../mcp/phase.js";
import { queryEmbedderFor } from "../meaning/queryVectors.js";
import { searchSettingsOf } from "../settings.js";
import { folderPrefix } from "../indexable.js";
import { holdSearchPasses } from "../heldPasses.js";
import { fuseEverywhere } from "../fuse.js";
import { rerankAcross, rerankWordHits } from "../rerank.js";
import { DEFAULT_RANKING, FUSE_RANKING, rankingOf } from "../ranking.js";
import searchConfig from "./searchConfig.cjs";

const { createGraph } = graphLib;
const { SEARCH_CONFIG, searchConfigOf } = searchConfig;

/** A workspace name with the leading `@` and case dropped, so `@Kiln-Guild` and `kiln-guild` compare equal. */
const bareName = (name) => String(name).replace(/^@/, "").toLowerCase();

/** The `@name` of the workspace this connection is in, or the words that stand for it when the store names none. */
const currentNameOf = (store) => (store.contexts ?? []).find((entry) => entry?.current)?.name ?? null;
const HERE_LABEL = "their own workspace";

/** What a search that asks nobody answers. */
const NOTHING = Object.freeze({ hits: [], matchCount: 0, matchCountIsFloor: false, searched: [], unreached: [] });

/**
 * The merge shape for a workspace searched as one of several. `fuseEverywhere` applies the query's rules across
 * workspaces from the evidence it is given, so the workspace's own merge must not apply them again: that would count
 * a code passage or a link-only hit twice, and reorder what the fusion reads.
 */
export const AS_ONE_OF_SEVERAL = Object.freeze({ query: null });

/**
 * Word search and search by meaning in one workspace, as `search_notes` has always asked. `tuning` is a search graph
 * step's: its `ranking` (`../ranking.js`), and, from a Lab draft, `minScore`, `extraNotes` and `snippetChars`; without
 * it the workspace ranks by main's config and the store's settings.
 */
export function searchOne(store, scope, rules, overrides, query, prefix, embed, shape = undefined, tuning = null) {
  const { minScore, ...merge } = tuning ?? {};
  return searchBothWays(
    store,
    () => searchVisibleNotes(store, scope, rules, overrides, query, prefix),
    // A folder, never the start of a sibling's name: see `folderPrefix`. The
    // app answers alike (`apps/convex/__tests__/searchParity.test.ts`).
    { query, scope, prefix: folderPrefix(prefix), isVisible: (path) => canSee(path, scope, rules, overrides), ...(embed ? { embed } : {}), ...(typeof minScore === "number" ? { minScore } : {}) },
    tuning ? { ...(shape ?? {}), ...merge } : shape,
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
    vector ??= queryEmbedderFor(store)(texts).then(([first]) => first);
    return [await vector];
  };
}

/**
 * `search`: the workspaces a search asks. Every one the person can reach is the default since 2026-10-10 (the
 * setting `everywhere`, `../settings.js`; asked for by the owner so an assistant need not guess which workspace an
 * answer lives in). A folder (`prefix`) keeps it here; `only`, from the app's scope picker, narrows it to the names
 * it lists.
 *
 * Context.LC's own pinned workspace is reached by every account for its guides and Tex's setup, never for the
 * person's notes: a search everywhere leaves it out unless they run it (owner or editor), or it is asked by name
 * (`only` from the app, `boost` from an assistant). In the core benchmark (2026-11-05) Tex's own prompt,
 * `@context-lc/ai/production/texting-assistant.md`, ranked among "What do I have on October 20?"'s hits.
 */
function searchStep(input, io) {
  const { store } = io.ctx;
  const { query, prefix, only = null, boost = null } = input;
  const boostName = typeof boost === "string" && boost.trim() !== "" ? bareName(boost) : null;
  const reachable = typeof store.openContext === "function"
    ? (store.contexts ?? [])
        .filter((entry) => !entry.current && typeof entry.name === "string")
        .filter((entry) => entry.name !== PINNED_CONTEXT_NAME || entry.role === "owner" || entry.role === "editor" || (Array.isArray(only) && only.includes(entry.name)) || (boostName !== null && bareName(entry.name) === boostName))
        .map((entry) => entry.name)
    : [];
  const currentName = currentNameOf(store);
  const asked = Array.isArray(only) ? new Set(only) : null;
  const here = asked === null || (currentName !== null && asked.has(currentName));
  // A prefix names a folder in this workspace, so a search with one stays here.
  const names = prefix
    ? []
    : asked !== null
    ? reachable.filter((name) => asked.has(name))
    : searchSettingsOf(store).everywhere
    ? reachable
    : [];
  return { to: here || names.length > 0 ? "open" : "none", query, prefix, names, here, ...(typeof boost === "string" ? { boost } : {}) };
}

/** The person-facing numbers a Lab draft's step sets (`minScore`, `extraNotes`, `snippetChars`); main reads the store's. */
function draftNumbers(io, names) {
  if (!io.ctx.draft) return {};
  const settings = io.node?.settings ?? {};
  return Object.fromEntries(names.filter((name) => typeof settings[name] === "number").map((name) => [name, settings[name]]));
}

/** What every step after `open` hands on: the search as asked, and each workspace's state so far. */
const carry = (input, workspaces, more = {}) => ({
  query: input.query,
  prefix: input.prefix,
  several: input.several,
  ...(typeof input.boost === "string" ? { boost: input.boost } : {}),
  workspaces,
  unreached: input.unreached,
  ...more,
});

/** The handles `open` left for a workspace: its store, and the person's scope and its rules there. */
const handlesOf = (io, name) => io.ctx.opened.get(name);

/** The query's rules (title and phrase evidence, link-only and code passages) apply in a workspace searched alone;
 * across several, "Merge across workspaces" applies them from the evidence (`AS_ONE_OF_SEVERAL`). */
const ruleQuery = (input) => (input.several ? null : input.query);

/** One step that does the same thing in every workspace, each workspace's state replaced by `fn`'s. */
const perWorkspace = (fn) => async (input, io) => carry(input, await Promise.all(input.workspaces.map((ws) => fn(ws, input, io))));

/**
 * `open`: every workspace asked, opened the way a tool call addressed with `context: "@name"` opens it
 * (`store.openContext`), so it is searched under the person's role *there* and its own privacy rules: a note held back
 * from a member is as absent through this as through a direct search. The connection's own workspace is already open.
 * One that cannot be opened or read now is left out, never guessed at, and named in `unreached`. The handles go to the
 * later steps through `io.ctx.opened`, never through the output, which is logged.
 */
async function openStep(input, io) {
  const { store, scope, rules, overrides } = io.ctx;
  const { query, prefix, names, here, boost } = input;
  const hereName = currentNameOf(store) ?? HERE_LABEL;
  const several = names.length > 0;
  io.ctx.opened = new Map();
  if (here) io.ctx.opened.set(hereName, { store, scope, rules, overrides });
  // One query, one fingerprint across workspaces (`sharedEmbedder`); a search here alone embeds on its own terms.
  io.ctx.embed = several ? sharedEmbedder(store) : undefined;
  // The index passes these searches start wait until every workspace has answered (`../heldPasses.js`).
  io.ctx.passes = several ? holdSearchPasses(store) : null;
  const others = await Promise.all(
    names.map(async (name) => {
      try {
        const { session: target, store: targetStore } = await store.openContext(name);
        const privacy = await loadPrivacyState(targetStore);
        if (privacy.error) return null;
        io.ctx.opened.set(name, { store: targetStore, scope: target.scope, rules: privacy.rules, overrides: privacy.overrides });
        return name;
      } catch {
        return null;
      }
    }),
  );
  const workspaces = [...(here ? [{ name: hereName, here: true }] : []), ...others.filter(Boolean).map((name) => ({ name, here: false }))];
  return carry({ query, prefix, several, boost, unreached: names.filter((_, i) => others[i] === null) }, workspaces);
}

/** `words` (nominates): the word index's hits in every workspace at once (`../visibleNotes.js`), only notes the person may see. */
async function wordsStep(input, io) {
  const byWords = {};
  await Promise.all(
    input.workspaces.map(async (ws) => {
      const { store, scope, rules, overrides } = handlesOf(io, ws.name);
      try {
        byWords[ws.name] = await phase(store, "word_search", () => searchVisibleNotes(store, scope, rules, overrides, input.query, ws.here ? input.prefix : ""));
      } catch (error) {
        // Another workspace that cannot answer now is left out and named, as one that cannot be opened is; this one throws.
        if (ws.here) throw error;
        byWords[ws.name] = null;
      }
    }),
  );
  return carry(input, input.workspaces, { byWords });
}

/**
 * `rerankWords` (ranks; off on main): the word hits read beside the query by the cross-encoder as soon as the word
 * search answers, in one call for every workspace, while `meaning` still runs (`../rerank.js` `rerankWordHits`); each
 * hit read keeps its score, which `rerank` uses without reading the note again.
 */
async function rerankWordsStep(input, io) {
  const { rerankTop = 8, rerankChars } = io.node?.settings ?? {};
  if (input.byWords === undefined) return carry(input, input.workspaces, { log: { reranked: { skipped: "words is off" } } });
  const { byWords, reranked } = await rerankWordHits(aiOf(input, io), input.query, input.byWords, { rerankTop, ...(rerankChars ? { rerankChars } : {}) });
  return carry(input, input.workspaces, { byWords, log: { reranked } });
}

/** The gateway's Workers AI binding, for the reranker: the same for every workspace. */
const aiOf = (input, io) => io.ctx.store?.ai ?? input.workspaces.map((ws) => handlesOf(io, ws.name)?.store?.ai).find(Boolean) ?? null;

/** `meaning` (nominates): the nearest passages to the query's embedding in every workspace at once (`meaningMatches`). */
async function meaningStep(input, io) {
  const byMeaning = {};
  const embed = io.ctx.embed;
  await Promise.all(
    input.workspaces.map(async (ws) => {
      const { store, scope, rules, overrides } = handlesOf(io, ws.name);
      const prefix = folderPrefix(ws.here ? input.prefix : "");
      byMeaning[ws.name] = await phase(store, "meaning", () =>
        meaningMatches(store, { query: input.query, scope, prefix, isVisible: (path) => canSee(path, scope, rules, overrides), ...(embed ? { embed } : {}), ...draftNumbers(io, ["minScore"]) }),
      );
    }),
  );
  return carry(input, input.workspaces, { byMeaning });
}

/**
 * `visible` (filters): both nominators' lists side by side per workspace, each note checked once more against the
 * person's access there (`canSee`), so nothing they may not see goes on, whatever a nominator answered. A workspace
 * whose word search failed is left out and named in `unreached`.
 */
function visibleStep(input, io) {
  const workspaces = [];
  const unreached = [...input.unreached];
  for (const ws of input.workspaces) {
    // Words off nominates nothing by words; a workspace whose word search failed is left out.
    const found = input.byWords === undefined ? { hits: [], matchCount: 0, matchCountIsFloor: false } : input.byWords[ws.name];
    if (!found) {
      unreached.push(ws.name);
      continue;
    }
    const { scope, rules, overrides } = handlesOf(io, ws.name);
    const may = (path) => canSee(path, scope, rules, overrides);
    const matches = input.byMeaning?.[ws.name] ?? null;
    const hits = found.hits.filter((hit) => may(hit.key));
    workspaces.push({
      name: ws.name,
      here: ws.here,
      found: hits.length === found.hits.length ? found : { ...found, hits, matchCount: Math.max(0, found.matchCount - (found.hits.length - hits.length)) },
      matches: matches === null ? null : matches.filter((match) => may(match.path)),
      // Whether meaning was asked and answered at all (null: off), and whether it found anything, before any filter.
      meaning: matches === null ? "off" : matches.length > 0 ? "on" : "none",
    });
  }
  return carry({ ...input, unreached }, workspaces);
}

/** `probes` (filters): a benchmark's search probe dropped from the word hits (`dropProbes`). */
const probesStep = perWorkspace((ws) => ({ ...ws, found: dropProbes(ws.found) }));

/** `floor` (filters): a note only meaning found must reach `meaningFloor` once the words found a note with every word. */
const floorStep = perWorkspace((ws, _input, io) => ({ ...ws, matches: closeMeaning(ws.found, ws.matches, rankingFor(io.node?.settings)) }));

/** `merge`: one row per note from the two lists, by reciprocal rank (`mergeLists`); none when meaning found nothing. */
const mergeStep = perWorkspace((ws, input, io) => ({ ...ws, entries: mergeLists(ws.found.hits, ws.matches, "key", ruleQuery(input) ?? undefined, rankingFor(io.node?.settings), ws.meaning === "on") }));

/** `title` (ranks): a word hit holding the query in its title or file name, or the whole query as a phrase, rises. */
const titleStep = perWorkspace((ws, input, io) => ({ ...ws, entries: addEvidence(ws.entries, ruleQuery(input) ?? undefined, rankingFor(io.node?.settings)) }));

/** `prior` (ranks): logs and archive scaled down (`lowerByPath`). */
const priorStep = perWorkspace((ws, _input, io) => ({ ...ws, entries: lowerByPath(ws.entries, rankingFor(io.node?.settings)) }));

/** `budget` (filters): the best few notes only meaning found are kept (`meaningBudget`). */
const budgetStep = perWorkspace((ws, _input, io) => {
  const { store } = handlesOf(io, ws.name);
  const extraNotes = draftNumbers(io, ["extraNotes"]).extraNotes ?? searchSettingsOf(store).extraNotes;
  return { ...ws, entries: meaningBudget(ws.found, ws.entries, { extraNotes, ranking: rankingFor(io.node?.settings) }) };
});

/** `snippets`: each kept note only meaning found is read for its title and the passage that matched. */
const snippetsStep = perWorkspace(async (ws, _input, io) => {
  const { store } = handlesOf(io, ws.name);
  const chars = draftNumbers(io, ["snippetChars"]).snippetChars ?? searchSettingsOf(store).snippetChars;
  return { ...ws, entries: await readMeaningOnly(store, ws.entries, chars) };
});

/**
 * `rerank` (ranks; off on main): each workspace's first rows read beside the query by a cross-encoder (`../rerank.js`)
 * on the Workers AI binding its store carries; each read row adds a part for its place and keeps the model's score for
 * "Rank across workspaces". Never adds or drops a row; without a model, or when it fails, the rows stand.
 */
async function rerankStep(input, io) {
  const { rerankTop = 20, rerankWeight = 1, rerankChars, readLate = 1 } = io.node?.settings ?? {};
  // Where meaning found nothing there are no rows yet: the word hits become rows in their own order, so the reranker
  // reads them too and, finding nothing to say, leaves that order.
  const rows = input.workspaces.map((ws) => ws.entries ?? (ws.found.hits.length > 1 ? mergeLists(ws.found.hits, [], "key", undefined, DEFAULT_RANKING, true) : null));
  // One call for every workspace (none when `rerankWords` read them all early): the gateway's own Workers AI.
  const ai = aiOf(input, io);
  // The query itself, in one workspace or several: the reranker reads it beside the note, which no rule changes.
  const { lists, reranked } = await rerankAcross(ai, input.query, rows, { rerankTop, rerankWeight, rrfK: DEFAULT_RANKING.rrfK, readLate, ...(rerankChars ? { rerankChars } : {}) });
  const read = reranked.read > 0;
  return carry(input, input.workspaces.map((ws, i) => ({ ...ws, entries: read && lists[i] !== rows[i] ? lists[i] : ws.entries })), { log: { reranked } });
}

/**
 * `code` (filters): a code passage found only by meaning is not offered for a prose question, and a note that could not
 * be read is dropped; each workspace's answer then takes the word search's hit shape (`answerHits`).
 */
async function codeStep(input, io) {
  const out = await perWorkspace((ws) => ({ name: ws.name, here: ws.here, found: answerHits(ws.found, ws.entries, { query: ruleQuery(input) ?? undefined, meaning: ws.meaning }) }))(input, io);
  return { ...out, to: input.several ? "several" : "one" };
}

/** `answer`: what the search answers: the fused list across workspaces, or the one workspace's. */
function answerStep(input) {
  if (input.answer) return { answer: input.answer };
  const ws = input.workspaces?.[0];
  if (!ws) return { answer: { ...NOTHING } };
  return { answer: { ...ws.found, searched: [ws.name], unreached: [] } };
}

/**
 * `fuse`: one list from every workspace's, ranked by evidence (`../fuse.js`), a hit from another workspace carrying
 * its name in front of the path. `boost` names one workspace (`@name`): its list, or this one's when it is the current
 * workspace, is boosted in the fusion, never searched instead of or in addition to the others. `searched` is who
 * actually answered, this workspace first.
 */
function fuseStep(input, io) {
  const { store, draft = false } = io.ctx;
  const { query, boost, workspaces, unreached } = input;
  const ranking = rankingOf(io.node?.settings, FUSE_RANKING);
  const currentName = currentNameOf(store);
  const boosted = new Set();
  if (typeof boost === "string" && boost.trim() !== "") {
    const wanted = bareName(boost);
    workspaces.forEach((w, index) => {
      if (w.here ? currentName !== null && bareName(currentName) === wanted : bareName(w.name) === wanted) boosted.add(index);
    });
  }
  const annotated = ({ found, name, here }) =>
    found.hits.map((hit) => ({ ...hit, ...(found.evidence?.[hit.key] ?? {}), key: here ? hit.key : `${name}/${hit.key}` }));
  const extraNotes = draft && typeof io.node?.settings?.extraNotes === "number" ? io.node.settings.extraNotes : searchSettingsOf(store).extraNotes;
  const hits = fuseEverywhere(workspaces.map(annotated), ranking.hits, { extraNotes, query, boost: boosted, ranking });
  const hereOne = workspaces.find((w) => w.here);
  const elsewhere = workspaces.filter((w) => !w.here);
  const base = hereOne?.found ?? { hits: [], matchCount: 0, matchCountIsFloor: false };
  return {
    answer: {
      ...base,
      hits,
      matchCount: elsewhere.reduce((total, { found }) => total + found.matchCount, base.matchCount),
      matchCountIsFloor: base.matchCountIsFloor || elsewhere.some(({ found }) => found.matchCountIsFloor),
      crossWorkspace: hits.some((hit) => hit.key.startsWith("@")),
      searched: workspaces.map(({ name }) => name),
      unreached,
    },
  };
}

/** Every search step's code, by its id in `searchConfig.json`. */
export const SEARCH_NODES = Object.freeze({
  search: searchStep,
  open: openStep,
  words: wordsStep,
  meaning: meaningStep,
  visible: visibleStep,
  probes: probesStep,
  floor: floorStep,
  merge: mergeStep,
  title: titleStep,
  prior: priorStep,
  budget: budgetStep,
  snippets: snippetsStep,
  rerankWords: rerankWordsStep,
  rerank: rerankStep,
  code: codeStep,
  fuse: fuseStep,
  answer: answerStep,
});

/**
 * A config with every step that is off passed over: its wires in are joined to its wires out, so a Lab draft can turn
 * one step off and score the search without it (Dev2, 2026-11-21: "decent chunks... that can be tested in of itself").
 * Words or meaning off nominates nothing by that way. The steps every search needs (`ALWAYS_ON`) are refused off by
 * the schema.
 */
function withOffPassedOver(config) {
  const off = new Set(config.nodes.filter((n) => n.on === false).map((n) => n.id));
  if (off.size === 0) return config;
  let edges = config.edges;
  for (const id of off) {
    const into = edges.filter((e) => e.to === id);
    const outOf = edges.filter((e) => e.from === id);
    const joined = into.flatMap((a) => outOf.filter((b) => b.to !== a.from).map((b) => ({ ...a, to: b.to })));
    edges = [...edges.filter((e) => e.from !== id && e.to !== id), ...joined];
  }
  const seen = new Set();
  edges = edges.filter((e) => {
    const key = `${e.from}>${e.to}>${(e.when ?? []).join(",")}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
  return { ...config, edges };
}

/**
 * How many notes a step handed on, all workspaces together, so the Lab shows where notes were added and removed (Dev2,
 * 2026-11-21): a nominator's hits or matches, a filter's or a ranker's rows, the answer's hits. Null for a step that
 * hands on no notes (the query, opening the workspaces). Counted from the whole output, before the log cuts it: a real
 * search's rows run far past the log's size.
 */
export function notesHandedOn(_node, output) {
  if (!output || typeof output !== "object") return null;
  const count = (list) => (Array.isArray(list) ? list.length : 0);
  if (output.answer && Array.isArray(output.answer.hits)) return output.answer.hits.length;
  if (output.byWords) return Object.values(output.byWords).reduce((n, found) => n + count(found?.hits), 0);
  if (output.byMeaning) return Object.values(output.byMeaning).reduce((n, matches) => n + count(matches), 0);
  if (!Array.isArray(output.workspaces) || !output.workspaces.some((ws) => ws.found)) return null;
  return output.workspaces.reduce((n, ws) => n + (Array.isArray(ws.entries) ? ws.entries.length : count(ws.found?.hits) + count(ws.matches)), 0);
}

/** A runner per config object: building one checks its wires, which a search need not repeat. */
const graphs = new WeakMap();
function graphFor(config, log) {
  // Concurrent: the two nominators, fed by the same step, run side by side.
  if (log) return createGraph(withOffPassedOver(config), SEARCH_NODES, { log, concurrent: true, count: notesHandedOn });
  let graph = graphs.get(config);
  if (!graph) graphs.set(config, (graph = createGraph(withOffPassedOver(config), SEARCH_NODES, { concurrent: true })));
  return graph;
}

/**
 * Run one search on a config: main's, or a Lab draft's (`config`, checked against the search schema first, so a
 * draft that names a setting out of bounds is refused, never half-used). `log` receives each step's run (the Lab
 * shows them). Answers what `findNotes` has always answered.
 */
export async function runSearch({ store, scope, rules, overrides, query, prefix = "", only = null, boost = null, config = SEARCH_CONFIG, log = null }) {
  const draft = config !== SEARCH_CONFIG;
  if (draft) searchConfigOf(config);
  const input = { query, prefix, ...(Array.isArray(only) ? { only } : {}), ...(typeof boost === "string" ? { boost } : {}) };
  const ctx = { store, scope, rules, overrides, draft };
  try {
    const { outputs } = await graphFor(config, log).run("search", input, ctx);
    return outputs.answer?.answer ?? { ...NOTHING };
  } finally {
    ctx.passes?.release();
  }
}
