/**
 * THE ASSISTANT'S SETUP, ONE NOTE PER JOB.
 *
 * Decided by the owner, 2026-10-08: the assistant's model and its prompt come
 * from one plain Markdown note per job in the pinned `@context-lc` workspace,
 * `ai/production/texting-assistant.md` for texted turns and
 * `ai/production/app-assistant.md` for questions asked in the app. Promoting a
 * new setup is editing that file; the gateway does not ship. The rest of `ai/`
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
 *   models.main    the built-in model (`@cf/…` or `anthropic/claude-…`)
 *   tools          names the setup was proved with (recorded; not yet offered)
 *   max_steps      1-12, the most rounds a turn may take
 *   body           the whole prompt a texted turn is given
 *
 * Validated on read. A file that does not validate is `null`, and the turn
 * uses the built-in words, exactly as if the file were missing. The front matter's grammar is the small subset below, so
 * no YAML dependency is needed; anything outside it is refused, not guessed at.
 *
 * A person's own connected account never takes the setup's model: their bill,
 * their model. `route.js` decides that; this file only reads the note.
 */

import { loadPrivacyState } from "../privacy/state.js";
import { PINNED_CONTEXT_NAME, readPinnedNote } from "../orient/globalNote.js";

export const PRODUCTION_TEXTING_PATH = "ai/production/texting-assistant.md";
export const PRODUCTION_APP_PATH = "ai/production/app-assistant.md";

const MAX_BODY_LINES = 1_000;
const MAX_BODY_CHARS = 40_000;
const MAX_STEPS = 12;
const MODEL = /^(@cf\/[\w./-]{1,120}|anthropic\/claude-[a-z0-9.-]{1,64})$/;
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const TOP_KEY = /^([a-z][a-z0-9_]*):(?: +(.*))?$/;
const SUB_KEY = /^ {2}([a-z][a-z0-9_]*):(?: +(.*))?$/;

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
  if (!isMap(models) || typeof models.main !== "string" || !MODEL.test(models.main)) return null;

  const tools = front.tools === undefined ? [] : front.tools;
  if (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string" && TOOL.test(tool))) return null;

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
    tools,
    maxSteps,
    prompt,
    version: await versionOf(raw),
  };
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
  return { contexts: store.contexts, openPinned: store.openPinnedContext, here };
}

/**
 * The parsed setup for this turn's job, or `null` — absent, held back,
 * unreadable, invalid, or no pinned workspace. Never throws.
 *
 * @param {object} store the session's store, carrying `contexts` and
 *   `openPinnedContext` as `http/route.js` attaches them
 * @param {object} session the caller's session
 * @param {{texting: boolean}} options a texted turn reads the texting job's file
 */
export async function readProductionSetup(store, session, { texting }) {
  try {
    const path = texting ? PRODUCTION_TEXTING_PATH : PRODUCTION_APP_PATH;
    return await readPinnedNote(await pinnedReach(store, session), path, parseSetup);
  } catch {
    return null;
  }
}
