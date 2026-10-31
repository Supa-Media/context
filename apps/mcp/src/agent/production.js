/**
 * THE ASSISTANT'S SETUP, ONE NOTE PER JOB.
 *
 * Decided by the owner, 2026-10-08: the assistant's model and its prompt come
 * from one plain Markdown note per job in the pinned `@context-lc` workspace,
 * `ai/production/texting-assistant.md` for texted turns. A turn that is not
 * texted has no production setup and uses the built-in words in `prompt.js`
 * (the app assistant's note was removed by the owner, 2026-10-17: "remove 'app
 * assistant' that doesnt exist right now"). Promoting a new setup is editing
 * that file; the gateway does not ship. The rest of `ai/`
 * is the benchmark that decides what goes in it, and is never read here.
 *
 * A file is read the way `orient`'s global note is (`orient/globalNote.js`):
 * through the caller's own reach into the pinned workspace and its
 * `privacy.md`, so a person's assistant is never told a word that person could
 * not read there, and who may change it is who may write `@context-lc`
 * (staff). Self-hosted deployments have no pinned workspace and use the
 * built-in words in `prompt.js`.
 *
 * The file is YAML front matter and a body:
 *
 *   models.main    the built-in model (`@cf/…`, `anthropic/claude-…`, a catalog
 *                  model like `openai/gpt-…`, or a gateway route `dynamic/<name>`)
 *   models.router  optional, with `models.think`: the decision model that picks
 *                  a tier for each text (`router.js`; only Clef, for now)
 *   models.think   the model a `think` text runs on instead of `models.main`;
 *                  without a router, with `think_rounds`, the model a
 *                  background job's turn plans on before `main` drives
 *                  (`modelPlan.js`, the owner, 2026-10-31)
 *   models.route_at optional, with the router: the confidence (0 to 1) a
 *                  `think` pick needs before the text goes to `models.think`;
 *                  `router.js`'s default when absent. Lower routes more.
 *   models.think_rounds 1-9, how many model rounds of a `think` text run on
 *                  `think` before `main` drives the rest; a round after a
 *                  failed call goes back to `think` once (`modelPlan.js`, the
 *                  owner, 2026-10-17). With a router it is optional (absent:
 *                  the whole turn on `think`); with `think` and no router it is
 *                  required, and only a background job's turn plans.
 *   models.effort  optional low|medium|high|xhigh|max: how hard `main` thinks
 *                  (Claude's `output_config.effort`; the model's own default,
 *                  medium, when absent)
 *   models.think_effort optional, with `think`: the same for `think`
 *   models.advisor optional: the model `main` may consult with the `send`
 *                  action `advisor` (`advisor.js`, the Tex Devs meeting,
 *                  2026-10-30); never `models.main`
 *   models.advisor_effort optional, with `advisor`: the same for the advisor
 *   models.fallback optional: the model a turn goes on with when the one it
 *                  was on failed after its retry (decided by the owner,
 *                  2026-10-09; another model than `main`, or it is no fallback)
 *   search         optional: the search settings this setup's turns use over
 *                  the deployment's (`search/settings.js`): everywhere,
 *                  min_score, extra_notes, snippet_chars
 *   skills         optional: task how-tos the assistant may read (`skills.js`),
 *                  one `  name: when it applies` line each, read from
 *                  `ai/production/skills/<name>.md`
 *   trusted_sites  optional: `[a.com, b.org]`, sites whose pages the assistant
 *                  may open without being given the address (`trustedSites.js`)
 *   open_web       optional `yes`: the assistant may open any public https
 *                  address it chooses (`trustedSites.js` `onOpenWeb`)
 *   tools          names the setup was proved with (recorded; not yet offered)
 *   core_tools     no longer read: the assistant holds the six tools, each
 *                  listing only what it was granted (`sixTools.js`, 2026-10-16)
 *   history        optional 0-300: how many earlier texts (questions and
 *                  answers each count) a turn is shown; the rest are read with
 *                  `earlier_texts` (`conversation.js`). Absent: everything
 *                  kept, up to the shown characters.
 *   max_steps      1-40, the most rounds a turn may take; a quick turn is still
 *                  held to `turn.js`'s 8, and only a streamed (long) texting turn
 *                  (`progress.js`) may go past it
 *   body           the whole prompt a texted turn is given
 *
 * Validated on read. A file that does not validate is `null`, and the turn
 * uses the built-in words, exactly as if the file were missing. The front matter's grammar is the small subset below, so
 * no YAML dependency is needed; anything outside it is refused, not guessed at.
 *
 * Whether this deployment can call the setup's model is `route.js`'s to
 * decide; this file only reads the note.
 */

