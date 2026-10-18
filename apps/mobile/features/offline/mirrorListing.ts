/**
 * The first step of keeping the mirror in step with the bucket: learning
 * what the context holds now, before a single body is read. Split out of
 * `mirrorSync.ts`, whose header holds the rules; that file re-exports this.
 *
 * Two ways to learn it. A **walk** pages the whole manifest, and a complete
 * one is the only thing that may prune by absence. A **catch-up**
 * (`listChanges`) asks the tree table's change log what changed since the
 * last walk or catch-up — new and changed keys, keys that left, folders that
 * emptied — and prunes exactly what it names. A catch-up is only tried where
 * the last run left the copy complete (or short only of notes the server
 * would not read, see `INCOMPLETE_WALK_MS`), the server said where to resume,
 * and the last whole walk is recent; anything the server cannot answer that
 * way (`full`) is a walk.
 */

import type { CacheScope } from "./keys";
import type { ChangeCursor, IncompleteReason } from "./mirror";
import type { Visibility } from "../console/files/types";
import type { VisibilityTier } from "../console/visibility";
import { readIndex } from "./mirror";
import type { ChangesPage, ManifestEntry, ManifestPage, MirrorSyncDeps } from "./mirrorSync";

/**
 * Manifest pages one run will follow. Ten thousand entries a page, so this is
 * a million notes — a bound on a loop, not on a context anybody has.
 */
export const MAX_MANIFEST_PAGES = 100;

/**
 * What one walk of a context's manifest found: the metadata, before a single
 * body is read. The console's tree is drawn from this; the bodies follow.
 */
export interface ContextListing {
  workspaceId: string;
  scope: CacheScope;
  listed: Map<string, ManifestEntry>;
  /**
   * The folders, exactly, when the server said them on every page; `null` for
   * a server older than the field, where a folder is whatever paths imply.
   */
  folders: Map<string, Visibility> | null;
  complete: boolean;
  incomplete?: IncompleteReason;
  manifestUsable: boolean;
  /** When the walk started — what the listing is at least as new as. */
  listedAt: number;
  /**
   * A catch-up rather than a walk: `listed` is only what changed, and these
   * are exactly what left. Nothing is pruned by absence.
   */
  delta?: { gone: Set<string>; goneFolders: Set<string> };
  /** Where the next catch-up resumes; `null` when it cannot, and the next run walks. */
  changes?: ChangeCursor | null;
  /**
   * A catch-up that heard of nothing: no key, no folder, and the cursor where
   * it was. There is nothing to write, and `syncAll` writes nothing.
   */
  unchanged?: boolean;
}

/**
 * Walk a context's manifest. `null` when there is nothing this run may do for
 * it, `"aborted"` when the session ended part-way, and an empty `listed` with
 * `incomplete` when not one page arrived.
 */
export async function listContext(
  deps: Pick<MirrorSyncDeps, "manifest" | "mine" | "now" | "maxPages">,
  target: { workspaceId: string; tier: VisibilityTier },
): Promise<(ContextListing & { pagesListed: number }) | "aborted" | null> {
  /*
    `unknown` downloads nothing and deletes nothing. It is the moment before a
    role has landed, or a role a newer control plane invented, and there is no
    honest clearance to file a copy under — `keys.ts` argues it for the cache
    and it is the same argument here. It is also not a reason to *prune*: an
    unknown clearance is not a smaller one.
  */
  if (target.tier === "unknown") return null;
  const scope: CacheScope = target.tier;
  const { workspaceId } = target;
  if (!deps.mine()) return null;
  const listedAt = deps.now();

  const listed = new Map<string, ManifestEntry>();
  let folders: Map<string, Visibility> | null = new Map();
  let complete = true;
  let incomplete: IncompleteReason | undefined;
  let manifestUsable = true;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const maxPages = deps.maxPages ?? MAX_MANIFEST_PAGES;
  let pagesListed = 0;
  let resume: { since: number; privacy: string } | null = null;

  for (let page = 0; ; page += 1) {
    if (page >= maxPages) {
      complete = false;
      incomplete = "manifest-truncated";
      break;
    }
    let result: ManifestPage;
    try {
      result = await deps.manifest(workspaceId, cursor);
    } catch {
      // Offline, timed out, refused — a listing that stopped is a floor.
      complete = false;
      incomplete = "interrupted";
      break;
    }
    if (!deps.mine()) return "aborted";
    pagesListed += 1;
    manifestUsable = result.manifestUsable;
    if (page === 0 && typeof result.since === "number" && typeof result.privacy === "string") {
      resume = { since: result.since, privacy: result.privacy };
    }
    for (const entry of result.entries) {
      if (entry.path.endsWith("/")) continue;
      listed.set(entry.path, entry);
    }
    // One page without the field and the set is not exact: a folder another
    // page would have named is missing, and "missing" must not read as "gone".
    if (Array.isArray(result.folders) && folders !== null) {
      for (const folder of result.folders) folders.set(folder.path, folder.visibility);
    } else {
      folders = null;
    }
    if (result.truncated) {
      complete = false;
      incomplete = "manifest-truncated";
      break;
    }
    if (result.cursor === null) break;
    if (result.cursor === cursor || seenCursors.has(result.cursor)) {
      // A cursor that does not move would loop forever; the server already
      // refuses to hand one out, and this refuses to trust that it did.
      complete = false;
      incomplete = "manifest-truncated";
      break;
    }
    seenCursors.add(result.cursor);
    cursor = result.cursor;
  }
  return {
    workspaceId,
    scope,
    listed,
    folders,
    complete,
    ...(incomplete === undefined ? {} : { incomplete }),
    manifestUsable,
    listedAt,
    pagesListed,
    // Only a whole walk is a base to catch up from.
    changes: complete && resume !== null ? { ...resume, after: "", walkedAt: listedAt } : null,
  };
}

