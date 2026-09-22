import type { Cached } from "./cache";
import { CACHE_SCOPES, readableAt, type CacheScope } from "./keys";
import { utf8Length } from "./mirrorPath";
import type { MirrorSlot, MirrorStore } from "./mirrorStoreCore";
import type { FileEntry, FolderListing, OpenNote, Visibility } from "../console/files/types";

/**
 * Every note a person can see, on the device — the rules, over a `MirrorStore`.
 *
 * `cache.ts` holds what somebody happened to open, bounded to 200 records in a
 * five-megabyte store. The mirror holds the whole of each context the person
 * can reach, reconciled with the bucket whenever there is a connection
 * (`mirrorSync.ts`), so a phone on a train can open a note nobody opened
 * before and browse a folder nobody expanded. It is still a **disposable
 * derivative** (non-negotiable #3): deleting all of it loses nothing but a
 * download, and nothing here is ever the only copy of anything. A person's
 * typing is not in the mirror at all — drafts and the queue stay in
 * `cache.ts`/`outbox.ts`, unbounded and never evicted — and that separation is
 * what lets the mirror be pruned freely.
 *
 * ## The shape on the device
 *
 * One **index** per (clearance, workspace) — path → version, size, the
 * visibility fields a listing would carry, `readOnly`, `encrypted`, when the
 * bucket last confirmed it — plus one **body record** per note, stored as
 * `{ path, etag, text }`. The index is the commit point: a body is only served
 * when the index names it *and* the record's own path and etag match the
 * entry. So a body written by a sync that died before its index write is
 * unreachable rather than stale, and a hashed filename that collided
 * (`mirrorPath.ts`) reads as a miss rather than as another note's text.
 *
 * ## The clearance is in the address, as it is for the cache
 *
 * An index is filed under the tier it was read at (`keys.ts` carries the whole
 * argument), and read through `readableAt`: an owner may be served a copy a
 * `team` session took, a `team` session never an owner's. `unknown` reads and
 * writes nothing — `CacheScope` excludes it, so there is no way to spell it.
 *
 * ## The ancestor rule
 *
 * A three-way merge needs the body at the version the draft was typed against
 * (`EditorState.draftBase`, `RestoredDraft.baseEtag`), and `offerMerge` will
 * only call a copy an ancestor when its etag *is* that version. The read cache
 * got that for free by accident — nothing overwrote a note nobody reopened. A
 * mirror overwrites every changed note on every sync, so without a rule it
 * would destroy exactly the ancestor a queued edit needs, on the reconnection
 * that is about to conflict it.
 *
 * So each entry can hold one more body, in the `base` slot: **whenever a
 * newer version is about to replace a body whose etag some pending local work
 * is based on, the old body is copied to `base` first.** "Pending local work"
 * is whatever `Needed` answers — the queue, the drafts, and what the open
 * editor holds (`mirrorHolds.ts`). The base goes when nothing needs it any
 * more, and always when the note turns out to be encrypted: an ancestor of a
 * note that is now ciphertext is plaintext this device was asked to stop
 * holding.
 */

export const MIRROR_INDEX_VERSION = 1;

export interface MirrorEntry {
  path: string;
  /**
   * The version the body is at. For an entry with no body (an attachment),
   * the version the manifest listed, or `""` when the store gave none.
   */
  etag: string;
  /** Provider object version used to compare the mirror with the manifest. */
  rawEtag?: string;
  size?: number;
  updatedAt?: number;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
  encrypted?: boolean;
  /**
   * A body is on this device at `etag`. `false` for a file the console lists
   * but does not open as a note — an image, a PDF — which the mirror names so
   * the offline tree matches the online one, and never downloads.
   */
  body: boolean;
  /** When the bucket last confirmed this version. What "cached … ago" counts from. */
  syncedAt: number;
  /** The etag of an ancestor held in the `base` slot for a merge. */
  base?: string;
}

