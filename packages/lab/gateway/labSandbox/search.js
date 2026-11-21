/**
 * The Lab's search try-out, `op: "search"` on `/tex-lab/sandbox` (route.js; Dev2, 2026-11-21: a Lab draft's search
 * config next to main's, run by the Lab's Search page and by `tex_dev`). One query runs twice, as the person: once on
 * main's search config and once on a draft's, each through `findNotes` with `record: false`, so a try-out is never a
 * real search and writes no counted row. The person's own store and session only: the caller's 1:1 with Tex, opened
 * the way the nightly's real run opens it (`nightly.js`), never another person's.
 */

import { contextsFor } from "../../../../apps/mcp/src/context/identity.js";
import { loadPrivacyState } from "../../../../apps/mcp/src/privacy/state.js";
import { findNotes } from "../../../../apps/mcp/src/tools/search.js";
import { SEARCH_CONFIG, searchConfigProblems } from "../../../../apps/mcp/src/search/config/searchConfig.cjs";
import { searchConfigFromDraft } from "../../../../apps/mcp/src/search/config/labDraft.cjs";
import { attachContextOpener, onceEach } from "../fromGateway/http_contextOpener.js";
import { attachPinnedDoors } from "../fromGateway/http_pinnedDoors.js";
import { decorateRequestStore } from "../fromGateway/http_requestStore.js";
import { attachLinkCalls } from "../fromGateway/http_routing.js";
import { PINNED_CONTEXT_NAME } from "../fromGateway/orient_globalNote.js";
import { sessionFromPayload, storeForSession } from "../fromGateway/session.js";
import { json } from "../fromGateway/http_responses.js";

/** Longest query a try-out takes; a longer one is refused, not cut. */
export const MAX_SEARCH_QUERY = 300;
/** Most workspaces one try-out may name (`only`), as the app's search takes. */
const MAX_ONLY = 50;

/**
 * The op's input, checked: `{ query, versionId?, graph?, only? }`. Answers the checked parts, or the sentence to say.
 * `only` is a list of `@name`s to narrow the workspaces asked; without it the person's own setting decides.
 */
export function searchInput(input) {
  const query = typeof input?.query === "string" ? input.query : "";
  if (query.trim() === "" || query.length > MAX_SEARCH_QUERY) return { error: `query is the words to search for, at most ${MAX_SEARCH_QUERY} characters` };
  const only = input.only === undefined || input.only === null ? null : input.only;
  if (only !== null && (!Array.isArray(only) || only.length > MAX_ONLY || !only.every((name) => typeof name === "string" && name.startsWith("@")))) {
    return { error: "only is a list of @names, such as [\"@ops\"]" };
  }
  return { query, only };
}

/**
 * The draft's search config, checked. `null` when the draft holds no search steps (it then searches as main does);
 * otherwise the config, or the problems said as sentences (`searchConfigProblems`).
 */
export function draftSearchOf(graph) {
  const config = searchConfigFromDraft(graph);
  if (config === null) return { config: null };
  const problems = searchConfigProblems(config);
  return problems.length > 0 ? { error: problems.join("; ") } : { config };
}

/**
 * The steps a run logged, each as the Lab shows it: its step, its time and whether it held, and, for a step "Search
 * each workspace" calls once per workspace (open, words, meaning, merge, prior, snippets), which workspace it ran for.
 */
function stepsOf(rows) {
  return rows.map((row) => {
    const workspace = typeof row.input?.workspace === "string" ? row.input.workspace : null;
    return { node: row.node, ms: row.ms, ok: row.ok, ...(workspace ? { workspace } : {}) };
  });
}

/** One run's answer: the hits (key, title, meaningOnly), who answered, and each step. */
function answerOf(found, steps) {
  return {
    hits: found.hits.map(({ key, title, meaningOnly }) => ({ key, title: typeof title === "string" ? title : "", ...(meaningOnly ? { meaningOnly: true } : {}) })),
    searched: found.searched,
    steps,
  };
}