import { loadPrivacyState } from "../privacy/state.js";
import { PINNED_CONTEXT_NAME, readPinnedNote } from "../orient/globalNote.js";
import { isBuiltinModelName } from "./builtin.js";
import { DEFAULT_ROUTE_AT, ROUTER_MODEL } from "./router.js";
import { readSearchSettings } from "../search/settings.js";
import { readSkillList, skillBody } from "./skills.js";
import { readOpenWeb, readTrustedSites } from "./trustedSites.js";
import { readFrontDoor } from "./frontDoor.js";
import { readHistoryTurns } from "./conversation.js";
import { EFFORTS } from "./aiGateway.js";

export const PRODUCTION_TEXTING_PATH = "ai/production/texting-assistant.md";

const MAX_BODY_LINES = 1_000;
const MAX_BODY_CHARS = 40_000;
const MAX_STEPS = 40;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const THINK_ROUNDS = /^[1-9]$/;
const ROUTE_AT = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TOP_KEY = /^([a-z][a-z0-9_]*):(?: +(.*))?$/;
// Hyphens are allowed one level down, for skill names (`skills.js`).
const SUB_KEY = /^ {2}([a-z][a-z0-9_-]*):(?: +(.*))?$/;

/** Tex's nightly dream (`dream.js`): its model, and the words that ask for the dream. */
export const PRODUCTION_DREAM_PATH = "ai/production/dream.md";
/** Tex's check-in (`heartbeat.js`): its model, and the words that say what is worth a text. */
export const PRODUCTION_HEARTBEAT_PATH = "ai/production/heartbeat.md";
/** Tex's housekeeping (`housekeeping.js`): its model, and the words that say how to organize. */
export const PRODUCTION_HOUSEKEEPING_PATH = "ai/production/housekeeping.md";
/** Meeting summaries (`meetings/summarize.js`): the model, and the write and check prompts. */
export const PRODUCTION_MEETING_SUMMARIES_PATH = "ai/production/meeting-summaries.md";

/**
 * `{ job, model, tools, maxSteps, prompt, version }`, or `null` when the file
 * is refused. Never throws. `version` is the first 12 hex characters of the
 * SHA-256 of the raw file, so a gateway log says which setup answered.
 *
 * @param {unknown} raw the file's text
 */
export async function parseSetup(raw) {
  try {
    return await parse(raw);
  } catch {
    return null;
  }
}

