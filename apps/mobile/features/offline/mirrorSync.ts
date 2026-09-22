import type { CacheScope } from "./keys";
import {
  isNotePath,
  putMirroredNotes,
  readIndex,
  updateIndex,
  type IncompleteReason,
  type MirrorEntry,
  type Needed,
} from "./mirror";
import type { MirrorStore } from "./mirrorStoreCore";
import type { OpenNote, Visibility } from "../console/files/types";
import type { VisibilityTier } from "../console/visibility";

/**
 * Keeping the mirror in step with the bucket: list, compare, fetch, prune.
 *
 * Per context, at the clearance this person has in it:
 *
 *  1. **Page `syncManifest`** until its cursor is `null`. Every entry is a
 *     path the server's `canSee` kept at this clearance, with the version the
 *     store listed. A key ending in `/` is a folder marker somebody's tool
 *     made, and is skipped.
 *  2. **Compare with the index.** A note is fetched when it is new, when its
 *     version changed, or when the manifest gave no version at all — "the
 *     store gave none" is never "unchanged".
 *  3. **`readNotes` in batches of at most fifty**, two batches in flight. A
 *     `deferred` path (the server's byte budget) is asked for again; a
 *     `FILE_NOT_FOUND` is an answer about that path and drops it; any other
 *     refusal leaves the local copy as it was and counts as not done.
 *  4. **Prune — only after a complete listing.** A manifest that said
 *     `truncated`, a page that failed, a cursor that did not move: each makes
 *     what arrived a floor rather than a list, and a path missing from a floor
 *     is not evidence of anything. When the listing *was* complete, every note
 *     not in it leaves the device, body and all. That one rule is what closes
 *     the gap the read cache had, where a group grant lost on another machine
 *     left the notes it had covered readable here until an age bound reached
 *     them: every complete sync re-derives, from the server's own filter, what
 *     this device may hold.
 *
 * **Contexts are synced one after another**, for the reason `drainAll.ts`
 * drains queues one after another: every call here is a round trip on the
 * customer's bucket, on their request quota. Within a context two batches may
 * be in flight, which halves the wall time of a first sync without making the
 * bucket answer fifty reads twice at once more than it has to.
 *
 * **The session is checked before every write-back**, and the store checks it
 * again inside its own queue (`mirrorStoreCore.ts`). A first sync can take
 * minutes; a sign-out in the middle of it must not have the rest of it land.
 *
 * **Never from a remembered list.** The caller passes the live context list,
 * because a remembered list is a memory, not an answer — and pruning or
 * downloading from a memory is the mistake `useLiveConsoleData` already
 * refuses for the departed-context purge.
 */

/** One `syncManifest` entry. Mirrors `ManifestEntry` in `apps/convex/functions/lib/fileOps.ts`. */
export interface ManifestEntry {
  path: string;
  etag?: string;
  size?: number;
  updatedAt?: number;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
}

export interface ManifestPage {
  entries: ManifestEntry[];
  cursor: string | null;
  truncated: boolean;
  manifestUsable: boolean;
}

/** One `readNotes` result. Mirrors `BatchRead` in `lib/fileOps.ts`. */
export type BatchRead =
  | { path: string; outcome: "read"; note: OpenNote & { encrypted?: boolean } }
  | { path: string; outcome: "error"; code: string; message: string }
  | { path: string; outcome: "deferred" };

export interface MirrorProgress {
  /** Notes the manifest listed — the denominator of "340 of 1,204". */
  total: number;
  /** On this device at their current version: already current, or fetched by this run. */
  done: number;
}

