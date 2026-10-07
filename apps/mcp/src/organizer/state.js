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
/**
 * "What changed" cards (`./changes.js`). Waiting like the rest, but never done
 * without asking, so they have no streak and no autopilot.
 */
export const CHANGE_KIND = "change";
/**
 * "For your teams" cards (`./routes.js`): a note for a team, waiting for its
 * owner to read it and press Add. Kept like change cards, and never sent alone.
 */
export const ROUTE_KIND = "route";
/** The cards that wait across sweeps and are only ever answered by a person. */
export const CARD_KINDS = Object.freeze([CHANGE_KIND, ROUTE_KIND]);
/** Teams a personal workspace may name a switch for; more are ignored. */
const MAX_ROUTING_TEAMS = 50;
/** A change card nobody answered goes away after this long. */
export const CHANGE_MEMORY_MS = 30 * 24 * 60 * 60 * 1000;
/** A dismissed suggestion stays dismissed this long, then may come back. */
export const DISMISS_MEMORY_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PENDING = 200;
const MAX_DISMISSED = 500;
/** Statuses changed without asking, remembered so Activity's Undo can put them back. */
const MAX_REVERTS = 200;
const STATE_BYTE_CAP = 256_000;
/** Accepts in a row, with no dismissal of that kind, before offering autopilot. */
export const OFFER_AFTER_ACCEPTS = 3;

export function emptyOrganizerState() {
  return {
    version: 1,
    sweptAt: null,
    pending: [],
    dismissed: {},
    streaks: { done: 0, archive: 0, file: 0 },
    reverts: {},
    changesReadUpTo: null,
    routing: emptyRouting(),
  };
}

/**
 * Which teams a personal workspace writes notes for, and what its owner keeps
 * to themselves, in their own words. Kept here, in their bucket, because the
 * rule is theirs to write and may say anything. A team not named is on.
 */
export function emptyRouting() {
  return { off: [], keep: "" };
}

function parseRouting(raw) {
  const routing = emptyRouting();
  if (!raw || typeof raw !== "object") return routing;
  if (Array.isArray(raw.off)) {
    routing.off = [...new Set(raw.off.filter((name) => typeof name === "string" && /^@[a-z0-9][a-z0-9-]{0,62}$/.test(name)))].slice(0, MAX_ROUTING_TEAMS);
  }
  if (typeof raw.keep === "string") routing.keep = raw.keep.replace(/\s+/g, " ").trim().slice(0, 300);
  return routing;
}

function isKind(value) {
  return ORGANIZER_KINDS.includes(value) || CARD_KINDS.includes(value);
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
  const reverts = {};
  if (raw.reverts && typeof raw.reverts === "object") {
    for (const [path, value] of Object.entries(raw.reverts)) if (typeof value === "string") reverts[path] = value;
  }
  return {
    version: 1,
    sweptAt: typeof raw.sweptAt === "number" ? raw.sweptAt : null,
    pending: pending.slice(0, MAX_PENDING),
    dismissed,
    streaks,
    reverts,
    changesReadUpTo: typeof raw.changesReadUpTo === "number" ? raw.changesReadUpTo : null,
    routing: parseRouting(raw.routing),
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
  // No content type: the store writes only from an allow-list
  // (`store/contentTypes.js`) and JSON is not on it, so naming one refused
  // every write in production. Plumbing JSON goes in as the default, like
  // `.context/forwarding.json` and every other state file.
  const result = await store.put(ORGANIZER_STATE_KEY, JSON.stringify(state), {
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

/**
 * A finished sweep replaces the pending list, minus anything dismissed. Change
 * and team cards are the exception: each comes from one arrival that is read
 * once, so those still waiting stay (for `CHANGE_MEMORY_MS`) beside the new ones.
 * `readUpTo` moves the mark of what has been read for changes.
 */
export function mergeSweep(state, fresh, now, readUpTo) {
  const dismissed = forgetOldDismissals(state.dismissed, now);
  const seen = new Set();
  const pending = [];
  const waiting = state.pending.filter(
    (item) => CARD_KINDS.includes(item.kind) && typeof item.at === "number" && now - item.at < CHANGE_MEMORY_MS,
  );
  for (const suggestion of [...waiting, ...fresh]) {
    if (dismissed[suggestion.id] !== undefined || seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    pending.push(suggestion);
    if (pending.length >= MAX_PENDING) break;
  }
  const changesReadUpTo = typeof readUpTo === "number" ? Math.max(readUpTo, state.changesReadUpTo ?? 0) : state.changesReadUpTo ?? null;
  return { ...state, sweptAt: now, pending, dismissed, changesReadUpTo };
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
  const counted = ORGANIZER_KINDS.includes(suggestion.kind);
  if (decision === "accept") {
    if (counted) streaks[suggestion.kind] = (streaks[suggestion.kind] ?? 0) + 1;
  } else {
    if (counted) streaks[suggestion.kind] = 0;
    dismissed[id] = now;
  }
  const offer = counted && decision === "accept" && streaks[suggestion.kind] === OFFER_AFTER_ACCEPTS;
  return { state: { ...state, pending, streaks, dismissed: forgetOldDismissals(dismissed, now) }, suggestion, offer };
}

/** Switching auto-organize off clears what was waiting, and nothing else. */
export function clearPending(state) {
  return { ...state, pending: [] };
}

/**
 * Remember (or, with `value` undefined, forget) the status a note had before
 * the organizer marked it done by itself. Activity names the change but not
 * what it replaced, and Undo there has to put back exactly that.
 */
export function rememberRevert(state, path, value) {
  const reverts = { ...(state.reverts ?? {}) };
  delete reverts[path];
  if (value !== undefined) reverts[path] = value;
  const kept = Object.entries(reverts).slice(-MAX_REVERTS);
  return { ...state, reverts: Object.fromEntries(kept) };
}

/** Switch one team on or off, or rewrite the owner's rule. */
export function setRouting(state, change) {
  const routing = parseRouting(state.routing);
  if (typeof change.team === "string" && typeof change.on === "boolean") {
    const off = routing.off.filter((name) => name !== change.team);
    routing.off = parseRouting({ off: change.on ? off : [...off, change.team] }).off;
  }
  if (typeof change.keep === "string") routing.keep = parseRouting({ keep: change.keep }).keep;
  return { ...state, routing };
}