/** Why the last sync did not leave this context complete. */
export type IncompleteReason =
  /** The manifest itself said it could not list everything. */
  | "manifest-truncated"
  /** Some notes could not be read — refused, or the store failed. */
  | "read-failed"
  /** The run stopped part-way: the connection went, or the app was closed. */
  | "interrupted";

export interface MirrorIndex {
  v: typeof MIRROR_INDEX_VERSION;
  /**
   * A `Map`, never an object keyed by path: a bucket key may be `__proto__`
   * or `constructor`, and on a plain object the first assignment of one sets
   * the prototype and the second reads `Object`'s. Serialised as arrays.
   */
  entries: Map<string, MirrorEntry>;
  /**
   * Folder path → its own default visibility, as the last listing that named
   * it said. Only for the badge on a folder row offline: the manifest lists
   * notes, not folders, and the privacy rules that decide a folder's default
   * are not on this device. See `folderVisibility` for what happens without one.
   */
  folders: Map<string, Visibility>;
  /** When a sync run last finished, complete or not. */
  lastSyncedAt?: number;
  /** The last run listed everything and fetched everything it listed. */
  complete?: boolean;
  /** Notes the last run listed that are not on this device at their current version. */
  remaining?: number;
  incomplete?: IncompleteReason;
  manifestUsable?: boolean;
}

export function emptyIndex(): MirrorIndex {
  return { v: MIRROR_INDEX_VERSION, entries: new Map(), folders: new Map() };
}

/**
 * Whether the console opens a path as a note, and so whether the mirror
 * downloads it. The same test `paths.ts` uses (`isMarkdown`), spelled here so
 * this module does not pull the file browser's helpers into every importer.
 */
export function isNotePath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/**
 * Which etags some local work is based on, per path.
 *
 * A function rather than a set so the caller decides where the answer comes
 * from — `mirrorHolds.neededEtags` reads the queue, the drafts and the open
 * editor, and a test passes a literal.
 */
export type Needed = (path: string) => ReadonlySet<string>;

export const NOTHING_NEEDED: Needed = () => new Set();

/* ------------------------------ serialisation ----------------------------- */

const VISIBILITY = /^(private|team|@.+)$/;

function isVisibility(value: unknown): value is Visibility {
  return typeof value === "string" && VISIBILITY.test(value);
}

/**
 * An index read back, or `null` for anything that is not one. Never a throw:
 * this runs on the path that draws the console, and an index written by a
 * version that shaped it differently has to read as "not mirrored yet" — the
 * next sync rebuilds it — rather than as entries with `undefined` in them.
 */
export function parseIndex(raw: string | null): MirrorIndex | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Omit<SerialisedIndex, "v">> & { v?: unknown };
    if (parsed?.v !== MIRROR_INDEX_VERSION || !Array.isArray(parsed.entries)) return null;
    const entries = new Map<string, MirrorEntry>();
    for (const value of parsed.entries) {
      const entry = value as Partial<MirrorEntry>;
      if (typeof entry?.path !== "string" || typeof entry.etag !== "string") continue;
      if (!isVisibility(entry.visibility) || !isVisibility(entry.inherited)) continue;
      if (typeof entry.body !== "boolean" || typeof entry.syncedAt !== "number") continue;
      entries.set(entry.path, {
        path: entry.path,
        etag: entry.etag,
        ...(typeof entry.rawEtag === "string" ? { rawEtag: entry.rawEtag } : {}),
        visibility: entry.visibility,
        inherited: entry.inherited,
        exception: entry.exception === true,
        readOnly: entry.readOnly === true,
        body: entry.body,
        syncedAt: entry.syncedAt,
        ...(typeof entry.size === "number" ? { size: entry.size } : {}),
        ...(typeof entry.updatedAt === "number" ? { updatedAt: entry.updatedAt } : {}),
        ...(entry.encrypted === true ? { encrypted: true } : {}),
        ...(typeof entry.base === "string" ? { base: entry.base } : {}),
      });
    }
    const folders = new Map<string, Visibility>();
    for (const pair of Array.isArray(parsed.folders) ? parsed.folders : []) {
      if (Array.isArray(pair) && typeof pair[0] === "string" && isVisibility(pair[1])) {
        folders.set(pair[0], pair[1]);
      }
    }
    return {
      v: MIRROR_INDEX_VERSION,
      entries,
      folders,
      ...(typeof parsed.lastSyncedAt === "number" ? { lastSyncedAt: parsed.lastSyncedAt } : {}),
      ...(typeof parsed.complete === "boolean" ? { complete: parsed.complete } : {}),
      ...(typeof parsed.remaining === "number" ? { remaining: parsed.remaining } : {}),
      ...(typeof parsed.incomplete === "string"
        ? { incomplete: parsed.incomplete as IncompleteReason }
        : {}),
      ...(typeof parsed.manifestUsable === "boolean"
        ? { manifestUsable: parsed.manifestUsable }
        : {}),
    };
  } catch {
    return null;
  }
}

