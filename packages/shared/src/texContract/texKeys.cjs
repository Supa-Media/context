/**
 * The shapes of the keys Tex's Durable Objects keep, and whose object each one
 * names: pure rules both the gateway (`apps/mcp/src/store/texRouting.js`,
 * `privacy/engine.js`) and Tex read, so Tex reaches none of the gateway's
 * modules for them (`docs/decisions/texting-assistant/tex-service.md`).
 *
 * Moved verbatim; the gateway's modules re-export these, so every caller and
 * test there is unchanged.
 */
"use strict";

/**
 * The same id key kept in Tex's Durable Object instead of the bucket
 * (`texStore/keys.js`): `tex/<owner>/notes/<noteId>.md`, the owner
 * `person:<workspaceId>` or `chat:<chatId>`. A row whose key has this form
 * keeps its note's text there (decided by the owner, 2026-10-31).
 */
const TEX_KEY = /^tex\/(?:person|chat):[A-Za-z0-9_-]{1,64}\/(?:notes|files)\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\.[^/]*)?$/;

function isTexKey(key) {
  return typeof key === "string" && TEX_KEY.test(key);
}

/**
 * A group chat's own state in its Durable Object, not a note:
 * tex/chat:<chatKey>/state/<64 hex>.json (its memory record, a rebuildable
 * cache of the visible memory note; `agent/chatMemoryRecord.js`). Only a chat
 * owns one, never a person; no row ever names it, so it is plumbing, and never
 * an id key.
 */
const TEX_STATE_KEY = /^tex\/chat:[A-Za-z0-9_-]{1,64}\/state\/[0-9a-f]{64}\.json$/;

function isTexStateKey(key) {
  return typeof key === "string" && TEX_STATE_KEY.test(key);
}

/**
 * Whether `error` is the gateway's refusal of a Tex key it cannot serve (`TexStoreUnavailable` in
 * `apps/mcp/src/store/texRouting.js`: another workspace's owner, or no way to reach the object), by its name.
 */
function isTexStoreUnavailable(error) {
  return error instanceof Error && error.name === "TexStoreUnavailable";
}

/** The `.context/agent/` folders a person's Tex bookkeeping lives under, in their object. */
const AGENT_HOME_FOLDERS = ["history", "turns", "running", "cancel", "steer", "go"];
const AGENT_HOME = /^\.context\/agent\/(history|turns|running|cancel|steer|go)\/((?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}\/){0,2}[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127})$/;
const AGENT_HOME_PREFIX = /^\.context\/agent\/(history|turns|running|cancel|steer|go)\/((?:[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}\/){0,2})$/;

/** Whether `key` is a person's Tex bookkeeping, kept in their object (`state/agent/...`). No `..`, no empty segment. */
function isAgentHomeKey(key) {
  return typeof key === "string" && AGENT_HOME.test(key) && !key.includes("..");
}

/** `{owner, key}` for a Tex key or a chat's state key: whose object, and the key inside it. */
function splitTexKey(key) {
  if (!isTexKey(key) && !isTexStateKey(key)) return null;
  const cut = key.indexOf("/", "tex/".length);
  return { owner: key.slice("tex/".length, cut), key: key.slice(cut + 1) };
}

/**
 * Whether a call goes to a Tex Durable Object rather than the bucket, by the
 * same rules as `withTexRouting`: a person's bookkeeping key, a Tex or chat
 * state key, or (for a listing, `prefix: true`) a prefix under either. For
 * timing only (`agent/texTiming.js`); the routing itself decides access.
 */
function goesToObject(key, { prefix = false } = {}) {
  if (typeof key !== "string" || key.includes("..")) return false;
  if (prefix) return AGENT_HOME_PREFIX.test(key) || /^tex\/(?:person|chat):[A-Za-z0-9_-]{1,64}\//.test(key);
  return isAgentHomeKey(key) || splitTexKey(key) !== null;
}

/** The Tex key for an id key kept in `owner`'s object. */
function texKeyFor(owner, idKey) {
  const key = `tex/${owner}/${idKey}`;
  if (!isTexKey(key)) throw new TypeError("not an id key, or not an owner");
  return key;
}

/** A group chat's state key: `name` is 64 hex (a SHA-256), kept in that chat's object alone. */
function texStateKeyFor(chat, name) {
  const key = ["tex", `chat:${chat}`, "state", `${name}.json`].join("/");
  if (!isTexStateKey(key)) throw new TypeError("not a chat, or not a state name");
  return key;
}

module.exports = {
  TEX_KEY,
  isTexKey,
  isTexStateKey,
  isTexStoreUnavailable,
  AGENT_HOME_FOLDERS,
  AGENT_HOME_PREFIX,
  isAgentHomeKey,
  splitTexKey,
  goesToObject,
  texKeyFor,
  texStateKeyFor,
};