async function parse(raw) {
  if (typeof raw !== "string") return null;
  const match = FRONT_MATTER.exec(raw);
  if (!match) return null;
  const front = readFront(match[1]);
  if (front === null) return null;

  const models = front.models;
  if (!isMap(models) || typeof models.main !== "string" || !isBuiltinModelName(models.main)) return null;

  // A router without a thinking model has nowhere to send a text. A thinking
  // model without a router plans background jobs only (`modelPlan.js`, the
  // owner, 2026-10-31), so it must say how many rounds it plans: a bare
  // `think` would put whole jobs on it.
  const thinkRounds = readThinkRounds(models.think_rounds);
  if (thinkRounds === undefined) return null;
  let router = null;
  let planner = null;
  if (models.router !== undefined) {
    if (models.router !== ROUTER_MODEL) return null;
    if (typeof models.think !== "string" || !isBuiltinModelName(models.think)) return null;
    let routeAt = DEFAULT_ROUTE_AT;
    if (models.route_at !== undefined) {
      if (typeof models.route_at !== "string" || !ROUTE_AT.test(models.route_at)) return null;
      routeAt = Number(models.route_at);
    }
    // Opus plans, Haiku drives (`modelPlan.js`): absent, a routed turn stays on `think`.
    router = { model: models.router, think: models.think, routeAt, ...(thinkRounds === null ? {} : { thinkRounds }) };
  } else if (models.think !== undefined) {
    if (typeof models.think !== "string" || !isBuiltinModelName(models.think) || models.think === models.main) return null;
    if (thinkRounds === null || models.route_at !== undefined) return null;
    planner = { think: models.think, thinkRounds };
  } else if (models.route_at !== undefined || thinkRounds !== null) return null;
  // The advisor is independent of the router. An effort with no advisor names
  // no model, so the loop below refuses it.
  let advisor = null;
  if (models.advisor !== undefined) {
    if (typeof models.advisor !== "string" || !isBuiltinModelName(models.advisor) || models.advisor === models.main) return null;
    advisor = models.advisor;
  }
  // How hard each model thinks, by model name, so the turn looks it up for
  // whichever model the router picked. A word that isn't one refuses the file.
  const efforts = {};
  for (const [key, name] of [["effort", models.main], ["think_effort", (router ?? planner)?.think], ["advisor_effort", advisor]]) {
    if (models[key] === undefined) continue;
    if (typeof models[key] !== "string" || !EFFORTS.has(models[key]) || typeof name !== "string") return null;
    efforts[name] = models[key];
  }
  let fallback = null;
  if (models.fallback !== undefined) {
    if (typeof models.fallback !== "string" || !isBuiltinModelName(models.fallback) || models.fallback === models.main) return null;
    fallback = models.fallback;
  }

  const tools = front.tools === undefined ? [] : front.tools;
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string" && TOOL.test(tool))) return null;

  let search = null;
  if (front.search !== undefined) {
    if (!isMap(front.search)) return null;
    search = readSearchSettings(front.search);
    if (search === null) return null;
  }

  const skills = readSkillList(front.skills);
  if (skills === null) return null;

  const trustedSites = readTrustedSites(front.trusted_sites);
  if (trustedSites === null) return null;
  const openWeb = readOpenWeb(front.open_web);
  if (openWeb === null) return null;

  const history = readHistoryTurns(front.history);
  if (history === null) return null;

  // Haiku as the front door unless the setup says `front_door: off` (`frontDoor.js`).
  const frontDoor = readFrontDoor(front.front_door);
  if (frontDoor === null) return null;

  let maxSteps = null;
  if (front.max_steps !== undefined) {
    if (typeof front.max_steps !== "string" || !/^[1-9]\d?$/.test(front.max_steps)) return null;
    maxSteps = Number(front.max_steps);
    if (maxSteps > MAX_STEPS) return null;
  }

  const prompt = raw.slice(match[0].length).trim();
  if (prompt.length === 0 || prompt.length > MAX_BODY_CHARS) return null;
  if (prompt.split(/\r?\n/).length > MAX_BODY_LINES) return null;

  return {
    job: typeof front.job === "string" ? front.job : null,
    model: models.main,
    router,
    planner,
    advisor,
    efforts,
    fallback,
    search,
    skills,
    trustedSites,
    openWeb,
    tools,
    history: history ?? null,
    frontDoor,
    maxSteps,
    prompt,
    version: await versionOf(raw),
  };
}

/**
 * A search setup (`bench/ai/setups/search/*.md`): front matter with
 * `job: search` and a `search:` section, and a body saying why. Nothing in it
 * names a model; the benchmark puts its settings in the world's
 * `SEARCH_SETTINGS` var and measures what `search_notes` returns.
 * `{ search, version }`, or `null`. Never throws.
 */
