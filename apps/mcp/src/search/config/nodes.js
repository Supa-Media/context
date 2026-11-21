/**
 * SEARCH'S STEPS, RUN FROM ITS CONFIG (Dev2, 2026-11-21: search gets a config graph of its own, edited in the Lab).
 *
 * Each step of `searchConfig.json` is one function here, by its id; the wires between them are never here: the shared
 * graph runner (`packages/tex/src/texGraph.cjs`, the one interpreter of wires, Tex's and search's) reads them from the
 * config. A step's settings are its node's (`io.node.settings`), so a Lab draft that changes one runs a search on it.
 *
 *   search  which workspaces a search asks.
 *   each    words and meaning in every workspace asked, at once, each merged by `each`'s ranking.
 *   fuse    every workspace's hits ranked together by `fuse`'s ranking (only when several answered).
 *
 * `runSearch` is the one entry: `findNotes` (`tools/search.js`) for an AI client's search_notes, the app's search
 * bar and Tex, and a Lab draft's search with that draft's config.
 */
import graphLib from "../../../../../packages/tex/src/texGraph.cjs";
import { canSee } from "../../privacy/engine.js";
import { loadPrivacyState } from "../../privacy/state.js";
import { PINNED_CONTEXT_NAME } from "../../orient/globalNote.js";
import { searchVisibleNotes } from "../visibleNotes.js";
import { meaningSearchable, searchBothWays } from "../meaning/serve.js";
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

/** The tuning a step's settings give `searchOne`: its ranking, and, on a Lab draft, the three person-facing numbers. */
function tuningOf(node, draft) {
  const settings = node?.settings ?? {};
  const ranking = rankingOf(settings, DEFAULT_RANKING);
  if (!draft) return { ranking };
  const out = { ranking };
  for (const name of ["minScore", "extraNotes", "snippetChars"]) if (typeof settings[name] === "number") out[name] = settings[name];
  return out;
}

/**
 * `each`: every workspace asked, at once, this one included: waiting for this one first put a whole search in front
 * of the others. Each other workspace is opened the way a tool call addressed with `context: "@name"` opens it
 * (`store.openContext`), so it is searched under the person's role *there* and its own privacy rules: a note held back
 * from a member is as absent through this as through a direct search. A workspace that cannot be opened or read right
 * now is left out, never guessed at, and named in `unreached`.
 */
async function eachStep(input, io) {
  const { store, scope, rules, overrides, draft = false } = io.ctx;
  const { query, prefix, names, here: searchHere, boost } = input;
  const tuning = tuningOf(io.node, draft);
  const currentName = currentNameOf(store);
  const several = names.length > 0;
  const embed = several ? sharedEmbedder(store) : undefined;
  // The index passes these searches start wait until every workspace has
  // answered, so none of them queues behind another's (`../heldPasses.js`).
  const passes = several ? holdSearchPasses(store) : null;
  try {
    const searchingHere = searchHere ? searchOne(store, scope, rules, overrides, query, prefix, embed, several ? AS_ONE_OF_SEVERAL : undefined, tuning) : null;
    if (!several) {
      const alone = await searchingHere;
      return { to: "one", answer: { ...alone, searched: [currentName ?? HERE_LABEL], unreached: [] } };
    }
    const [here, ...answers] = await Promise.all([
      searchingHere,
      ...names.map(async (name) => {
        try {
          const { session: target, store: targetStore } = await store.openContext(name);
          const privacy = await loadPrivacyState(targetStore);
          if (privacy.error) return null;
          const found = await searchOne(targetStore, target.scope, privacy.rules, privacy.overrides, query, "", embed, AS_ONE_OF_SEVERAL, tuning);
          return { name, found };
        } catch {
          return null;
        }
      }),
    ]);
    const workspaces = [...(here ? [{ name: currentName ?? HERE_LABEL, here: true, found: here }] : []), ...answers.filter(Boolean)];
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
export const SEARCH_NODES = Object.freeze({ search: searchStep, each: eachStep, fuse: fuseStep });

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