interface SerialisedIndex extends Omit<MirrorIndex, "entries" | "folders"> {
  entries: MirrorEntry[];
  folders: [string, Visibility][];
}

export function serialiseIndex(index: MirrorIndex): string {
  const { entries, folders, ...meta } = index;
  const out: SerialisedIndex = { ...meta, entries: [...entries.values()], folders: [...folders] };
  return JSON.stringify(out);
}

export async function readIndex(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
): Promise<MirrorIndex | null> {
  return parseIndex(await store.readIndex(scope, workspaceId));
}

interface BodyRecord {
  path: string;
  etag: string;
  text: string;
}

/** The body at `etag` for `path`, or `null` — including for a record that is some other note's. */
async function readBody(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
  slot: MirrorSlot,
  path: string,
  etag: string,
): Promise<string | null> {
  const raw = await store.readBody(scope, workspaceId, slot, path);
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw) as Partial<BodyRecord>;
    if (record?.path !== path || record.etag !== etag || typeof record.text !== "string") {
      return null;
    }
    return record.text;
  } catch {
    return null;
  }
}

function writeBody(
  store: MirrorStore,
  epoch: number,
  scope: CacheScope,
  workspaceId: string,
  slot: MirrorSlot,
  record: BodyRecord,
): Promise<boolean> {
  return store.writeBody(epoch, scope, workspaceId, slot, record.path, JSON.stringify(record));
}

/* ---------------------------------- locks --------------------------------- */

/*
  Read-modify-write of one index is serialised per (clearance, workspace) in
  this process. The store's own queue orders single operations; this orders the
  *sequence* — read the index, write some bodies, write the index — so a note
  opened while a sync batch is being committed cannot have its entry dropped by
  the batch's older copy of the index. Keyed per store instance, so the tests'
  many stores do not wait on each other.
*/
const locks = new WeakMap<MirrorStore, Map<string, Promise<unknown>>>();

function withLock<T>(store: MirrorStore, key: string, work: () => Promise<T>): Promise<T> {
  let held = locks.get(store);
  if (held === undefined) {
    held = new Map();
    locks.set(store, held);
  }
  const previous = held.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settledNext = next.catch(() => {});
  held.set(key, settledNext);
  void settledNext.then(() => {
    if (held!.get(key) === settledNext) held!.delete(key);
  });
  return next;
}

/**
 * Change one index under its lock, and write it back — or not.
 *
 * `change` may read and write bodies through `store` with the same `epoch`,
 * and answers `false` to abandon the write-back (the session ended part-way).
 * `create` decides whether an index that does not exist yet is started: a sync
 * or a note read starts one; remembering folder names does not, because an
 * index is what says "this context is mirrored" and a listing is not that.
 */
export function updateIndex(
  store: MirrorStore,
  epoch: number,
  scope: CacheScope,
  workspaceId: string,
  change: (index: MirrorIndex) => Promise<boolean> | boolean,
  options: { create: boolean } = { create: true },
): Promise<boolean> {
  return withLock(store, `${scope}\u001f${workspaceId}`, async () => {
    const existing = await readIndex(store, scope, workspaceId);
    if (existing === null && !options.create) return false;
    const index = existing ?? emptyIndex();
    if (!(await change(index))) return false;
    return store.writeIndex(epoch, scope, workspaceId, serialiseIndex(index));
  });
}

