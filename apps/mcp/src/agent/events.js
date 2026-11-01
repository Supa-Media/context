/**
 * THE OLD EXCHANGE LOG, READ ONLY TO MOVE IT (2026-11-01). The one-to-one
 * history is one record in the person's Tex object now (`history.js`), and
 * nothing writes here; `moveHistoryIn` reads this log once, for a person who
 * has no record yet. The ids it keys exchanges by are still the history's.
 *
 * What it was: the texting conversation as a log, one object per exchange,
 * never one file rewritten whole.
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
 * answer, the tools' names and the web addresses it read (`sources.js`),
 * whether the turn read from outside the workspace),
 * plus when it happened, whether the person started it (`theirs`: their text,
 * not a check-in, a routine or one of the Worker's fixed texts), and the
 * thread it belongs to (`threadView.js`).
 */

export const EVENTS_PREFIX = ".context/agent/events/";
const NEWEST = 9_999_999_999_999;
export const LEGACY_KEY = `${EVENTS_PREFIX}${NEWEST}-legacy.json`;
/**
 * The most entries one read lists. The kept history is bounded by characters
 * (`conversation.js`), so entries are read newest first, a batch at a time,
 * and reading stops once that many characters are in hand: a chat of short
 * texts reads more of them, one of long answers fewer.
 */
export const READ_ENTRIES = 150;
const READ_BATCH = 25;
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

/** When the exchange with this id happened (ms): its key sorts by it. */
export function atOfId(id) {
  return NEWEST - Number(String(id).slice(0, 13));
}

export function idOfKey(key) {
  const leaf = key.slice(EVENTS_PREFIX.length).replace(/\.json$/, "");
  return ID.test(leaf) ? leaf : null;
}

let lastAt = 0;

/** The time and tag of a new exchange, and so its id: the history record keeps each exchange by it (`history.js`). */
export function newExchange(asked = Date.now()) {
  // Two exchanges in one millisecond from one isolate keep the order they were made in.
  const at = Math.max(asked, lastAt + 1);
  lastAt = at;
  const tag = randomTag();
  return { at, tag, id: idOfKey(eventKey(at, tag)) };
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
export async function readEventTurns(store, entries = READ_ENTRIES, { chars = Infinity } = {}) {
  const most = Math.max(1, Math.min(READ_ENTRIES, entries));
  const page = await store.list({ prefix: EVENTS_PREFIX, limit: most });
  const keys = (page?.objects ?? [])
    .map((object) => object.key)
    .filter((key) => typeof key === "string" && key.startsWith(EVENTS_PREFIX))
    .sort()
    .slice(0, most);
  if (keys.length === 0) return null;
  // Keys sort newest first: read a batch at a time until the character budget is spent.
  const read = [];
  let held = 0;
  for (let at = 0; at < keys.length && held <= chars; at += READ_BATCH) {
    const batch = await Promise.all(keys.slice(at, at + READ_BATCH).map((key) => readEntry(store, key)));
    for (const entry of batch) {
      read.push(entry);
      held += entryChars(entry);
    }
  }
  const turns = [];
  // Turns go oldest first.
  for (let i = read.length - 1; i >= 0; i -= 1) {
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
      ...(Array.isArray(entry.sources) ? { sources: entry.sources } : {}),
    });
  }
  return turns;
}

function entryChars(entry) {
  if (entry === null || typeof entry !== "object") return 0;
  if (entry.legacy === true && Array.isArray(entry.turns)) return entry.turns.reduce((n, turn) => n + String(turn?.text ?? "").length, 0);
  return String(entry.question ?? "").length + String(entry.answer ?? "").length;
}
