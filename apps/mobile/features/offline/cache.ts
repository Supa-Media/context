import {
  CACHE_SCOPES,
  isOwnTyping,
  isStaleVersion,
  keyFor,
  keysForDepartedContexts,
  keysForWorkspace,
  ownedKeys,
  parseKey,
  readableAt,
  scopedKeyFor,
  type CacheScope,
} from "./keys";
import type { KeyValueStore } from "./memory";
import { counts, emptyOutbox, isEmpty, parseOutbox, type Outbox, type OutboxCounts } from "./outbox";
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
 * ## Why a cached read is filed under a clearance
 *
 * Every note and listing here is a copy of an answer the server had already
 * *filtered* — `scopeForRole` reads an owner at `private` and narrows everybody
 * else to `team`. Membership changes on somebody else's machine and nothing on
 * this one hears about it, so the clearance goes in the key: `keys.ts` carries
 * that argument, and `putNote` below points at the half of it that decides
 * which direction is safe. A draft and the queue carry none, deliberately;
 * that argument is in `keys.ts` too, under `UnscopedKind`.
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

/**
 * Remember what the bucket said, under the clearance that was used to ask.
 *
 * `scope` is not decoration and it is not a field on the record: it is a
 * segment of the key, so a session reading at a narrower clearance looks
 * somewhere else and finds nothing. `keys.ts` carries the whole argument,
 * including which direction is the safe one.
 */
export async function putNote(
  store: KeyValueStore,
  scope: CacheScope,
  workspaceId: string,
  note: OpenNote,
  now: number,
): Promise<void> {
  await store.set(
    scopedKeyFor("note", scope, workspaceId, note.path),
    JSON.stringify({ value: note, cachedAt: now } satisfies Cached<OpenNote>),
  );
}

export async function getNote(
  store: KeyValueStore,
  scope: CacheScope,
  workspaceId: string,
  path: string,
): Promise<Cached<OpenNote> | null> {
  return firstReadable(store, (at) => scopedKeyFor("note", at, workspaceId, path), scope);
}

/**
 * Drop the cached copy of one note, **at every clearance**.
 *
 * `putNote` files a copy under the clearance that read it, so one path can
 * hold two records — one taken at `private`, one at `team` — and a caller that
 * removed only "the one this session would read" would leave the other where
 * it is. `getNote` widens (`readableAt`), so the copy left behind is not
 * unreachable either: an owner reads the `team` one on a miss.
 *
 * That asymmetry is tolerable for eviction, where a leftover copy costs a
 * stale read. It is not tolerable for the one caller that has: a note that
 * has just become ciphertext, where the cached copy is the *plaintext* that
 * lock was supposed to be the last of. So this takes both, and takes them by
 * key rather than by scanning, because a scan would need `parseKey` to agree
 * with `scopedKeyFor` about a path — and the two disagreeing is a leak that
 * looks like a passing test.
 */
export async function clearNote(
  store: KeyValueStore,
  workspaceId: string,
  path: string,
): Promise<void> {
  for (const at of CACHE_SCOPES) {
    await store.remove(scopedKeyFor("note", at, workspaceId, path));
  }
}

/* ------------------------------ listings -------------------------------- */

export async function putListing(
  store: KeyValueStore,
  scope: CacheScope,
  workspaceId: string,
  listing: FolderListing,
  now: number,
): Promise<void> {
  await store.set(
    scopedKeyFor("listing", scope, workspaceId, listing.path),
    JSON.stringify({ value: listing, cachedAt: now } satisfies Cached<FolderListing>),
  );
}

export async function getListing(
  store: KeyValueStore,
  scope: CacheScope,
  workspaceId: string,
  path: string,
): Promise<Cached<FolderListing> | null> {
  return firstReadable(store, (at) => scopedKeyFor("listing", at, workspaceId, path), scope);
}