/* ------------------------------ the ancestor ------------------------------ */

/**
 * Put one version of a note into an index that may already hold another, and
 * keep the ancestor anybody's typing still needs. See the file comment.
 *
 * Answers the `base` the entry should now carry, or `false` when a body write
 * was refused by the barrier — the session ended — so the caller abandons the
 * index write that would have named it.
 */
async function placeBody(
  store: MirrorStore,
  epoch: number,
  scope: CacheScope,
  workspaceId: string,
  index: MirrorIndex,
  incoming: { path: string; etag: string; text: string; encrypted: boolean },
  needed: Needed,
): Promise<false | { base: string | undefined }> {
  const { path } = incoming;
  const existing = index.entries.get(path);
  const wanted = needed(path);
  let base = existing?.base;

  if (incoming.encrypted) {
    // Ciphertext now: whatever ancestor this device holds is plaintext it was
    // asked to stop holding, and nothing can merge against an envelope anyway.
    base = undefined;
  } else if (
    existing?.body === true &&
    existing.etag !== incoming.etag &&
    wanted.has(existing.etag) &&
    existing.encrypted !== true
  ) {
    const text = await readBody(store, scope, workspaceId, "current", path, existing.etag);
    if (text !== null) {
      const kept = await writeBody(store, epoch, scope, workspaceId, "base", {
        path,
        etag: existing.etag,
        text,
      });
      if (!kept) return false;
      base = existing.etag;
    }
  } else if (base !== undefined && !wanted.has(base)) {
    base = undefined;
  }

  if (existing?.base !== undefined && base === undefined) {
    await store.removeBody(scope, workspaceId, "base", path);
  }

  const written = await writeBody(store, epoch, scope, workspaceId, "current", {
    path,
    etag: incoming.etag,
    text: incoming.text,
  });
  if (!written) return false;
  return { base };
}

function entryOf(note: OpenNote, now: number, previous?: MirrorEntry): MirrorEntry {
  return {
    path: note.path,
    etag: note.etag,
    rawEtag: note.rawEtag ?? note.etag,
    size: utf8Length(note.text),
    ...(previous?.updatedAt !== undefined ? { updatedAt: previous.updatedAt } : {}),
    visibility: note.visibility,
    inherited: note.inherited,
    exception: note.exception,
    readOnly: note.readOnly,
    ...(note.encrypted === true ? { encrypted: true } : {}),
    body: true,
    syncedAt: now,
  };
}

/**
 * Put notes the bucket just returned into the mirror, in one index write.
 *
 * The one writer both halves use: a note opened online (`rememberNote`) and a
 * batch a sync fetched (`mirrorSync.ts`). One, because the ancestor rule has
 * to hold for both — an online open overwriting the ancestor is the same loss
 * as a sync doing it, and it is the older of the two: the read cache did it
 * too, whenever a note with a parked write was opened online.
 *
 * `extra` runs inside the same lock, for the sync's bookkeeping.
 */
export function putMirroredNotes(
  store: MirrorStore,
  epoch: number,
  scope: CacheScope,
  workspaceId: string,
  notes: readonly (OpenNote & { updatedAt?: number })[],
  needed: Needed,
  now: number,
  extra?: (index: MirrorIndex) => void,
): Promise<boolean> {
  return updateIndex(store, epoch, scope, workspaceId, async (index) => {
    for (const note of notes) {
      const placed = await placeBody(
        store,
        epoch,
        scope,
        workspaceId,
        index,
        { path: note.path, etag: note.etag, text: note.text, encrypted: note.encrypted === true },
        needed,
      );
      if (placed === false) return false;
      const entry = entryOf(note, now, index.entries.get(note.path));
      if (note.updatedAt !== undefined) entry.updatedAt = note.updatedAt;
      if (placed.base !== undefined) entry.base = placed.base;
      index.entries.set(note.path, entry);
    }
    extra?.(index);
    return true;
  });
}

