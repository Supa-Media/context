import { keyFor, isStaleVersion, ownedKeys, parseKey } from "./keys";
import type { KeyValueStore } from "./memory";
import { counts, emptyOutbox, parseOutbox, type Outbox, type OutboxCounts } from "./outbox";
import type { FolderListing, OpenNote } from "../console/files/types";

/**
 * A local copy of what the bucket said, so a note can be read with no network.
 *
 * ## What this is not
 *
 * It is not a second source of truth. CLAUDE.md's third non-negotiable is that
 * plain files stay canonical and that "search indexes, caches, and embeddings
 * are **disposable derivatives**, rebuildable from the files. Never the only
 * copy of anything." Everything in this module is that: deleting the whole
 * store loses nothing but a round trip.
 *
 * The one thing here that is *not* a derivative is the **draft** — text a
 * person typed that has never reached the bucket — and it is deliberately
 * stored beside the cache rather than inside it, is never evicted by the sweep,
 * and has its own key kind. The outbox is the same and lives in `outbox.ts`.
 * If you find yourself adding a draft or a queued write to the eviction path,
 * that is the mistake this paragraph exists to stop.
 *
 * ## Why a cached read is stamped
 *
 * Every record carries `cachedAt`. The console never shows cached content
 * without saying how old it is: a note that reads as current and is four days
 * behind the bucket is the console telling somebody their context contains
 * something it does not, which is the one thing `useFileBrowser` already says
 * this product cannot afford to do.
 *
 * ## Bounds, and why there are two
 *
 * **Age.** A record older than `MAX_AGE_MS` is dropped by the sweep. This is a
 * privacy bound, not a correctness one: note text sits in browser storage on
 * whatever machine somebody happened to open the console on, and a context they
 * stopped using a month ago should not still be readable there.
 *
 * **Count.** `MAX_ENTRIES` bounds the footprint so `localStorage`'s ~5MB does
 * not fill up and start throwing on the writes that matter. Oldest first.
 *
 * Both are advisory in one direction only: dropping too much costs a round
 * trip, keeping too much costs somebody's privacy and somebody's quota.
 */

/** Thirty days. Long enough to be useful, short enough to be a bound. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many notes and listings may be held at once.
 *
 * Sized against `localStorage`'s ~5MB and `MAX_NOTE_BYTES` (2MB) rather than
 * against a feeling: 200 *typical* notes is comfortably inside the budget, and
 * one pathological 2MB note is caught by the write failing rather than by a
 * count. The queue is never part of this — see the file comment.
 */
export const MAX_ENTRIES = 200;

export interface Cached<T> {
  value: T;
  /** When the bucket last told us this. */
  cachedAt: number;
}

/** A draft: text typed that has not reached the bucket. Never evicted. */
export interface Draft {
  path: string;
  text: string;
  /** The etag the draft was typed against; `null` for a note being created. */
  baseEtag: string | null;
  savedAt: number;
}

function decode<T>(raw: string | null): Cached<T> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Cached<T>>;
    if (typeof parsed?.cachedAt !== "number" || parsed.value === undefined) return null;
    return { value: parsed.value as T, cachedAt: parsed.cachedAt };
  } catch {
    // A record we cannot read is a record we do not have. Never a throw: this
    // runs on the path that draws the console.
    return null;
  }
}

/* ------------------------------- notes ---------------------------------- */

export async function putNote(
  store: KeyValueStore,
  workspaceId: string,
  note: OpenNote,
  now: number,
): Promise<void> {
  await store.set(
    keyFor("note", workspaceId, note.path),
    JSON.stringify({ value: note, cachedAt: now } satisfies Cached<OpenNote>),
  );
}

export async function getNote(
  store: KeyValueStore,
  workspaceId: string,
  path: string,
): Promise<Cached<OpenNote> | null> {
  return decode<OpenNote>(await store.get(keyFor("note", workspaceId, path)));
}

/* ------------------------------ listings -------------------------------- */

export async function putListing(
  store: KeyValueStore,
  workspaceId: string,
  listing: FolderListing,
  now: number,
): Promise<void> {
  await store.set(
    keyFor("listing", workspaceId, listing.path),
    JSON.stringify({ value: listing, cachedAt: now } satisfies Cached<FolderListing>),
  );
}