export interface MirrorSyncDeps {
  store: MirrorStore;
  /** Must reject rather than hang — the caller wraps the Convex action in a timeout. */
  manifest: (workspaceId: string, cursor: string | undefined) => Promise<ManifestPage>;
  readNotes: (workspaceId: string, paths: string[]) => Promise<BatchRead[]>;
  /** Which versions local work is based on, asked before every write-back. */
  needed: (workspaceId: string) => Promise<Needed>;
  /** The session this run belongs to, as `epoch.ts` numbers it. */
  epoch: number;
  mine: () => boolean;
  now: () => number;
  onProgress?: (workspaceId: string, progress: MirrorProgress) => void;
  /** Tests only. */
  batchSize?: number;
  concurrency?: number;
  maxPages?: number;
}

export interface MirrorRun {
  workspaceId: string;
  scope: CacheScope;
  complete: boolean;
  incomplete?: IncompleteReason;
  fetched: number;
  pruned: number;
  remaining: number;
  /** The session ended part-way and nothing more was written. */
  aborted?: boolean;
}

/** `READ_BATCH_PATHS` on the server. More is refused before the bucket is opened. */
export const MIRROR_BATCH = 50;
/** Notes written per index commit. See `commit` in `syncContext`. */
export const COMMIT_NOTES = 250;
/** Or fewer, once this much text is waiting — the memory a commit holds. */
export const COMMIT_BYTES = 4 * 1024 * 1024;
/** Batches in flight within one context. */
export const MIRROR_CONCURRENCY = 2;
/**
 * Manifest pages one run will follow. Ten thousand entries a page, so this is
 * a million notes — a bound on a loop, not on a context anybody has.
 */
export const MAX_MANIFEST_PAGES = 100;

