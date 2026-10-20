/**
 * The texting conversation as a log: one object per exchange, never one file
 * rewritten whole.
 *
 * `texts.json` was read, extended and written back by every job that touched
 * the conversation (a text, a check-in, a routine, the Worker's fixed texts),
 * with no version passed, so two of them finishing together kept only one
 * (Tex's runtime redesign, 2026-10-19). Each exchange is now its own object,
 * written once under a key nobody else writes, so no writer can drop
 * another's.
 *
 * A key sorts newest first (`9999999999999 - at`), so one listing with a
 * limit returns the newest exchanges, whatever the store's age. The old file
 * is imported once, as the oldest entry (`LEGACY_KEY`), and is otherwise left
 * as it was: the first write of the log copies it, and nothing writes it again.
 *
 * What an exchange keeps is what `texts.json` kept (the person's words, the
 * answer, the tools' names, whether the turn read from outside the workspace),
 * plus when it happened, whether the person started it (`theirs`: their text,
 * not a check-in, a routine or one of the Worker's fixed texts), and the
 * thread it belongs to (`threadView.js`).
 */

export const EVENTS_PREFIX = ".context/agent/events/";
const NEWEST = 9_999_999_999_999;
export const LEGACY_KEY = `${EVENTS_PREFIX}${NEWEST}-legacy.json`;
/** The most entries one read lists: enough for the kept history's forty turns, two per exchange. */
export const READ_ENTRIES = 24;
/** An exchange's id: its key's leaf without `.json`. */
const ID = /^\d{13}-[a-z0-9]{1,16}$/;

export function eventsSupported(store) {
  return typeof store?.list === "function";
}

function randomTag() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The key, and so the id, of an exchange that happened at `at` (ms). */
export function eventKey(at, tag = randomTag()) {
  const sort = String(NEWEST - Math.max(0, Math.min(NEWEST, Math.floor(at)))).padStart(13, "0");
  return `${EVENTS_PREFIX}${sort}-${tag}.json`;
}

export function idOfKey(key) {
  const leaf = key.slice(EVENTS_PREFIX.length).replace(/\.json$/, "");
  return ID.test(leaf) ? leaf : null;
}

/**
 * Write one exchange. Throws on a failed put, like the file it replaces did;
 * callers that keep history as a convenience catch it.
 */
let lastAt = 0;

export async function writeExchange(store, { at: asked = Date.now(), question, answer, tainted = false, tools = [], thread = null, theirs = false }) {
  // Two writes in one millisecond from one isolate keep the order they were made in.
  const at = Math.max(asked, lastAt + 1);
  lastAt = at;
  const key = eventKey(at);
  const entry = {
    v: 1,
    at,
    question,
    answer,
    ...(tainted ? { tainted: true } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(thread ? { thread } : {}),
    ...(theirs ? { by: "them" } : {}),
  };
  await store.put(key, JSON.stringify(entry));
  return idOfKey(key);
}

/** Whether the log has anything in it yet. */
export async function hasEvents(store) {
  const page = await store.list({ prefix: EVENTS_PREFIX, limit: 1 });
  return (page?.objects?.length ?? 0) > 0;
}

/**
 * Copy the old file's turns in as the log's oldest entry, once. The same key
 * and the same bytes from any writer, so two first writes racing are one.
 */
export async function importLegacy(store, turns) {
  if (turns.length === 0) return;
  await store.put(LEGACY_KEY, JSON.stringify({ v: 1, legacy: true, turns }));
}

async function readEntry(store, key) {
  try {
    const object = await store.get(key);
    if (!object) return null;
    return JSON.parse(await object.text());
  } catch {
    return null; // one unreadable entry costs the turn that exchange, not its history
  }
}

/**
 * The newest entries, oldest first, as turns: each exchange a question and its
 * answer, the question carrying the exchange's `id`, `at` and `thread`.
 * Null when the log is empty, so the caller can read the old file instead.
 */
export async function readEventTurns(store, entries = READ_ENTRIES) {
  const most = Math.max(1, Math.min(READ_ENTRIES, entries));
  const page = await store.list({ prefix: EVENTS_PREFIX, limit: most });
  const keys = (page?.objects ?? [])
    .map((object) => object.key)
    .filter((key) => typeof key === "string" && key.startsWith(EVENTS_PREFIX))
    .sort()
    .slice(0, most);
  if (keys.length === 0) return null;
  const read = await Promise.all(keys.map((key) => readEntry(store, key)));
  const turns = [];
  // Keys sort newest first; turns go oldest first.
  for (let i = keys.length - 1; i >= 0; i -= 1) {
    const entry = read[i];
    if (entry === null || typeof entry !== "object") continue;
    if (entry.legacy === true && Array.isArray(entry.turns)) {
      turns.push(...entry.turns);
      continue;
    }
    if (typeof entry.question !== "string" || typeof entry.answer !== "string") continue;
    const id = idOfKey(keys[i]);
    turns.push({
      role: "user",
      text: entry.question,
      ...(id ? { id } : {}),
      ...(Number.isFinite(entry.at) ? { at: entry.at } : {}),
      ...(typeof entry.thread === "string" && ID.test(entry.thread) ? { thread: entry.thread } : {}),
      ...(entry.by === "them" ? { theirs: true } : {}),
    });
    turns.push({
      role: "assistant",
      text: entry.answer,
      ...(entry.tainted === true ? { tainted: true } : {}),
      ...(Array.isArray(entry.tools) ? { tools: entry.tools } : {}),
    });
  }
  return turns;
}
