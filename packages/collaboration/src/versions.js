/**
 * Which saved versions of a document are kept, and how an older one is found again.
 *
 * A save keeps no revision file of its own: the document's state carries the current snapshot (`current`,
 * `records.js` `inlineRevision`). Two things stand in for the files it used to write:
 *
 * - A version the person can go back to is kept when they go idle: a save that comes `IDLE_MS` or more after the one
 *   before it keeps the state the person stopped at as a full revision file (`keepIdleVersion`). It is written after
 *   the save is accepted and rendered, so it never holds a save back, and a lost race only skips a version.
 * - A recent revision a client still holds as its merge base is found from a marker the state keeps for it (`bases`):
 *   what it changed (the Yjs clocks it moved and the deletions it made), wound back from the current snapshot.
 *   Documents keep `gc: false`, so the current snapshot still holds every item any earlier revision had, and a marker
 *   is a few dozen bytes however long the history. Each marker carries the revision's text length and a hash of it,
 *   and a rebuilt base that does not match is never used.
 *
 * Decided by the owner, 2026-11-04 (`docs/decisions/collaboration.md`).
 */

import * as Y from "yjs";
import { base64ToBytes, bytesToBase64, isObject } from "./storage.js";
import { docFromSnapshot } from "./ydoc.js";

/** How long a document goes without a save before the state it stopped at is kept as a version. */
export const IDLE_MS = 5 * 60 * 1000;

/** How many recent revisions a state keeps a marker for. */
export const BASE_MARKERS = 16;

/** FNV-1a over the text's UTF-16 code units: a consistency check on a rebuilt base, not a security boundary. */
function textHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** `ds` as `client → [{clock, len}]`, each list sorted and merged. */
function rangesOf(ds) {
  const out = new Map();
  for (const [client, items] of ds.clients) out.set(client, merged(items.map(({ clock, len }) => ({ clock, len }))));
  return out;
}

function merged(items) {
  items.sort((a, b) => a.clock - b.clock);
  const out = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.clock + last.len >= item.clock) last.len = Math.max(last.len, item.clock + item.len - last.clock);
    else out.push({ ...item });
  }
  return out;
}

/** The ranges of `from` not in `remove`, both sorted and merged. */
function subtract(from, remove) {
  const out = [];
  let index = 0;
  for (const range of from) {
    let clock = range.clock;
    const end = range.clock + range.len;
    while (index < remove.length && remove[index].clock + remove[index].len <= clock) index += 1;
    for (let at = index; at < remove.length && remove[at].clock < end; at += 1) {
      if (remove[at].clock > clock) out.push({ clock, len: remove[at].clock - clock });
      clock = Math.max(clock, remove[at].clock + remove[at].len);
    }
    if (clock < end) out.push({ clock, len: end - clock });
  }
  return out;
}

/** The deletions `next` has that `previous` has not, as `[client, clock, len, clock, len, ...]` rows. */
function addedDeletes(next, previous) {
  const rows = [];
  for (const [client, ranges] of next) {
    const added = subtract(ranges, previous.get(client) ?? []);
    if (added.length > 0) rows.push([client, ...added.flatMap(({ clock, len }) => [clock, len])]);
  }
  return rows;
}

/**
 * The state's markers, newest last, with one for `revision` (whose document is `doc`; the state's current revision,
 * which it follows, has the snapshot `previousSnapshot`). A marker holds only what the revision changed: the clocks it
 * moved (with where they were) and the deletions it made, never the whole state vector or delete set, which grow with
 * every edit. An earlier revision is the current state with the revisions after it wound back.
 */
export function basesWith(state, revision, doc, previousSnapshot) {
  const text = doc.getText("note").toString();
  const previousBytes = base64ToBytes(previousSnapshot);
  const before = rangesOf(Y.decodeUpdate(previousBytes).ds);
  const clocksBefore = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(previousBytes));
  const clocksBack = [];
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
    const was = clocksBefore.get(client) ?? 0;
    if (was !== clock) clocksBack.push([client, was]);
  }
  const marker = {
    revision,
    previous: state.revision,
    clocksBack,
    added: addedDeletes(rangesOf(Y.createDeleteSetFromStructStore(doc.store)), before),
    length: text.length,
    hash: textHash(text),
  };
  const kept = (Array.isArray(state.bases) ? state.bases : []).filter((entry) => isObject(entry) && entry.revision !== revision);
  return [...kept, marker].slice(-BASE_MARKERS);
}

/**
 * The revision `revision` of `state`, rebuilt from its marker over the current snapshot, as `readRevision` answers
 * it, or `null`: the state keeps no marker for it, the markers from it to the current revision do not follow one
 * another unbroken, or the rebuilt text does not match what the marker recorded.
 */
export function markedRevision(state, current, revision) {
  const bases = Array.isArray(state.bases) ? state.bases.filter(isObject) : [];
  const at = bases.findIndex((candidate) => candidate.revision === revision);
  if (at < 0) return null;
  const entry = bases[at];
  try {
    const origin = docFromSnapshot(current.value.snapshot);
    // A marker from the first days of this (2026-11-04 to 06) holds the revision's whole Yjs snapshot instead.
    if (typeof entry.marker === "string") return rebuiltAs(origin, Y.decodeSnapshot(base64ToBytes(entry.marker)));
    if (bases.at(-1).revision !== state.revision) return null;
    for (let index = at + 1; index < bases.length; index += 1) if (bases[index].previous !== bases[index - 1].revision) return null;
    const later = new Map();
    for (const newer of bases.slice(at + 1)) {
      for (const [client, ...flat] of newer.added) {
        const list = later.get(client) ?? [];
        for (let index = 0; index < flat.length; index += 2) list.push({ clock: flat[index], len: flat[index + 1] });
        later.set(client, list);
      }
    }
    const ds = Y.createDeleteSet();
    for (const [client, ranges] of rangesOf(Y.createDeleteSetFromStructStore(origin.store))) {
      const kept = subtract(ranges, merged(later.get(client) ?? []));
      if (kept.length > 0) ds.clients.set(client, kept);
    }
    // The revision's clocks: the current ones, each wound back past the revisions after it, newest first.
    const clocks = Y.decodeStateVector(Y.encodeStateVector(origin));
    for (const newer of bases.slice(at + 1).reverse()) {
      for (const [client, was] of newer.clocksBack) {
        if (was === 0) clocks.delete(client);
        else clocks.set(client, was);
      }
    }
    return rebuiltAs(origin, Y.createSnapshot(ds, clocks));
  } catch {
    return null;
  }

  function rebuiltAs(origin, snapshot) {
    const rebuilt = Y.createDocFromSnapshot(origin, snapshot, new Y.Doc({ gc: false }));
    const text = rebuilt.getText("note").toString();
    if (text.length !== entry.length || textHash(text) !== entry.hash) return null;
    return { value: { ...current.value, revision, snapshot: bytesToBase64(Y.encodeStateAsUpdate(rebuilt)), text } };
  }
}

/** Whether a save at `now` comes after the document sat idle long enough for the state it stopped at to be kept. */
export function idleSince(state, now) {
  return Number.isFinite(state.editedAt) && now - state.editedAt >= IDLE_MS;
}