/**
 * The settings that differ from main, as `node.setting` names, per step. A draft's config is checked to name every
 * step and setting search reads, so a name missing on one side is a difference too.
 */
export function changedSettings(draft, main = SEARCH_CONFIG) {
  const out = [];
  const draftNodes = new Map(draft.nodes.map((n) => [n.id, n]));
  for (const mainNode of main.nodes) {
    const draftNode = draftNodes.get(mainNode.id);
    const mainSettings = mainNode.settings ?? {};
    const draftSettings = draftNode?.settings ?? {};
    const names = new Set([...Object.keys(mainSettings), ...Object.keys(draftSettings)]);
    for (const name of names) if (mainSettings[name] !== draftSettings[name]) out.push(`${mainNode.id}.${name}`);
  }
  return out;
}

/**
 * The try-out's answer for one person's store. Main and the draft run in parallel, both unrecorded. `config` is the
 * draft's search config (`draftSearchOf`), null when there is none to run.
 */
export async function searchAnswer({ store, scope, rules, overrides, query, only = null, config = null }) {
  const mainSteps = [];
  const draftSteps = [];
  const logTo = (rows) => (row) => rows.push(row);
  const [main, draft] = await Promise.all([
    findNotes(store, scope, rules, overrides, query, "", { only, record: false, log: logTo(mainSteps) }),
    config === null ? null : findNotes(store, scope, rules, overrides, query, "", { only, record: false, config, log: logTo(draftSteps) }),
  ]);
  return {
    query,
    main: answerOf(main, stepsOf(mainSteps)),
    draft: draft === null ? null : answerOf(draft, stepsOf(draftSteps)),
    changed: config === null ? [] : changedSettings(config),
  };
}

/**
 * Opens the caller's own 1:1 with Tex as a store and session, as `nightly.js` opens a real run, then answers the try-out.
 * `helpers.draftConfig` reads the draft (or a drawn graph); `helpers.refused` answers a refusal.
 */
export async function searchForPerson({ env, controlPlane, token, who, origin, helpers }, input) {
  const { draftConfig, refused } = helpers;
  const checked = searchInput(input);
  if (checked.error) return refused(400, checked.error);
  const drafted = await draftConfig(controlPlane, token, input.versionId, input.graph);
  if (drafted.error) return refused(...drafted.error);
  const draft = draftSearchOf(drafted.config);
  if (draft.error) return refused(400, draft.error);

  const answer = await controlPlane.labSandbox(token, "session", { chat: "me" });
  if (answer?.status !== "ok") return refused(404, answer?.error ?? "You have no 1:1 with Tex to search in.");
  const session = sessionFromPayload(answer.session, null, token);
  const store = await storeForSession(session, env, controlPlane);
  const request = new Request(`${origin}/agent`, { method: "POST" });
  decorateRequestStore(store, { session, env, controlPlane, ctx: { waitUntil() {}, passThroughOnException() {} }, request, origin });
  const openOnce = onceEach((target) => storeForSession(target, env, controlPlane));
  attachContextOpener(store, session, { env, controlPlane, origin, openOnce, pinnedName: PINNED_CONTEXT_NAME });
  attachPinnedDoors(store, session, (sibling) => storeForSession(sibling, env, controlPlane), (o, sibling) => attachLinkCalls(o, sibling, controlPlane, env));
  // A try-out writes no timing row either, not only no counted one: the store's own reporter is taken off for this request.
  store.reportSearchTiming = undefined;
  store.contexts = contextsFor(session);
  const privacy = await loadPrivacyState(store);
  // Fail closed, as a search does: nothing is answered without the person's access rules.
  if (privacy.error) return json({ error: "unavailable" }, 503);

  return json(await searchAnswer({ store, scope: session.scope, rules: privacy.rules, overrides: privacy.overrides, query: checked.query, only: checked.only, config: draft.config }));
}