/**
 * The first copy this clearance is allowed to be served, or nothing.
 *
 * One place for the widening, shared by both scoped kinds, so notes and
 * listings cannot come to disagree about who may read what — the same reason
 * the gateway keeps one search path and the control plane keeps one
 * `scopeForRole`. `readableAt` decides the order and the security direction;
 * this only walks it.
 */
async function firstReadable<T>(
  store: KeyValueStore,
  keyAt: (scope: CacheScope) => string,
  scope: CacheScope,
): Promise<Cached<T> | null> {
  for (const at of readableAt(scope)) {
    const record = decode<T>(await store.get(keyAt(at)));
    if (record !== null) return record;
  }
  return null;
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

/* ---------------------------- context rows ------------------------------ */

/**
 * One row of the context list, as it is remembered for a cold start.
 *
 * ## Why this is here at all
 *
 * Every other module in this folder works only once the console already knows
 * which context is open and what the person's role in it is. Both come from
 * `listMyWorkspaces`, which is a Convex subscription — so on a launch with no
 * network neither ever arrives, `visibilityTierForRole` answers `unknown`, and
 * `useOfflineNotes` correctly refuses to serve a single cached byte. The whole
 * feature was reachable only while the process was already warm, which is not
 * the state a phone is in when somebody takes it out of a pocket on a train.
 *
 * So the list is written down as it lands, and read back when — and only when
 * — the live one has not arrived and the device says it is offline.
 *
 * ## What it holds, and what it must never hold
 *
 * Exactly the fields `listMyWorkspaces` returns: ids, a slug, a display name,
 * a role, a folder name. Identifiers and labels, the same class of thing
 * `lastPlace` already keeps, and **no note content, no etag, no draft and
 * above all no credential** — non-negotiable #1 keeps credentials off a device
 * and this is not the file that gets to be the exception. It is cleared on
 * sign-out with everything else here, and purged for a context that leaves the
 * list by `forgetDepartedContexts`.
 *
 * ## Why remembering a role is not a wider clearance
 *
 * The argument is in `keys.ts` under the `context` kind and it rests on a fact
 * about the control plane rather than on care taken here: `private` is
 * `role === "owner"` and the owner role cannot be taken away. A remembered
 * role can therefore be *stale* — a promotion from `member` to `editor` is not
 * seen until the next successful load — but it can never be *wider* than the
 * one the server would give, which is the only direction that discloses
 * anything. Both of those roles read at `team` regardless.
 */
export interface RememberedContext {
  workspaceId: string;
  slug: string;
  displayName: string;
  kind: string;
  role: string;
  meetingsFolder?: string;
  structureTemplate?: string;
  pinned?: boolean;
}

/**
 * Write down the context list that just landed, one record per context.
 *
 * Per context rather than one list record, so that every rule this folder
 * already has for "everything belonging to workspace X" reaches it for free:
 * `keysForWorkspace` takes it when somebody leaves, `keysForDepartedContexts`
 * takes it when a membership ended somewhere this device never saw, and
 * `sweep` ages it out on the same bound as the notes beside it. A single list
 * record would have needed all three taught about it separately, and the one
 * that got forgotten would be the one that leaves a context named on a device
 * its owner was removed from.
 *
 * It does not prune. The purge that runs on the same landing owns that, and
 * two writers deciding which contexts are live is how they come to disagree.
 */
export async function rememberContexts(
  store: KeyValueStore,
  contexts: readonly RememberedContext[],
  now: number,
): Promise<void> {
  for (const context of contexts) {
    await store.set(
      keyFor("context", context.workspaceId),
      JSON.stringify({ value: context, cachedAt: now }),
    );
  }
}

/**
 * Remove one remembered context row.
 *
 * Exists for the sign-out race and for nothing else: a write in flight when
 * `forgetLocalCopies` ran lands behind the clear, and a context row that
 * outlives a session is what the boot gate would read as evidence of one. Its
 * caller deletes only rows it wrote itself, only once the epoch says its
 * session is over.
 */
export async function forgetContextRow(
  store: KeyValueStore,
  workspaceId: string,
): Promise<void> {
  await store.remove(keyFor("context", workspaceId));
}

/**
 * The context list as of the last successful load, or nothing.
 *
 * Bounded by the same age as a cached note, and for the same reason: a device
 * that has not reached the server in thirty days should not still be drawing a
 * rail out of what it remembers. Every record is validated field by field —
 * this runs on the path that draws the console, so a record written by a
 * version that shaped it differently has to read as absent rather than as a
 * row with `undefined` where a slug goes.
 *
 * Unordered. The rail and `defaultContext` decide order from the list and
 * `lastPlace` already holds which context somebody was in, so a second opinion
 * about order here would be one more thing that can disagree.
 */
export async function recallContexts(
  store: KeyValueStore,
  options: { now: number; maxAgeMs?: number },
): Promise<RememberedContext[]> {
  const maxAge = options.maxAgeMs ?? MAX_AGE_MS;
  const found: RememberedContext[] = [];
  for (const key of await store.keys()) {
    if (parseKey(key)?.kind !== "context") continue;
    const record = decode<unknown>(await store.get(key));
    if (record === null || options.now - record.cachedAt > maxAge) continue;
    const context = validContext(record.value);
    if (context !== null) found.push(context);
  }
  return found;
}

/** A stored row, or `null` for anything that is not one. Never a throw. */
function validContext(value: unknown): RememberedContext | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  for (const field of ["workspaceId", "slug", "displayName", "kind", "role"]) {
    if (typeof row[field] !== "string" || row[field] === "") return null;
  }
  for (const field of ["meetingsFolder", "structureTemplate"]) {
    if (row[field] !== undefined && typeof row[field] !== "string") return null;
  }
  if (row.pinned !== undefined && typeof row.pinned !== "boolean") return null;
  return {
    workspaceId: row.workspaceId as string,
    slug: row.slug as string,
    displayName: row.displayName as string,
    kind: row.kind as string,
    role: row.role as string,
    ...(typeof row.meetingsFolder === "string" ? { meetingsFolder: row.meetingsFolder } : {}),
    ...(typeof row.structureTemplate === "string"
      ? { structureTemplate: row.structureTemplate }
      : {}),
    ...(typeof row.pinned === "boolean" ? { pinned: row.pinned } : {}),
  };
}

