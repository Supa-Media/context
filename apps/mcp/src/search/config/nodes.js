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
import { addMeaningOnly, lowerLogs, meaningMatches, meaningSearchable, mergeWithMeaning, searchBothWays } from "../meaning/serve.js";
import { phase } from "../../mcp/phase.js";
import { queryEmbedderFor } from "../meaning/queryVectors.js";
import { searchSettingsOf } from "../settings.js";
import { folderPrefix } from "../indexable.js";
import { holdSearchPasses } from "../heldPasses.js";
import { fuseEverywhere } from "../fuse.js";
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
  return { to: here || names.length > 0 ? "each" : "none", query, prefix, names, here, ...(typeof boost === "string" ? { boost } : {}) };
}

/** The person-facing numbers a Lab draft's step sets (`minScore`, `extraNotes`, `snippetChars`); main reads the store's. */
function draftNumbers(io, names) {
  if (!io.ctx.draft) return {};
  const settings = io.node?.settings ?? {};
  return Object.fromEntries(names.filter((name) => typeof settings[name] === "number").map((name) => [name, settings[name]]));
}

/**
 * `open`: one workspace opened the way a tool call addressed with `context: "@name"` opens it (`store.openContext`),
 * so it is searched under the person's role *there* and its own privacy rules: a note held back from a member is as
 * absent through this as through a direct search. The connection's own workspace is already open. The handles go back
 * to "Search each workspace" through `io.ctx.opened`, never through the output, which is logged.
 */
async function openStep(input, io) {
  const { workspace, here } = input;
  const { store, scope, rules, overrides } = io.ctx;
  const done = (handles) => {
    io.ctx.opened?.set(workspace, handles);
    return { workspace, reached: true, scope: String(handles.scope ?? ""), rules: Array.isArray(handles.rules) ? handles.rules.length : 0 };
  };
  if (here) return done({ store, scope, rules, overrides });
  try {
    const { session: target, store: targetStore } = await store.openContext(workspace);
    const privacy = await loadPrivacyState(targetStore);
    if (privacy.error) return { workspace, reached: false };
    return done({ store: targetStore, scope: target.scope, rules: privacy.rules, overrides: privacy.overrides });
  } catch {
    return { workspace, reached: false };
  }
}

/** The handles `open` left for a workspace: its store, and the person's scope and its rules there. */
const handlesOf = (io, workspace) => io.ctx.opened.get(workspace);

/** `words`: the word index's answer in one workspace (`../visibleNotes.js`), only notes the person may see. */
async function wordsStep(input, io) {
  const { store, scope, rules, overrides } = handlesOf(io, input.workspace);
  const found = await phase(store, "word_search", () => searchVisibleNotes(store, scope, rules, overrides, input.query, input.prefix));
  return { found };
}

/** `meaning`: the nearest passages in one workspace (`meaningMatches`), the query embedded once per search. */
async function meaningStep(input, io) {
  const { store, scope, rules, overrides } = handlesOf(io, input.workspace);
  const { prefix, query } = input;
  const embed = io.ctx.embed;
  const matches = await phase(store, "meaning", () =>
    meaningMatches(store, { query, scope, prefix: folderPrefix(prefix), isVisible: (path) => canSee(path, scope, rules, overrides), ...(embed ? { embed } : {}), ...draftNumbers(io, ["minScore"]) }),
  );
  return matches === null ? { off: true } : { matches, off: false };
}

/** `merge`: the two lists fused (`mergeWithMeaning`): reciprocal ranks, the meaning floor, title and phrase evidence. */
function mergeStep(input, io) {
  const matches = input.off ? null : input.matches ?? [];
  const ranking = rankingOf(io.node?.settings, DEFAULT_RANKING);
  return { merged: mergeWithMeaning(input.found, matches, { query: input.query ?? undefined, ranking }) };
}

/** `prior`: each merged score scaled by where its note lives (`lowerLogs`, `../priors.js`). */
function priorStep(input, io) {
  return { merged: lowerLogs(input.merged, rankingOf(io.node?.settings, DEFAULT_RANKING)) };
}

/** `snippets`: the closest notes only meaning found read for a snippet and added (`addMeaningOnly`). */
async function snippetsStep(input, io) {
  const { store } = handlesOf(io, input.workspace);
  const ranking = rankingOf(io.node?.settings, DEFAULT_RANKING);
  return { found: await addMeaningOnly(store, input.merged, { query: input.query ?? undefined, ranking, ...draftNumbers(io, ["extraNotes", "snippetChars"]) }) };
}

