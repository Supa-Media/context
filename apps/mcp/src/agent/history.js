/**
 * TEX'S ONE-TO-ONE HISTORY IS ONE RECORD IN THE PERSON'S TEX OBJECT (the
 * owner, 2026-11-01: "ONE copy only, in the durable object, for 1:1 AND
 * groups"; `docs/decisions/texting-assistant/one-to-one-history.md`).
 *
 * The person's texts with Tex are one JSON record, `HISTORY_KEY`, which the
 * store's routing keeps in the workspace's own Tex Durable Object
 * (`store/texRouting.js`, `isAgentHomeKey`), never in the bucket. A turn reads
 * it with one call and every writer (a texted turn, a routine, a check-in, a
 * fixed text, a settled yes, a job's update) appends to it with a conditional
 * write, so no writer drops another's and nothing else is ever a source of
 * the history: not the bucket's old exchange files, not a copy the texting
 * Worker keeps.
 *
 * The old copies (the exchange log `events.js`, before it the whole file
 * `texts.json`) are read once, by `moveHistoryIn`, when a person has no
 * record yet: from the migration (`apps/convex/functions/texHistoryMigration.ts`)
 * or, for somebody it has not reached, their first turn. Once the record is
 * there, the bucket's copies are never read again.
 */

import { getWithLegacyFallback } from "../storageLayout.js";
import { eventsSupported, readEventTurns } from "./events.js";

/** The record. A `.context/agent/history/` key: the routing sends it to the person's object. */
export const HISTORY_KEY = ".context/agent/history/texts.json";
/** The old whole-file history, read only by the move. */
const LEGACY_FILE = ".context/agent/conversations/texts.json";
/** How many times an append re-reads after another writer won the race. */
const APPEND_TRIES = 8;

const isTurn = (value) => value !== null && typeof value === "object" && (value.role === "user" || value.role === "assistant") && typeof value.text === "string";

/** A record's text as kept: `{turns, direct, etag}`. */
function parseRecord(text, etag) {
  const parsed = JSON.parse(text);
  const direct = parsed?.direct !== null && typeof parsed?.direct === "object" ? parsed.direct : undefined;
  return { turns: Array.isArray(parsed?.turns) ? parsed.turns.filter(isTurn) : [], ...(direct ? { direct } : {}), etag };
}

const bodyOf = (record, turns) => JSON.stringify({ v: 1, turns, ...(record?.direct ? { direct: record.direct } : {}) });

/** The record as kept: `{turns, direct, etag}`, or null when the person has none yet. Throws when it can't be read. */
async function readRecord(store) {
  const object = await store.get(HISTORY_KEY);
  if (object === null || object === undefined) return null;
  return parseRecord(await object.text(), object.etag);
}

/*
  The desk (`texStore/desk.js`): the record and the notes it keeps keys for,
  in one call to the person's object, once per request. A write to the record
  forgets it, so a later read in the same request reads the record again.
*/
const desks = new WeakMap();

function openDesk(store) {
  if (typeof store?.texDesk !== "function") return null;
  if (!desks.has(store)) desks.set(store, store.texDesk());
  return desks.get(store);
}

/**
 * The notes the desk read with the record, by name (`about`, `jobs`):
 * `{etag, text}`, false for a note the record says is missing, absent when it
 * holds no key for it. `{}` without a desk or when it can't be read.
 */
export async function deskNotes(store) {
  try {
    return (await openDesk(store))?.notes ?? {};
  } catch {
    return {};
  }
}

/** The bucket's old copies, newest `chars` worth: the exchange log, or the whole file before it. */
async function legacyTurns(store, chars) {
  const logged = eventsSupported(store) ? await readEventTurns(store, undefined, { chars }) : null;
  if (logged !== null) return logged.filter(isTurn);
  const object = await getWithLegacyFallback(store, LEGACY_FILE);
  if (!object) return [];
  const parsed = JSON.parse(await object.text());
  return Array.isArray(parsed?.turns) ? parsed.turns.filter(isTurn) : [];
}