export async function parseSearchSetup(raw) {
  try {
    if (typeof raw !== "string") return null;
    const match = FRONT_MATTER.exec(raw);
    if (!match) return null;
    const front = readFront(match[1]);
    if (front === null || front.job !== "search" || !isMap(front.search)) return null;
    const search = readSearchSettings(front.search);
    if (search === null) return null;
    return { job: "search", search, version: await versionOf(raw) };
  } catch {
    return null;
  }
}

/**
 * The front matter's subset: `key: value` lines, `key:` followed by indented
 * `  sub: value` lines (one level), and `[a, b]` inline lists. Anything else,
 * and any repeated key, is `null`.
 */
function readFront(block) {
  const data = {};
  let section = null;
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const sub = SUB_KEY.exec(line);
    if (sub) {
      if (section === null || Object.hasOwn(section, sub[1])) return null;
      section[sub[1]] = scalar(sub[2]);
      continue;
    }
    const top = TOP_KEY.exec(line);
    if (!top || Object.hasOwn(data, top[1])) return null;
    if (top[2] === undefined) {
      section = {};
      data[top[1]] = section;
    } else {
      section = null;
      data[top[1]] = scalar(top[2]);
    }
  }
  return data;
}

function scalar(text = "") {
  const value = text.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => unquote(item.trim()));
  }
  return unquote(value);
}