export async function getListing(
  store: KeyValueStore,
  workspaceId: string,
  path: string,
): Promise<Cached<FolderListing> | null> {
  return decode<FolderListing>(await store.get(keyFor("listing", workspaceId, path)));
}

/* ------------------------------- drafts --------------------------------- */

/**
 * The open note's unsaved text, written down.
 *
 * This is what makes `useUnsavedGuard` more than a prompt: on web the browser
 * asks before an unload *and* the draft is here when the page comes back, and
 * the OS reclaiming a backgrounded app — which asks nobody — is survivable for
 * the same reason. On a store that reports `durable: false` it is still worth
 * writing, because it survives navigating between notes within a session; the
 * console says which of the two promises is in force.
 */
export async function putDraft(
  store: KeyValueStore,
  workspaceId: string,
  draft: Draft,
): Promise<void> {
  await store.set(keyFor("draft", workspaceId, draft.path), JSON.stringify(draft));
}

export async function getDraft(
  store: KeyValueStore,
  workspaceId: string,
  path: string,
): Promise<Draft | null> {
  const raw = await store.get(keyFor("draft", workspaceId, path));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (typeof parsed?.path !== "string" || typeof parsed.text !== "string") return null;
    if (parsed.baseEtag !== null && typeof parsed.baseEtag !== "string") return null;
    return {
      path: parsed.path,
      text: parsed.text,
      baseEtag: parsed.baseEtag,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function clearDraft(
  store: KeyValueStore,
  workspaceId: string,
  path: string,
): Promise<void> {
  await store.remove(keyFor("draft", workspaceId, path));
}

/* ------------------------------- outbox --------------------------------- */

export async function getOutbox(store: KeyValueStore, workspaceId: string): Promise<Outbox> {
  return parseOutbox(await store.get(keyFor("outbox", workspaceId)), workspaceId);
}

export async function putOutbox(store: KeyValueStore, outbox: Outbox): Promise<void> {
  if (outbox.writes.length === 0) {
    await store.remove(keyFor("outbox", outbox.workspaceId));
    return;
  }
  await store.set(keyFor("outbox", outbox.workspaceId), JSON.stringify(outbox));
}

/** For a workspace whose queue should not exist any more. */
export function emptyFor(workspaceId: string): Outbox {
  return emptyOutbox(workspaceId);
}

/**
 * Everything on this device that a person typed and the bucket has not seen.
 *
 * Queued writes and drafts, across every context — the two things `sweep` is
 * forbidden to touch, and the two things sign-out takes anyway. They cannot
 * double-count: a draft is written as you type and cleared the moment a save is
 * queued (see `restoreFor`), so one path is in one of the two, never both.
 *
 * **Why the open context's queue is excluded.** The console holds a live queue
 * for the context it is showing and for no other — `useOfflineNotes` hydrates
 * one workspace's outbox — and the persisted copy of that one is up to
 * `PERSIST_DEBOUNCE_MS` behind what has actually been typed. So the caller adds
 * its live counts and this answers for everywhere else. Warning about only what
 * is on screen would discard work it never mentioned, for exactly the context
 * nobody has looked at this session, which is the failure `signOutWarning`
 * exists to prevent rather than a smaller version of it.
 *
 * Drafts are counted everywhere, including the open context, because the live
 * counts the caller adds are the outbox's alone.
 *
 * **The exclusion is only valid once the caller's live queue exists.**
 * `useOfflineNotes` reports an empty outbox until it has read the persisted one
 * back (`ready`), so a caller that excludes the open context before that adds
 * zero and subtracts everything — it warns about nothing and then discards the
 * queue it never mentioned. The console passes `null` until `ready`; there is
 * nothing to double, because the counts it would add are zero.
 *
 * The answer is a floor in one direction only: a draft typed within the last
 * second may not be written down yet. Over-warning costs a dialog; under-warning
 * costs somebody's typing.
 *
 * **A key this version cannot read counts as one thing waiting**, and that is
 * the same trade taken deliberately rather than a lapse in it. `parseKey`
 * answers `null` for a key written by an older version of this feature, so a
 * `v0` outbox or draft was invisible here — while `forgetEverything` deletes it
 * anyway, because that walks `ownedKeys` and not `parseKey`. The one thing this
 * function promises is "everything on this device that a person typed", and
 * silently discarding typing it could not classify is the failure it exists to
 * prevent.
 *
 * It cannot be classified: the kind segment belongs to a shape this version
 * does not understand, so a stale note cache and a stale queue look identical.
 * Counting them over-warns by however many cached notes are stale — a dialog
 * somebody confirms — where not counting them under-warns by however many
 * queued writes are, which is typing gone with no sentence. The window is
 * small in practice, because `sweep()` removes stale keys on the first mount
 * after an upgrade; it is the person who signs out before that who is being
 * protected here.
 */
export async function waitingOnDevice(
  store: KeyValueStore,
  exceptQueueIn: string | null,
): Promise<OutboxCounts> {
  const total: OutboxCounts = { pending: 0, conflicted: 0, rejected: 0 };
  for (const key of await store.keys()) {
    if (isStaleVersion(key)) {
      total.pending += 1;
      continue;
    }
    const parsed = parseKey(key);
    if (parsed === null) continue;
    if (parsed.kind === "draft") {
      total.pending += 1;
      continue;
    }
    if (parsed.kind !== "outbox" || parsed.workspaceId === exceptQueueIn) continue;
    const some = counts(await getOutbox(store, parsed.workspaceId));
    total.pending += some.pending;
    total.conflicted += some.conflicted;
    total.rejected += some.rejected;
  }
  return total;
}

/* ------------------------------ housekeeping ---------------------------- */

/**
 * Forget everything this feature has ever written.
 *
 * Called on sign-out — by `forget.ts`, which owns opening the store, and which
 * the console's sign-out button awaits *before* it ends the session. Note text
 * is the customer's private content and a signed out browser has no business
 * holding a readable copy of it — the same reasoning that keeps credentials off
 * the device, applied to the thing the credentials reach.
 *
 * **It takes the queue with it, and that is deliberate rather than careless.**
 * Signing out is an explicit act by the person who typed those edits, and a
 * queue that survives it would drain into the bucket of whoever signs in next
 * on that machine. The console warns before signing out with writes waiting;
 * see `signOutWarning` in `copy.ts` and `waitingOnDevice` above, which is what
 * makes that warning cover the contexts the console is not showing.
 */
export async function forgetEverything(store: KeyValueStore): Promise<void> {
  for (const key of ownedKeys(await store.keys())) await store.remove(key);
}

/**
 * Forget one context.
 *
 * For a context that was **left**: what is cached is then a copy of somewhere
 * the person can no longer reach. That is the only caller, and this comment
 * used to name two more — revoked, and rebound — which nothing wired and which
 * `forget.ts` now argues against rather than leaves as a to-do.
 */
export async function forgetWorkspace(
  store: KeyValueStore,
  workspaceId: string,
): Promise<void> {
  for (const key of await store.keys()) {
    if (parseKey(key)?.workspaceId === workspaceId) await store.remove(key);
  }
}

/**
 * Apply the two bounds, and drop records written by a version we cannot read.
 *
 * Notes and listings only. A draft or a queued write is somebody's typing and
 * is never swept — see the file comment.
 */
export async function sweep(
  store: KeyValueStore,
  options: { now: number; maxAgeMs?: number; maxEntries?: number },
): Promise<{ removed: number }> {
  const maxAge = options.maxAgeMs ?? MAX_AGE_MS;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  let removed = 0;

  const evictable: { key: string; cachedAt: number }[] = [];

  for (const key of await store.keys()) {
    if (isStaleVersion(key)) {
      await store.remove(key);
      removed += 1;
      continue;
    }
    const parsed = parseKey(key);
    if (parsed === null) continue;
    if (parsed.kind !== "note" && parsed.kind !== "listing") continue;

    const record = decode<unknown>(await store.get(key));
    if (record === null || options.now - record.cachedAt > maxAge) {
      await store.remove(key);
      removed += 1;
      continue;
    }
    evictable.push({ key, cachedAt: record.cachedAt });
  }

  if (evictable.length > maxEntries) {
    const oldestFirst = evictable.sort((a, b) => a.cachedAt - b.cachedAt);
    for (const { key } of oldestFirst.slice(0, evictable.length - maxEntries)) {
      await store.remove(key);
      removed += 1;
    }
  }

  return { removed };
}
