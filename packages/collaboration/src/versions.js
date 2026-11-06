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
 *   its Yjs state vector and delete set, applied to the current snapshot. Documents keep `gc: false`, so the current
 *   snapshot still holds every item any earlier revision had, and the marker is about 20 bytes. Each marker carries
 *   the revision's text length and a hash of it, and a rebuilt base that does not match is never used.
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

/** The state's markers, newest last, with one for `revision` (made from `doc`, that revision's document) added. */
export function basesWith(state, revision, doc) {
  const text = doc.getText("note").toString();
  const marker = { revision, marker: bytesToBase64(Y.encodeSnapshot(Y.snapshot(doc))), length: text.length, hash: textHash(text) };
  const kept = (Array.isArray(state.bases) ? state.bases : []).filter((entry) => isObject(entry) && entry.revision !== revision);
  return [...kept, marker].slice(-BASE_MARKERS);
}

/**
 * The revision `revision` of `state`, rebuilt from its marker over the current snapshot, as `readRevision` answers
 * it, or `null` when the state keeps no marker for it or the rebuilt text does not match what the marker recorded.
 */
export function markedRevision(state, current, revision) {
  const entry = (Array.isArray(state.bases) ? state.bases : []).find((candidate) => isObject(candidate) && candidate.revision === revision);
  if (!entry || typeof entry.marker !== "string") return null;
  try {
    const origin = docFromSnapshot(current.value.snapshot);
    const rebuilt = Y.createDocFromSnapshot(origin, Y.decodeSnapshot(base64ToBytes(entry.marker)), new Y.Doc({ gc: false }));
    const text = rebuilt.getText("note").toString();
    if (text.length !== entry.length || textHash(text) !== entry.hash) return null;
    return {
      value: {
        ...current.value,
        revision,
        snapshot: bytesToBase64(Y.encodeStateAsUpdate(rebuilt)),
        text,
      },
    };
  } catch {
    return null;
  }
}

/** Whether a save at `now` comes after the document sat idle long enough for the state it stopped at to be kept. */
export function idleSince(state, now) {
  return Number.isFinite(state.editedAt) && now - state.editedAt >= IDLE_MS;
}