function unquote(text) {
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

/** `think_rounds` as a number, null when absent, undefined when it is not 1-9. */
function readThinkRounds(value) {
  if (value === undefined) return null;
  return typeof value === "string" && THINK_ROUNDS.test(value) ? Number(value) : undefined;
}

function isMap(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function versionOf(raw) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)));
  return Array.from(digest.subarray(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The reach a note in `@context-lc` is read with, for this caller: its own
 * store and clearance when the turn runs inside the pinned workspace, otherwise
 * the hop `openPinnedContext` makes.
 */
async function pinnedReach(store, session) {
  const current = (store.contexts || []).find((entry) => entry.current);
  let here = null;
  if (current?.name === PINNED_CONTEXT_NAME) {
    const privacy = await loadPrivacyState(store);
    if (!privacy.error) here = { store, scope: session.scope, rules: privacy.rules, overrides: privacy.overrides };
  }
  // A group chat cannot address the pin, but reads its setup there through a
  // read-only door that opens nothing else (`session.js` `sessionForSetup`).
  const listed = (store.contexts || []).some((entry) => entry.name === PINNED_CONTEXT_NAME);
  if (!listed && here === null && typeof store.openPinnedSetup === "function") {
    return { contexts: [{ name: PINNED_CONTEXT_NAME }], openPinned: store.openPinnedSetup, here: null };
  }
  return { contexts: store.contexts, openPinned: store.openPinnedContext, here };
}

/**
 * The parsed setup for this turn's job, or `null` — not a texted turn, absent,
 * held back, unreadable, invalid, or no pinned workspace. Never throws.
 *
 * @param {object} store the session's store, carrying `contexts` and
 *   `openPinnedContext` as `http/route.js` attaches them
 * @param {object} session the caller's session
 * @param {{texting: boolean}} options only a texted turn has a setup to read
 */
export async function readProductionSetup(store, session, { texting, warm = null }) {
  if (!texting) return null;
  try {
    // With a warm copy (`warmCopy.js`), the note's text is read only when the copy hasn't it.
    if (warm !== null) {
      const raw = await warm(async () => await readPinnedNote(await pinnedReach(store, session), PRODUCTION_TEXTING_PATH, (text) => text));
      return typeof raw === "string" ? await parseSetup(raw) : null;
    }
    return await readPinnedNote(await pinnedReach(store, session), PRODUCTION_TEXTING_PATH, parseSetup);
  } catch {
    return null;
  }
}

/**
 * A background job's setup, `ai/production/<job>.md` (the dream, meeting
 * summaries), read and validated as the texting one is, or `null`. Moved out
 * of the code on the owner's word (2026-10-17: "move the prompt into a note
 * for me"); `null` means the job uses its built-in words, exactly as before.
 * Never throws.
 *
 * @param {object} store the session's store, carrying `contexts` and `openPinnedContext`
 * @param {object} session the caller's session
 * @param {string} path one of the `PRODUCTION_*_PATH` constants
 */
export async function readJobSetup(store, session, path) {
  try {
    return await readPinnedNote(await pinnedReach(store, session), path, parseSetup);
  } catch {
    return null;
  }
}

/**
 * The same, for a route whose store opens no other context (meeting
 * summaries): `openPinned` opens the pinned workspace and nothing else, and is
 * used only to read the job's own note. Never throws.
 *
 * @param {{contexts: Array, openPinned: () => Promise<{session: object, store: object}>}} reach
 * @param {string} path
 */
export async function readJobSetupWith(reach, path) {
  try {
    return await readPinnedNote({ contexts: reach.contexts, openPinned: reach.openPinned, here: null }, path, parseSetup);
  } catch {
    return null;
  }
}

/**
 * A setup body cut at its `## <Name>` headings: `{ write: "...", check: "..." }`
 * by lower-cased name. Text before the first heading is the note's own
 * description for people and is never sent. A body with no heading is `{}`.
 *
 * @param {string} prompt a parsed setup's `prompt`
 */
export function promptSections(prompt) {
  const sections = {};
  let name = null;
  let lines = [];
  const close = () => {
    if (name !== null && lines.join("\n").trim() !== "") sections[name] = lines.join("\n").trim();
  };
  for (const line of String(prompt ?? "").split(/\r?\n/)) {
    const heading = /^## +(.+?)\s*$/.exec(line);
    if (heading) {
      close();
      name = heading[1].toLowerCase();
      lines = [];
    } else if (name !== null) lines.push(line);
  }
  close();
  return sections;
}

/**
 * A setup the AI tab's Try it names, parsed as a production setup is, or
 * `null`. Only a note under `ai/production/` or `ai/setups/<job>/` is a
 * setup; any other path is `null` before anything is read. Never throws.
 */
export async function readSetupAt(store, session, path) {
  if (typeof path !== "string" || !TRY_SETUP_PATH.test(path) || path.includes("..")) return null;
  try {
    return await readPinnedNote(await pinnedReach(store, session), path, parseSetup);
  } catch {
    return null;
  }
}

/** `ai/production/<job>.md` or `ai/setups/<job>/<name>.md`: names of letters, digits, `.`, `_`, `-`. */
const TRY_SETUP_PATH = /^ai\/(?:production|setups\/[a-z0-9-]+)\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}\.md$/;

/**
 * One skill note's body from the pinned workspace (`skills.js`), read as the
 * setup is, or `null`. `path` is one `skillPath` made from a name the setup
 * listed. Never throws.
 */
export async function readProductionSkill(store, session, path) {
  try {
    return await readPinnedNote(await pinnedReach(store, session), path, skillBody);
  } catch {
    return null;
  }
}

/**
 * Who may call a helper agent, from its note's `callers:` in the pinned
 * workspace (`ai/agents/<key>.md`, the AI tab's "who may call it" switches):
 * a list of job keys, or `null` when the note is absent, unreadable or has no
 * `callers:` line. Read as a setup is, through the caller's own reach. Never throws.
 */
export async function readHelperCallers(store, session, key) {
  if (typeof key !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(key)) return null;
  try {
    return await readPinnedNote(await pinnedReach(store, session), `ai/agents/${key}.md`, helperCallersOf);
  } catch {
    return null;
  }
}

/** `callers: [a, b]` or `callers: a, b` in a note's front matter, or `null`. */
export function helperCallersOf(raw) {
  const front = typeof raw === "string" ? FRONT_MATTER.exec(raw) : null;
  if (!front) return null;
  const line = front[1].split(/\r?\n/).find((entry) => /^callers:/.test(entry));
  if (line === undefined) return null;
  const value = line.slice("callers:".length).trim().replace(/^\[(.*)\]$/, "$1");
  return value
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => /^[a-z][a-z0-9-]{0,40}$/.test(item));
}