/**
 * Move a mirrored note onto text and an etag that were just written.
 *
 * For a save that landed and a queued write that drained — the person's own
 * text, now in the bucket at `etag`. Only a note the mirror already holds is
 * moved, at every clearance that holds it: a save result carries none of the
 * visibility fields, so inventing an entry would put wrong access markers on a
 * note read offline, and the next sync lists it properly. Writing a person's
 * own text into a `team` copy discloses nothing: the entry being there is the
 * proof that clearance could read that path.
 */
export async function moveMirroredBody(
  store: MirrorStore,
  epoch: number,
  workspaceId: string,
  body: { path: string; text: string; etag: string; rawEtag?: string },
  needed: Needed,
  now: number,
): Promise<void> {
  for (const scope of CACHE_SCOPES) {
    await updateIndex(
      store,
      epoch,
      scope,
      workspaceId,
      async (index) => {
        const existing = index.entries.get(body.path);
        if (existing === undefined || !existing.body) return false;
        const placed = await placeBody(
          store,
          epoch,
          scope,
          workspaceId,
          index,
          { ...body, encrypted: existing.encrypted === true },
          needed,
        );
        if (placed === false) return false;
        const { base: _previousBase, ...rest } = existing;
        const rawEtag = body.rawEtag ??
          (body.etag.startsWith("c2.") ? existing.rawEtag : body.etag);
        index.entries.set(body.path, {
          ...rest,
          etag: body.etag,
          ...(rawEtag === undefined ? {} : { rawEtag }),
          size: utf8Length(body.text),
          syncedAt: now,
          ...(placed.base !== undefined ? { base: placed.base } : {}),
        });
        return true;
      },
      { create: false },
    );
  }
}

/**
 * Drop one note from the mirror at every clearance — both bodies and the entry.
 *
 * For the one case where a copy has to go *now*: a note that has just become
 * ciphertext, whose mirrored body is the plaintext the lock was meant to be the
 * last of. The bodies go first and unconditionally (a removal needs no epoch),
 * so even a write-back refused by an ended session leaves nothing readable.
 */
export async function forgetMirroredNote(
  store: MirrorStore,
  epoch: number,
  workspaceId: string,
  path: string,
): Promise<void> {
  for (const scope of CACHE_SCOPES) {
    await store.removeBody(scope, workspaceId, "current", path);
    await store.removeBody(scope, workspaceId, "base", path);
    await updateIndex(
      store,
      epoch,
      scope,
      workspaceId,
      (index) => {
        return index.entries.delete(path);
      },
      { create: false },
    );
  }
}

/**
 * Remember the folder defaults a listing reported, for the badges offline.
 * Never starts an index — see `updateIndex`.
 */
export function rememberMirroredFolders(
  store: MirrorStore,
  epoch: number,
  scope: CacheScope,
  workspaceId: string,
  listing: FolderListing,
): Promise<boolean> {
  return updateIndex(
    store,
    epoch,
    scope,
    workspaceId,
    (index) => {
      let changed = false;
      const note = (path: string, visibility: Visibility) => {
        if (index.folders.get(path) !== visibility) {
          index.folders.set(path, visibility);
          changed = true;
        }
      };
      note(listing.path, listing.folderDefault);
      for (const entry of listing.entries) {
        if (entry.kind === "folder") note(entry.path, entry.visibility);
      }
      return changed;
    },
    { create: false },
  );
}

/* ------------------------------- the reads -------------------------------- */

function noteOf(entry: MirrorEntry, text: string): OpenNote {
  return {
    path: entry.path,
    text,
    etag: entry.etag,
    ...(entry.rawEtag === undefined ? {} : { rawEtag: entry.rawEtag }),
    visibility: entry.visibility,
    inherited: entry.inherited,
    exception: entry.exception,
    readOnly: entry.readOnly,
    ...(entry.encrypted === true ? { encrypted: true } : {}),
  };
}