/**
 * Make the person's record from the bucket's old copies, once: written only
 * where none is yet, so a turn that kept one meanwhile is never overwritten,
 * and read back. `keep` shapes and bounds the turns (`conversation.js`).
 * Answers the record (`{turns, etag}`) and whether this call wrote it.
 * `dryRun` writes nothing, and answers what it would move (`would`).
 */
export async function moveHistoryIn(store, { keep, chars, dryRun = false, onlyIfAny = false, log = console.log } = {}) {
  const held = await readRecord(store);
  if (held !== null) return { record: held, moved: false, already: true, turns: held.turns.length };
  const turns = keep(await legacyTurns(store, chars));
  // `onlyIfAny`: the migration makes no record for a workspace with no old history (its first turn makes an empty one).
  if (dryRun || (onlyIfAny && turns.length === 0)) return { record: null, moved: false, would: turns.length > 0, turns: turns.length };
  desks.delete(store);
  const written = await store.put(HISTORY_KEY, JSON.stringify({ v: 1, moved: Date.now(), turns }), { onlyIf: { absent: true } });
  const record = await readRecord(store);
  if (record === null) throw new Error("the history record was written but cannot be read back");
  if (written !== null) log(JSON.stringify({ event: "tex_history_moved_in", turns: turns.length }));
  return { record, moved: written !== null, turns: turns.length };
}

/** The record through the desk when there is one, else read alone; null when the person has none. */
async function deskRecord(store) {
  const desk = openDesk(store);
  const opened = desk === null ? undefined : (await desk)?.history;
  return opened === undefined ? await readRecord(store) : opened === null ? null : parseRecord(opened.text, opened.etag);
}

/** The record's turns, moved in first when the person has none. Throws when it can't be read. */
export async function readHistory(store, { keep, chars }) {
  const held = await deskRecord(store);
  if (held !== null) return held.turns;
  return (await moveHistoryIn(store, { keep, chars })).record.turns;
}

/**
 * Add turns to the record: read, add, write back only if nobody wrote since
 * (the record's etag), and go again when somebody did. `keep` shapes and
 * bounds the result. Throws when it can't (the object unreachable, or it lost
 * every race): a caller keeps history as a convenience and catches it.
 */
export async function appendHistory(store, added, { keep, chars }) {
  for (let tried = 0; tried < APPEND_TRIES; tried += 1) {
    // The first try reads through the desk (one call, with the notes this request will want); a retry reads the record alone.
    const record = (tried === 0 ? await deskRecord(store) : await readRecord(store)) ?? (await moveHistoryIn(store, { keep, chars })).record;
    const was = desks.get(store);
    desks.delete(store);
    const body = bodyOf(record, keep([...record.turns, ...added]));
    const written = await store.put(HISTORY_KEY, body, { onlyIf: { etagMatches: record.etag } });
    if (written !== null) {
      // What this request wrote is what it reads next: the record as written, with the notes the desk already read.
      if (typeof written?.etag === "string") desks.set(store, (was ?? Promise.resolve(null)).catch(() => null).then((desk) => ({ history: { etag: written.etag, text: body }, notes: desk?.notes ?? {} })));
      return;
    }
  }
  throw new Error("the history record changed under every append");
}

/**
 * Keep the keys of the notes the desk reads (`direct`: `{about, jobs}`, each
 * a `notes/<id>.md` key in this object or false for none) in the record, when
 * they changed. Behind the reply, after the turn's own write; best effort, as
 * a desk with no key reads that note the old way.
 */
export async function keepDeskKeys(store, direct) {
  for (let tried = 0; tried < APPEND_TRIES; tried += 1) {
    const record = await readRecord(store);
    if (record === null) return;
    const same = Object.keys(direct).length === Object.keys(record.direct ?? {}).length && Object.entries(direct).every(([name, key]) => record.direct?.[name] === key);
    if (same) return;
    desks.delete(store);
    const written = await store.put(HISTORY_KEY, bodyOf({ direct }, record.turns), { onlyIf: { etagMatches: record.etag } });
    if (written !== null) return;
  }
}
