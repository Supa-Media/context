/**
 * A group chat's history has ONE copy: its record in the chat's Durable Object
 * (`chatMemoryRecord.js`). Decided by the owner, 2026-11-01: "there should be
 * one copy in the durable object", and no group chat data in a workspace folder.
 *
 * Until then a chat kept two: the record, and a visible memory note
 * (`tex/groups/chat-<id>.md`, in the chat's home or its bound workspace). Each
 * turn read the note instead of the record whenever the note's version was not
 * the one Tex last wrote, and while a note was being carried to a new name the
 * old note's words were read instead. When the note could not be written, its
 * version never moved, so every turn after rebuilt the history from that stale
 * note and the record was overwritten with it: the chat forgot every reply
 * since, and each review saw a history it had never scored (2026-11-01).
 *
 * Now the record is the history, and nothing is ever rebuilt from a note. Once
 * per chat, the old memory notes' words are carried into the record:
 *
 *  - every place a memory note may have been kept is read: the home and the
 *    bound workspace, each under the chat's own name and the people's;
 *  - the longest one is the base, and every record turn it lacks follows it,
 *    so neither a turn only the record kept nor one only the note kept is lost;
 *  - the record is written with `carried` and the places carried from, so
 *    those notes can be trashed once their words are safe here.
 *
 * A place that could not be read (as opposed to one with no note) leaves the
 * carry for the next turn, at most `CARRY_TRIES` turns, so a place this grant
 * can never read does not cost every turn a read. Each outcome is one
 * structured line with counts, never a path or a word.
 */

import { readWithEtag } from "./jobLog.js";
import { parseGroupNote } from "./groupMemoryNote.js";

/** The record's mark once the old notes are carried in. */
export const CARRIED = 1;
/** Turns that try a carry before it is marked done with whatever could be read. */
export const CARRY_TRIES = 3;

const keyOf = (turn) => `${turn.role}\n${String(turn.text).trim()}`;

/**
 * `base` with every turn of `record` it lacks after it, in the record's order. When the base holds nothing the
 * record lacks, the record stands as it is (it is the newer copy and its order is kept).
 */
export function mergeTurns(record, base) {
  if (base.length === 0) return record;
  const inRecord = new Set(record.map(keyOf));
  if (base.every((turn) => inRecord.has(keyOf(turn)))) return record;
  const inBase = new Set(base.map(keyOf));
  return [...base, ...record.filter((turn) => !inBase.has(keyOf(turn)))];
}

/**
 * The old notes' turns carried into `record` (`{turns, ...}`), once. `places` is `[{dispatch, path, where}]`, every
 * place a memory note may be: `where` is "home" or "bound". Answers the record to keep: the same object when there is
 * nothing to do, else a new one with `carried` set (or `carryTries` counted) and `changed: true` for the caller to write.
 */
export async function carryOldNotes(record, places, { log = console.log } = {}) {
  if (record?.carried === CARRIED) return record;
  const reads = await Promise.all(places.map((place) => readWithEtag(place.dispatch, place.path).then((read) => ({ place, read }))));
  const unreadable = reads.filter(({ read }) => read === null).length;
  const held = reads
    .filter(({ read }) => read !== null && read.missing !== true)
    .map(({ place, read }) => ({ place, turns: parseGroupNote(read.body) ?? [] }));
  const tries = (Number.isInteger(record?.carryTries) ? record.carryTries : 0) + 1;
  if (unreadable > 0 && tries < CARRY_TRIES) {
    log(JSON.stringify({ event: "group_memory_carry_waiting", unreadable, tries }));
    return { ...record, carryTries: tries, changed: true };
  }
  const longest = held.reduce((best, entry) => (entry.turns.length > best.length ? entry.turns : best), []);
  const kept = Array.isArray(record?.turns) ? record.turns : [];
  const turns = mergeTurns(kept, longest);
  log(JSON.stringify({ event: "group_memory_carried", notes: held.length, unreadable, recordTurns: kept.length, noteTurns: longest.length, turns: turns.length }));
  const { carryTries: _tries, noteEtag: _etag, ...rest } = record ?? {};
  return {
    ...rest,
    version: 1,
    turns,
    carried: CARRIED,
    carriedFrom: held.map(({ place }) => ({ where: place.where, path: place.path })),
    changed: true,
  };
}