/**
 * One workspace through the steps "Search each workspace" calls (its `uses` wires): open, then words and meaning at
 * once, then merge, prior and snippets, each logged as its own run. A step that is off is passed over: words off finds
 * nothing by words, meaning off merges nothing, merge or prior off leaves the list as it came, snippets off adds no
 * meaning-only note. Null when the workspace could not be opened.
 */
async function searchWorkspace(io, { workspace, here, query, prefix, shape }) {
  const opened = await io.use.open({ workspace, here });
  if (opened && opened.reached === false) return null;
  if (!opened) {
    // "Open the workspace as you" off: only the connection's own workspace, which is already open, is searched.
    if (!here) return null;
    io.ctx.opened.set(workspace, { store: io.ctx.store, scope: io.ctx.scope, rules: io.ctx.rules, overrides: io.ctx.overrides });
  }
  const asked = { workspace, here, query, prefix };
  const [byWords, byMeaning] = await Promise.all([io.use.words(asked), io.use.meaning(asked)]);
  const found = byWords?.found ?? { hits: [], matchCount: 0, matchCountIsFloor: false };
  // The query's rules apply in the merge only when this workspace is searched alone: across several, the fusion
  // applies them from the evidence (`AS_ONE_OF_SEVERAL`).
  const ruleQuery = shape?.query === null ? null : query;
  const matchesIn = byMeaning ?? { off: true };
  const mergedOut = await io.use.merge({ workspace, query: ruleQuery, found, matches: matchesIn.matches ?? null, off: matchesIn.off });
  const fallback = { found, entries: null, meaning: matchesIn.off ? "off" : "none" };
  const merged = mergedOut?.merged ?? fallback;
  const lowered = (await io.use.prior({ workspace, merged }))?.merged ?? merged;
  const answered = await io.use.snippets({ workspace, query: ruleQuery, merged: lowered });
  if (answered) return answered.found;
  // "Add meaning-only notes" off: the merged word hits, in the answer's shape, and no note only meaning found.
  const wordsOnly = { ...lowered, entries: lowered.entries ? lowered.entries.filter((entry) => entry.word) : null };
  return addMeaningOnly(handlesOf(io, workspace).store, wordsOnly, { query: ruleQuery ?? undefined, ranking: DEFAULT_RANKING });
}

/**
 * `each`: every workspace asked, at once, this one included: waiting for this one first put a whole search in front
 * of the others. Each goes through `searchWorkspace`; a workspace that cannot be opened or read right now is left
 * out, never guessed at, and named in `unreached`.
 */
async function eachStep(input, io) {
  const { store } = io.ctx;
  const { query, prefix, names, here: searchHere, boost } = input;
  const currentName = currentNameOf(store);
  const hereName = currentName ?? HERE_LABEL;
  const several = names.length > 0;
  io.ctx.opened = new Map();
  io.ctx.embed = several ? sharedEmbedder(store) : undefined;
  // The index passes these searches start wait until every workspace has
  // answered, so none of them queues behind another's (`../heldPasses.js`).
  const passes = several ? holdSearchPasses(store) : null;
  try {
    const shape = several ? AS_ONE_OF_SEVERAL : undefined;
    const searchingHere = searchHere ? searchWorkspace(io, { workspace: hereName, here: true, query, prefix, shape }) : null;
    if (!several) {
      const alone = await searchingHere;
      return { to: "one", answer: { ...alone, searched: [hereName], unreached: [] } };
    }
    const [here, ...answers] = await Promise.all([
      searchingHere,
      ...names.map(async (name) => {
        const found = await searchWorkspace(io, { workspace: name, here: false, query, prefix: "", shape });
        return found ? { name, found } : null;
      }),
    ]);
    const workspaces = [...(here ? [{ name: hereName, here: true, found: here }] : []), ...answers.filter(Boolean)];
    return { to: "several", query, ...(typeof boost === "string" ? { boost } : {}), workspaces, unreached: names.filter((_, index) => answers[index] === null) };
  } finally {
    passes?.release();
  }
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
export const SEARCH_NODES = Object.freeze({ search: searchStep, each: eachStep, fuse: fuseStep, open: openStep, words: wordsStep, meaning: meaningStep, merge: mergeStep, prior: priorStep, snippets: snippetsStep });

/** A runner per config object: building one checks its wires, which a search need not repeat. */
const graphs = new WeakMap();
function graphFor(config, log) {
  if (log) return createGraph(config, SEARCH_NODES, { log });
  let graph = graphs.get(config);
  if (!graph) graphs.set(config, (graph = createGraph(config, SEARCH_NODES)));
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
  const { outputs } = await graphFor(config, log).run("search", input, { store, scope, rules, overrides, draft });
  return outputs.fuse?.answer ?? outputs.each?.answer ?? { ...NOTHING };
}