/* ------------------------------- outbox --------------------------------- */

export async function getOutbox(store: KeyValueStore, workspaceId: string): Promise<Outbox> {
  return parseOutbox(await store.get(keyFor("outbox", workspaceId)), workspaceId);
}

export async function putOutbox(store: KeyValueStore, outbox: Outbox): Promise<void> {
  // Empty means no edits *and* no ops: a queue holding only a rename is still
  // somebody's unsent work, and removing its record would lose it on reload.
  if (isEmpty(outbox)) {
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
 * `v1` outbox or draft was invisible here — while `forgetEverything` deletes it
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
    if (parsed.kind === "collaboration") {
      const raw = await store.get(key);
      try {
        const value: unknown = raw === null ? null : JSON.parse(raw);
        const pending = value && typeof value === "object" ? (value as { pending?: unknown }).pending : null;
        if (Array.isArray(pending) && pending.length > 0) total.pending += 1;
      } catch {
        // A malformed collaboration record is not counted as unsent work;
        // the controller keeps its in-memory queue and clearance deletes it.
      }
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

/* ---------------------------- the mirror's handover ---------------------- */

/**
 * Every note copy this cache holds, grouped by where it is filed.
 *
 * For one caller: `useOfflineNotes`, handing these to the mirror
 * (`adoptCachedNotes`) on a device that has one, before `retireCopies` takes
 * them. A record that does not parse is skipped — it was never servable.
 */
export async function cachedNoteCopies(
  store: KeyValueStore,
): Promise<{ scope: CacheScope; workspaceId: string; copies: Cached<OpenNote>[] }[]> {
  const groups = new Map<string, { scope: CacheScope; workspaceId: string; copies: Cached<OpenNote>[] }>();
  for (const key of await store.keys()) {
    const parsed = parseKey(key);
    if (parsed?.kind !== "note" || parsed.scope === null) continue;
    const record = decode<OpenNote>(await store.get(key));
    if (record === null || typeof record.value?.text !== "string") continue;
    const id = `${parsed.scope}\u001f${parsed.workspaceId}`;
    let group = groups.get(id);
    if (group === undefined) {
      group = { scope: parsed.scope, workspaceId: parsed.workspaceId, copies: [] };
      groups.set(id, group);
    }
    group.copies.push(record);
  }
  return [...groups.values()];
}

/**
 * Remove every note and listing copy — the part of this cache the mirror
 * replaces. Never a draft, never the queue, never a remembered context row:
 * `isOwnTyping` and the kind check keep this to the two scoped kinds.
 */
export async function retireCopies(store: KeyValueStore): Promise<void> {
  for (const key of await store.keys()) {
    const kind = parseKey(key)?.kind;
    if (kind === "note" || kind === "listing") await store.remove(key);
  }
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
 *
 * The set is `keysForWorkspace`, not `parseKey(key)?.workspaceId === id`, and
 * the difference is the keys this version cannot parse: a stale-version record
 * cannot be attributed to a workspace, so filtering by one silently left a left
 * context's note bodies on the device. See `keysForWorkspace` for why taking
 * them all costs nothing that `sweep` was not already taking.
 */
export async function forgetWorkspace(
  store: KeyValueStore,
  workspaceId: string,
): Promise<void> {
  for (const key of keysForWorkspace(await store.keys(), workspaceId)) {
    await store.remove(key);
  }
}

/**
 * Forget the contexts that are no longer in the person's list.
 *
 * The complement of `forgetWorkspace`: that one takes a context somebody left
 * on this device, this one takes the ones whose membership ended anywhere else
 * — an owner removing them, a shared context deleted, a grant revoked. None of
 * those reach this machine as an event; the context list the console already
 * subscribes to is the only place they show up, and until now nothing read it
 * for this.
 *
 * The set is `keysForDepartedContexts`, which is narrower than
 * `keysForWorkspace` in both directions on purpose — bucket answers only, and
 * stale-version keys left alone. Its docblock carries the argument.
 */
export async function forgetDeparted(
  store: KeyValueStore,
  known: readonly string[],
): Promise<void> {
  for (const key of keysForDepartedContexts(await store.keys(), known)) {
    await store.remove(key);
  }
}

/**
 * Apply the two bounds, and drop records written by a version we cannot read.
 *
 * Never somebody's typing: a draft and a queued write are the only copy of
 * something a person wrote, and `isOwnTyping` is what keeps this function off
 * them — see the file comment.
 *
 * **The two bounds do not cover the same set, and that is deliberate.** The
 * age bound is a privacy bound, so it takes everything disposable, a
 * remembered context row included: a device that has not reached the server in
 * a month should not still name somebody's contexts. The count bound exists
 * because note bodies fill a 5MB bucket, so it takes note bodies and listings
 * and nothing else — evicting a context row to make room would cost the boot
 * that the rest of this feature now depends on, to reclaim a few hundred
 * bytes, and the eviction would be invisible.
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
    if (isOwnTyping(parsed.kind)) continue;

    const record = decode<unknown>(await store.get(key));
    if (record === null || options.now - record.cachedAt > maxAge) {
      await store.remove(key);
      removed += 1;
      continue;
    }
    if (parsed.kind === "note" || parsed.kind === "listing") {
      evictable.push({ key, cachedAt: record.cachedAt });
    }
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
