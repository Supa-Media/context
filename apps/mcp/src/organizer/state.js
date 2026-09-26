/**
 * Auto-organize: the suggestions waiting for someone, kept in their own bucket.
 *
 * One JSON object at `.context/organizer/state.json`. It lives in the
 * customer's bucket rather than the control plane because the suggestions
 * name notes and say things about them, and the control plane holds metadata
 * only (non-negotiable #1). It is Context-owned plumbing under `.context/`,
 * exported and handed over with everything else, and disposable: deleting it
 * loses nothing but the pending list and the memory of what was dismissed.
 *
 * Every write is conditional on the etag it read, so a sweep finishing while
 * somebody presses Accept cannot silently undo either.
 */

import { ORGANIZER_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";

export const ORGANIZER_STATE_KEY = `${ORGANIZER_PREFIX}state.json`;
export const ORGANIZER_KINDS = Object.freeze(["done", "archive", "file"]);
/** A dismissed suggestion stays dismissed this long, then may come back. */
export const DISMISS_MEMORY_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 200;
const MAX_DISMISSED = 500;
const STATE_BYTE_CAP = 256_000;
/** Accepts in a row, with no dismissal of that kind, before offering autopilot. */
export const OFFER_AFTER_ACCEPTS = 3;

export function emptyOrganizerState() {
  return { version: 1, sweptAt: null, pending: [], dismissed: {}, streaks: { done: 0, archive: 0, file: 0 } };
}

function isKind(value) {
  return ORGANIZER_KINDS.includes(value);
}

/** Read it back, forgiving anything malformed rather than failing the sweep. */
export function parseOrganizerState(text) {
  const empty = emptyOrganizerState();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== "object" || raw.version !== 1) return empty;
  const pending = Array.isArray(raw.pending)
    ? raw.pending.filter((item) => item && typeof item.id === "string" && isKind(item.kind) && typeof item.path === "string")
    : [];
  const dismissed = {};
  if (raw.dismissed && typeof raw.dismissed === "object") {
    for (const [id, at] of Object.entries(raw.dismissed)) if (typeof at === "number") dismissed[id] = at;
  }
  const streaks = { ...empty.streaks };
  for (const kind of ORGANIZER_KINDS) {
    const value = raw.streaks?.[kind];
    if (Number.isInteger(value) && value >= 0) streaks[kind] = value;
  }
  return {
    version: 1,
    sweptAt: typeof raw.sweptAt === "number" ? raw.sweptAt : null,
    pending: pending.slice(0, MAX_PENDING),
    dismissed,
    streaks,
  };
}

export async function readOrganizerState(store) {
  const object = await store.get(ORGANIZER_STATE_KEY);
  if (!object) return { state: emptyOrganizerState(), etag: null };
  const text = await object.text();
  if (text.length > STATE_BYTE_CAP) return { state: emptyOrganizerState(), etag: object.etag };
  return { state: parseOrganizerState(text), etag: object.etag };
}

export async function writeOrganizerState(store, state, etag) {
  const result = await store.put(ORGANIZER_STATE_KEY, JSON.stringify(state), {
    contentType: "application/json",
    onlyIf: etag ? { etagMatches: etag } : { absent: true },
  });
  return result ? result.etag : null;
}

function forgetOldDismissals(dismissed, now) {
  const kept = Object.entries(dismissed)
    .filter(([, at]) => now - at < DISMISS_MEMORY_MS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DISMISSED);
  return Object.fromEntries(kept);
}

/** A finished sweep replaces the pending list, minus anything dismissed. */
export function mergeSweep(state, fresh, now) {
  const dismissed = forgetOldDismissals(state.dismissed, now);
  const seen = new Set();
  const pending = [];
  for (const suggestion of fresh) {
    if (dismissed[suggestion.id] !== undefined || seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    pending.push(suggestion);
    if (pending.length >= MAX_PENDING) break;
  }
  return { ...state, sweptAt: now, pending, dismissed };
}

/**
 * Take one suggestion off the list. An accept extends that kind's streak and a
 * dismiss resets it; `offer` says the streak just reached the point where
 * asking "do this automatically?" is earned.
 */
export function resolveSuggestion(state, id, decision, now) {
  const suggestion = state.pending.find((item) => item.id === id);
  if (!suggestion) return { state, suggestion: null, offer: false };
  const pending = state.pending.filter((item) => item.id !== id);
  const streaks = { ...state.streaks };
  const dismissed = { ...state.dismissed };
  if (decision === "accept") {
    streaks[suggestion.kind] = (streaks[suggestion.kind] ?? 0) + 1;
  } else {
    streaks[suggestion.kind] = 0;
    dismissed[id] = now;
  }
  const offer = decision === "accept" && streaks[suggestion.kind] === OFFER_AFTER_ACCEPTS;
  return { state: { ...state, pending, streaks, dismissed: forgetOldDismissals(dismissed, now) }, suggestion, offer };
}

/** Switching auto-organize off clears what was waiting, and nothing else. */
export function clearPending(state) {
  return { ...state, pending: [] };
}