/**
 * How long a copy may go on catching up before it is walked whole again. A
 * catch-up tells a member of a key that left only when its writer said who
 * could see it (`treeChanges.ts` on the server), so a walk now and then is
 * what clears anything else that left.
 */
export const FULL_WALK_MS = 60 * 60_000;

/**
 * The same, for a copy catching up from the Convex tree's change log
 * (`nodesFeed.ts`). Every row that leaves there records who could see it, so
 * a member is told of everything they could see leave, and the walk is only
 * a backstop.
 */
export const NODES_FULL_WALK_MS = 24 * 60 * 60_000;

/** How long a copy may catch up from this cursor before it is walked whole. */
export function fullWalkAfter(cursor: ChangeCursor): number {
  return cursor.privacy.startsWith("nodes:") ? NODES_FULL_WALK_MS : FULL_WALK_MS;
}

/**
 * How long a copy short only of notes the server would not read (`read-failed`)
 * catches up before it is walked whole again, which is when those notes are
 * asked for again. Without it such a copy was walked on every trigger — every
 * head move in any workspace — and every walk rewrote the whole index on the
 * JS thread: Dev2's phone stopped answering taps for a minute at a time
 * (2026-10-16) with three notes that would not download. A copy a dropped
 * connection left short (`interrupted`) is not held back: its next run walks
 * and resumes the downloads.
 */
export const INCOMPLETE_WALK_MS = 10 * 60_000;

/** Change-log pages one catch-up will follow before committing what it has. */
export const MAX_CHANGE_PAGES = 20;

/**
 * What a context holds now: a catch-up where one can answer, else a walk.
 * The same answers as `listContext`.
 */
export async function listForSync(
  deps: Pick<MirrorSyncDeps, "manifest" | "changes" | "mine" | "now" | "maxPages" | "store">,
  target: { workspaceId: string; tier: VisibilityTier },
): Promise<(ContextListing & { pagesListed: number }) | "aborted" | null> {
  if (target.tier === "unknown" || deps.changes === undefined) return await listContext(deps, target);
  const index = await readIndex(deps.store, target.tier, target.workspaceId).catch(() => null);
  const cursor = index?.changes;
  const age = cursor === undefined ? Infinity : deps.now() - cursor.walkedAt;
  const caughtUp =
    cursor !== undefined &&
    index?.listedComplete === true &&
    age < fullWalkAfter(cursor) &&
    (index.complete === true || (index.incomplete === "read-failed" && age < INCOMPLETE_WALK_MS));
  if (!caughtUp) return await listContext(deps, target);
  const delta = await listChanges(deps, target, cursor);
  return delta === "walk" ? await listContext(deps, target) : delta;
}

/**
 * Follow the change log from `cursor`. `"walk"` when the server cannot answer
 * that way; an empty listing with `interrupted` when not one page arrived.
 */
export async function listChanges(
  deps: Pick<MirrorSyncDeps, "changes" | "mine" | "now">,
  target: { workspaceId: string; tier: VisibilityTier },
  cursor: ChangeCursor,
): Promise<(ContextListing & { pagesListed: number }) | "aborted" | "walk" | null> {
  if (target.tier === "unknown" || deps.changes === undefined) return null;
  const scope: CacheScope = target.tier;
  const { workspaceId } = target;
  if (!deps.mine()) return null;
  const listedAt = deps.now();
  const listed = new Map<string, ManifestEntry>();
  const folders = new Map<string, Visibility>();
  const gone = new Set<string>();
  const goneFolders = new Set<string>();
  let at = { since: cursor.since, after: cursor.after, privacy: cursor.privacy };
  let manifestUsable = true;
  let pagesListed = 0;
  for (let page = 0; page < MAX_CHANGE_PAGES; page += 1) {
    let result: ChangesPage;
    try {
      result = await deps.changes(workspaceId, at);
    } catch {
      break;
    }
    if (!deps.mine()) return "aborted";
    if (result.full || result.privacy === null) return "walk";
    pagesListed += 1;
    manifestUsable = result.manifestUsable;
    // In log order: a later row about a key replaces an earlier one.
    for (const entry of result.entries) {
      if (entry.path.endsWith("/")) continue;
      gone.delete(entry.path);
      listed.set(entry.path, entry);
    }
    for (const path of result.gone) {
      listed.delete(path);
      gone.add(path);
    }
    for (const folder of result.goneFolders) {
      folders.delete(folder);
      goneFolders.add(folder);
    }
    for (const folder of result.folders) {
      goneFolders.delete(folder.path);
      folders.set(folder.path, folder.visibility);
    }
    at = { since: result.since, after: result.after, privacy: result.privacy };
    if (!result.more) break;
  }
  if (pagesListed === 0) {
    return { workspaceId, scope, listed, folders: null, complete: false, incomplete: "interrupted", manifestUsable, listedAt, pagesListed };
  }
  return {
    workspaceId,
    scope,
    listed,
    folders,
    complete: true,
    manifestUsable,
    listedAt,
    pagesListed,
    delta: { gone, goneFolders },
    changes: { ...at, walkedAt: cursor.walkedAt },
    ...(listed.size === 0 &&
    gone.size === 0 &&
    folders.size === 0 &&
    goneFolders.size === 0 &&
    at.since === cursor.since &&
    at.after === cursor.after &&
    at.privacy === cursor.privacy
      ? { unchanged: true }
      : {}),
  };
}