/** The mirrored note, served under the clearances `scope` may read. */
export async function mirroredNote(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
  path: string,
): Promise<Cached<OpenNote> | null> {
  for (const at of readableAt(scope)) {
    const entry = (await readIndex(store, at, workspaceId))?.entries.get(path);
    if (entry === undefined || !entry.body) continue;
    const text = await readBody(store, at, workspaceId, "current", path, entry.etag);
    if (text !== null) return { value: noteOf(entry, text), cachedAt: entry.syncedAt };
  }
  return null;
}

/**
 * One entry's current body, read at exactly the clearance `at` and nowhere
 * else — unlike `mirroredNote`, which walks `readableAt`.
 *
 * For the device search (`mirrorSearch.ts`), which searches one index and must
 * read only the bodies that index names: an entry from the `team` index paired
 * with a body from the `private` slot would be a private note's text answering
 * a query nobody at that clearance may ask. The record's own path and etag are
 * checked as for every other read, so a body the index has moved past is a miss.
 */
export function mirroredBodyAt(
  store: MirrorStore,
  at: CacheScope,
  workspaceId: string,
  entry: MirrorEntry,
): Promise<string | null> {
  if (!entry.body) return Promise.resolve(null);
  return readBody(store, at, workspaceId, "current", entry.path, entry.etag);
}

/**
 * The body a three-way merge may use as the ancestor of a draft based on
 * `baseEtag`: the current copy if it is at that version, the held `base` if
 * that is, and otherwise the current copy anyway — so `offerMerge` sees an
 * etag that does not match and says "moved on", which is the true sentence,
 * rather than "cleared".
 */
export async function mirroredAncestor(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
  path: string,
  baseEtag: string | null,
): Promise<{ text: string; etag: string } | null> {
  let fallback: { text: string; etag: string } | null = null;
  for (const at of readableAt(scope)) {
    const entry = (await readIndex(store, at, workspaceId))?.entries.get(path);
    if (entry === undefined || !entry.body) continue;
    if (baseEtag !== null && entry.base === baseEtag) {
      const text = await readBody(store, at, workspaceId, "base", path, baseEtag);
      if (text !== null) return { text, etag: baseEtag };
    }
    const text = await readBody(store, at, workspaceId, "current", path, entry.etag);
    if (text === null) continue;
    if (baseEtag !== null && entry.etag === baseEtag) return { text, etag: entry.etag };
    fallback ??= { text, etag: entry.etag };
  }
  return fallback;
}

/** The index this clearance is served, or `null` when nothing is mirrored for it. */
export async function readableIndex(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
): Promise<MirrorIndex | null> {
  for (const at of readableAt(scope)) {
    const index = await readIndex(store, at, workspaceId);
    if (index !== null) return index;
  }
  return null;
}

/** A folder's listing, derived from the index, for any folder — opened before or not. */
export async function mirroredListing(
  store: MirrorStore,
  scope: CacheScope,
  workspaceId: string,
  folder: string,
): Promise<Cached<FolderListing> | null> {
  const index = await readableIndex(store, scope, workspaceId);
  if (index === null) return null;
  const listing = listingOf(index, folder);
  if (listing === null) return null;
  return { value: listing, cachedAt: index.lastSyncedAt ?? newestSync(index) };
}