/** Sync one context. `null` when there is nothing this run may do for it. */
export async function syncContext(
  deps: MirrorSyncDeps,
  target: { workspaceId: string; tier: VisibilityTier },
): Promise<MirrorRun | null> {
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
  const { store, epoch } = deps;
  if (!deps.mine()) return null;

  const run: MirrorRun = { workspaceId, scope, complete: false, fetched: 0, pruned: 0, remaining: 0 };
  const aborted = (): MirrorRun => ({ ...run, aborted: true });

  /* -------------------------------- 1. list ------------------------------- */

  const listed = new Map<string, ManifestEntry>();
  let complete = true;
  let incomplete: IncompleteReason | undefined;
  let manifestUsable = true;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const maxPages = deps.maxPages ?? MAX_MANIFEST_PAGES;
  let pagesListed = 0;

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
    if (!deps.mine()) return aborted();
    pagesListed += 1;
    manifestUsable = result.manifestUsable;
    for (const entry of result.entries) {
      if (entry.path.endsWith("/")) continue;
      listed.set(entry.path, entry);
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

  /*
    Nothing listed at all — offline after all, storage not connected, a
    refusal — is not a run that learned anything, so it writes nothing: an
    index created here would make a context with no notes, or one whose
    storage is down, read "only part of this context is on this device".
    Whatever the device already held, and what it said about it, stands.
  */
  if (pagesListed === 0) return { ...run, incomplete: incomplete ?? "interrupted" };

  /* ------------------------------- 2. compare ----------------------------- */

  const before = await readIndex(store, scope, workspaceId);
  const toFetch: string[] = [];
  for (const entry of listed.values()) {
    if (!isNotePath(entry.path)) continue;
    const local = before?.entries.get(entry.path);
    if (
      local === undefined ||
      !local.body ||
      entry.etag === undefined ||
      (local.rawEtag ?? local.etag) !== entry.etag
    ) {
      toFetch.push(entry.path);
    }
  }

  /* -------------------------------- 3. fetch ------------------------------ */

  const queue = [...toFetch];
  const gone = new Set<string>();
  let failed = 0;
  let stopped = false;
  let sessionEnded = false;
  const batchSize = Math.min(deps.batchSize ?? MIRROR_BATCH, MIRROR_BATCH);
  let listedNotes = 0;
  for (const path of listed.keys()) if (isNotePath(path)) listedNotes += 1;
  const current = listedNotes - toFetch.length;
  const progress = () =>
    deps.onProgress?.(workspaceId, { total: listedNotes, done: current + run.fetched });
  // Said only when there is something to download: a sync that finds nothing
  // changed should not flash "Downloading 1,204 of 1,204" at anybody.
  if (toFetch.length > 0) progress();

  const worker = async (): Promise<void> => {
    while (queue.length > 0 && !stopped && !sessionEnded) {
      const batch = queue.splice(0, batchSize);
      let results: BatchRead[];
      try {
        results = await deps.readNotes(workspaceId, batch);
      } catch {
        // The connection went or the call timed out. Everything not yet read
        // stays as it was; the next run starts from the index.
        failed += batch.length + queue.length;
        queue.length = 0;
        stopped = true;
        incomplete ??= "interrupted";
        return;
      }
      if (!deps.mine()) {
        sessionEnded = true;
        return;
      }
      const read: (OpenNote & { updatedAt?: number })[] = [];
      const deferred: string[] = [];
      for (const result of results) {
        if (!batch.includes(result.path)) continue; // an answer to a question not asked
        if (result.outcome === "read") {
          const updatedAt = listed.get(result.path)?.updatedAt;
          read.push({ ...result.note, ...(updatedAt !== undefined ? { updatedAt } : {}) });
        } else if (result.outcome === "deferred") {
          deferred.push(result.path);
        } else if (result.code === "FILE_NOT_FOUND") {
          gone.add(result.path);
        } else {
          failed += 1;
        }
      }
      const answered = new Set(results.map((result) => result.path));
      for (const path of batch) if (!answered.has(path)) failed += 1;
      if (read.length === 0 && deferred.length === batch.length) {
        // No progress at all — every path deferred and none read. Asking again
        // would ask the same thing forever.
        failed += deferred.length + queue.length;
        queue.length = 0;
        stopped = true;
        return;
      }
      queue.unshift(...deferred);
      if (read.length === 0) continue;
      pending.push(...read);
      pendingBytes += read.reduce((sum, note) => sum + note.text.length, 0);
      if (pending.length >= COMMIT_NOTES || pendingBytes >= COMMIT_BYTES) await commit();
    }
  };

  /*
    Fetched notes are written in commits of up to `COMMIT_NOTES`, not one per
    batch. Every commit rewrites the index, and a first sync of ten thousand
    notes committed per fifty-note batch would write a growing, multi-megabyte
    index two hundred times — on a phone, on the JS thread. A commit writes its
    bodies and then the index that names them, so a run that dies between
    commits leaves bodies nothing names: unreachable, and fetched again next
    time. Nothing is lost that was not a download.
  */
  const pending: (OpenNote & { updatedAt?: number })[] = [];
  let pendingBytes = 0;
  let committing: Promise<void> = Promise.resolve();
  const commit = (): Promise<void> => {
    const notes = pending.splice(0, pending.length);
    pendingBytes = 0;
    committing = committing.then(async () => {
      if (notes.length === 0 || sessionEnded) return;
      const needed = await deps.needed(workspaceId);
      if (!deps.mine()) {
        sessionEnded = true;
        return;
      }
      const written = await putMirroredNotes(store, epoch, scope, workspaceId, notes, needed, deps.now());
      if (!written) {
        sessionEnded = true;
        return;
      }
      run.fetched += notes.length;
      progress();
    });
    return committing;
  };

  await Promise.all(
    Array.from({ length: Math.max(1, deps.concurrency ?? MIRROR_CONCURRENCY) }, () => worker()),
  );
  await commit();
  if (sessionEnded || !deps.mine()) return aborted();

  /* --------------------------- 4. reconcile, prune ------------------------ */

  if (failed > 0) {
    complete = false;
    incomplete ??= "read-failed";
  }
  const needed = await deps.needed(workspaceId);
  if (!deps.mine()) return aborted();
  const now = deps.now();

  const reconciled = await updateIndex(store, epoch, scope, workspaceId, async (index) => {
    const drop = async (path: string) => {
      await store.removeBody(scope, workspaceId, "current", path);
      await store.removeBody(scope, workspaceId, "base", path);
      index.entries.delete(path);
      run.pruned += 1;
    };

    // What the server refused to read is an answer about that path, whether or
    // not the listing around it finished.
    for (const path of gone) if (index.entries.has(path)) await drop(path);

    if (complete) {
      for (const path of [...index.entries.keys()]) {
        if (!listed.has(path)) await drop(path);
      }
      // A folder name is only kept while something on the device is under it:
      // the name of a folder this person lost is not theirs to keep either.
      for (const folder of [...index.folders.keys()]) {
        if (folder === "") continue;
        const under = `${folder}/`;
        let occupied = false;
        for (const path of index.entries.keys()) {
          if (path.startsWith(under)) {
            occupied = true;
            break;
          }
        }
        if (!occupied) index.folders.delete(folder);
      }
    }

    let remaining = 0;
    for (const entry of listed.values()) {
      if (gone.has(entry.path)) continue;
      const local = index.entries.get(entry.path);
      if (!isNotePath(entry.path)) {
        // Listed, never downloaded: named so the offline tree matches.
        index.entries.set(entry.path, {
          ...fieldsOf(entry),
          etag: entry.etag ?? "",
          body: false,
          syncedAt: now,
        });
        continue;
      }
      if (local === undefined || !local.body) {
        remaining += 1;
        continue;
      }
      const atVersion =
        entry.etag === undefined
          ? toFetch.includes(entry.path)
          : (local.rawEtag ?? local.etag) === entry.etag;
      if (!atVersion) {
        remaining += 1;
        continue;
      }
      // Confirmed at this version: the visibility fields can change without
      // the version changing (an edit to `privacy.md`), so they are taken
      // from the listing every time.
      index.entries.set(entry.path, {
        ...local,
        ...fieldsOf(entry),
        ...(entry.size !== undefined ? { size: entry.size } : {}),
        syncedAt: now,
      });
    }

    // An ancestor nobody's work is based on any more has done its job.
    for (const entry of index.entries.values()) {
      if (entry.base !== undefined && !needed(entry.path).has(entry.base)) {
        await store.removeBody(scope, workspaceId, "base", entry.path);
        delete entry.base;
      }
    }

    run.remaining = remaining;
    run.complete = complete && remaining === 0;
    if (!run.complete) run.incomplete = incomplete ?? "read-failed";
    index.lastSyncedAt = now;
    index.complete = run.complete;
    index.remaining = remaining;
    index.manifestUsable = manifestUsable;
    if (run.incomplete === undefined) delete index.incomplete;
    else index.incomplete = run.incomplete;
    return true;
  });
  if (!reconciled || !deps.mine()) return aborted();
  return run;
}

function fieldsOf(
  entry: ManifestEntry,
): Pick<MirrorEntry, "path" | "visibility" | "inherited" | "exception" | "readOnly" | "updatedAt"> {
  return {
    path: entry.path,
    visibility: entry.visibility,
    inherited: entry.inherited,
    exception: entry.exception,
    readOnly: entry.readOnly,
    ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
  };
}

/**
 * Sync every context in the list, one after another.
 *
 * Stops at the first sign of an ended session rather than finishing the
 * others: each would be refused by the store anyway, and every call is a round
 * trip nobody wants any more.
 */
export async function syncAll(
  deps: MirrorSyncDeps,
  targets: readonly { workspaceId: string; tier: VisibilityTier }[],
  onRun?: (run: MirrorRun) => Promise<void> | void,
): Promise<MirrorRun[]> {
  const runs: MirrorRun[] = [];
  for (const target of targets) {
    if (!deps.mine()) break;
    const run = await syncContext(deps, target);
    if (run === null) continue;
    runs.push(run);
    if (run.aborted) break;
    await onRun?.(run);
  }
  return runs;
}
