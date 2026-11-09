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

const isTurn = (value) => value !== null && typeof value === "object" && (value.role === "user" || value.role === "assistant") && typeof value.text === "string";

/** A record's text as kept: `{turns, direct, etag}`. */
function parseRecord(text, etag) {
  const parsed = JSON.parse(text);
  const direct = parsed?.direct !== null && typeof parsed?.direct === "object" ? parsed.direct : undefined;
  return { turns: Array.isArray(parsed?.turns) ? parsed.turns.filter(isTurn) : [], ...(direct ? { direct } : {}), etag };
}

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

/** The newest page of the one-to-one chat's ledger the desk read with the record (`texStore/desk.js` `DESK_LEDGER`), or null. */
export async function deskLedger(store) {
  try {
    const page = (await openDesk(store))?.ledger;
    return Array.isArray(page?.entries) ? page : null;
  } catch {
    return null;
  }
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

/** The keys of the notes the desk reads, kept by themselves: the record is retired, these are not (`texStore/desk.js`). */
export const DESK_KEYS = ".context/agent/history/desk.json";

/**
 * Keep the keys of the notes the desk reads (`direct`: `{about, jobs}`, each
 * a `notes/<id>.md` key in this object or false for none) beside the record,
 * in their own key, when they changed. Behind the reply, after the turn's own
 * write; best effort, as a desk with no key reads that note the old way.
 */
export async function keepDeskKeys(store, direct) {
  const object = await store.get(DESK_KEYS);
  const kept = object === null || object === undefined ? (await readRecord(store))?.direct ?? null : JSON.parse(await object.text())?.direct ?? null;
  const same = kept !== null && Object.keys(direct).length === Object.keys(kept).length && Object.entries(direct).every(([name, key]) => kept[name] === key);
  if (same) return;
  desks.delete(store);
  await store.put(DESK_KEYS, JSON.stringify({ v: 1, direct }));
}