function newestSync(index: MirrorIndex): number {
  let newest = 0;
  for (const entry of index.entries.values()) newest = Math.max(newest, entry.syncedAt);
  return newest;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * A folder row's visibility with no listing to say it.
 *
 * The rule that decides it (`visibilityOf` — the longest matching folder rule
 * in `privacy.md`) is not on the device, and `privacy.md` itself reaches only
 * an owner. Three rungs, in order of how much they can be trusted:
 *
 *  1. what the last online listing said about this folder — exact, as of then;
 *  2. a note directly inside it: a note's `inherited` *is* its folder's rule,
 *     because a rule is a folder prefix and the longest prefix covering a
 *     direct child is the folder's own;
 *  3. any note beneath it — a deeper folder may have its own rule, so this is
 *     a guess — and then `private`, the default with no rule at all.
 *
 * It is a badge. Nothing is decided by it: every note carries its own fields,
 * and what the device holds was filtered by the server before it arrived.
 */
function folderVisibility(index: MirrorIndex, folder: string): Visibility {
  const known = index.folders.get(folder);
  if (known !== undefined) return known;
  const prefix = folder === "" ? "" : `${folder}/`;
  let deeper: Visibility | null = null;
  for (const entry of index.entries.values()) {
    if (!entry.path.startsWith(prefix)) continue;
    if (!entry.path.slice(prefix.length).includes("/")) return entry.inherited;
    deeper ??= entry.inherited;
  }
  return deeper ?? "private";
}

/**
 * One folder's children as `listFiles` would draw them, from paths.
 *
 * `null` for a folder nothing on the device lives under — the same answer the
 * offline tree gave for a folder that had never been expanded, and the one
 * that makes it disappear rather than render empty. The root is always an
 * answer once there is an index.
 *
 * `truncated` is `false` because this is not a page of anything; whether the
 * mirror as a whole is complete is `mirrorStatus`'s to say, once, rather than
 * every folder's.
 */
export function listingOf(index: MirrorIndex, folder: string): FolderListing | null {
  const prefix = folder === "" ? "" : `${folder}/`;
  const files: FileEntry[] = [];
  const folders = new Set<string>();
  let known = folder === "";

  for (const entry of index.entries.values()) {
    if (!entry.path.startsWith(prefix)) continue;
    known = true;
    const rest = entry.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({
        kind: "file",
        path: entry.path,
        name: baseName(entry.path),
        visibility: entry.visibility,
        inherited: entry.inherited,
        exception: entry.exception,
        readOnly: entry.readOnly,
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
      });
    } else {
      folders.add(`${prefix}${rest.slice(0, slash)}`);
    }
  }
  if (!known) return null;

  const rows: FileEntry[] = [...folders].map((path) => {
    const visibility = folderVisibility(index, path);
    return {
      kind: "folder",
      path,
      name: baseName(path),
      visibility,
      inherited: visibility,
      exception: false,
      readOnly: false,
    };
  });
  // Folders first, then files, each by name — `compareEntries` in the server's
  // `listFolder`, so a tree does not reorder itself when the signal drops.
  const byName = (a: FileEntry, b: FileEntry) => a.name.localeCompare(b.name);
  return {
    path: folder,
    folderDefault: folderVisibility(index, folder),
    entries: [...rows.sort(byName), ...files.sort(byName)],
    truncated: false,
    manifestUsable: index.manifestUsable ?? true,
  };
}

/**
 * Take in copies the old read cache held, for paths the mirror does not have.
 *
 * Once a device has a mirror, the per-note cache in `cache.ts` is the same
 * question answered worse, and it is retired rather than kept beside the
 * mirror: two stores answering "what is this note offline" is two answers that
 * can disagree, and the older one is exactly the one a lost grant could leave
 * readable. But a copy in it may be the **ancestor** of an edit queued before
 * the upgrade, and throwing it away would take that edit's Merge with it. So
 * each copy moves in at the clearance it was filed under, dated by when it was
 * read — and only where the mirror has nothing, because a mirrored version is
 * newer than any cached one by construction. The next complete sync prunes
 * whatever of it is no longer visible, exactly as it would its own.
 */
export function adoptCachedNotes(
  store: MirrorStore,
  epoch: number,
  scope: CacheScope,
  workspaceId: string,
  copies: readonly Cached<OpenNote>[],
): Promise<boolean> {
  return updateIndex(store, epoch, scope, workspaceId, async (index) => {
    let adopted = false;
    for (const copy of copies) {
      const note = copy.value;
      if (index.entries.has(note.path)) continue;
      const written = await writeBody(store, epoch, scope, workspaceId, "current", {
        path: note.path,
        etag: note.etag,
        text: note.text,
      });
      if (!written) return false;
      index.entries.set(note.path, entryOf(note, copy.cachedAt));
      adopted = true;
    }
    return adopted;
  });
}
