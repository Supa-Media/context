/**
 * Trashing, restoring and permanently deleting (archiving is `archiving.ts`).
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isEncryptedNote } from "../noteEncryption";
import { canSee, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import {
  eligible as collaborationEligible,
  moveDocument as moveCollaborationDocument,
  supported as collaborationSupported,
  tombstoneDocument as tombstoneCollaborationDocument,
} from "@context/collaboration";
import { LIST_PAGE_CAP, FOLDER_OPERATION_CAP, TRASH_ROOT, type FileStore } from "./store";
import { assertNotProtectedFolder } from "./nameTwins";
import { FileOpError, notFound } from "./errors";
import { requirePath, timestampSlug } from "./paths";
import { dropFolderIcons } from "@context/shared/src/folderIcons.cjs";
import { loadPrivacyState } from "./privacyState";
import { assertWritablePath } from "./writing";
import { keysUnder, namesExtending, historyKeysFor, isFolder } from "./walk";
import { createAbsent, filesInTree } from "./treeChecks";
import { type MoveResult, movePath } from "./moving";
import { forgetPrivacy } from "./privacyRewrite";
import { isKeyedStore, KEYED_REFUSAL } from "../noteIds/keyedStore";

/**
 * A permanent delete in a keyed workspace. It would retire the note's row and
 * key, and that is what emptying the trash may do, not an ordinary delete
 * (`docs/decisions/storage-and-credentials/notes-by-id.md`). Nothing is removed.
 */
const KEYED_PERMANENT_REFUSAL =
  "Permanent delete is not available in a keyed workspace yet. Move it to the trash instead, which keeps it restorable. Nothing was changed.";

/* -------------------------------------------------------------------------- */
/*                            trashing and deleting                           */
/* -------------------------------------------------------------------------- */

/**
 * A trash the tree can draw at once, queued by the credential barrier
 * (`lib/nodes/trashStart.ts`), or `null` to trash it here. Attached to the
 * store non-enumerably, as `queueMove` is; a store without it (tests, the
 * gateway, self-hosting without the tree) trashes the old way.
 */
type QueueTrash = (trash: {
  path: string;
  clearance: Clearance;
  now: number;
  expectedEtag?: string;
}) => Promise<MoveResult | null>;
/**
 * Turn a still-queued trash around: `true` when it was, `false` when the
 * bucket holds the trash, or the store to restore through when the bucket
 * moved while this waited for it.
 */
type RestoreQueued = (restore: { trash: string; path: string }) => Promise<boolean | FileStore>;

/**
 * Move a visible entry into hidden, recoverable trash without rewriting its
 * privacy rules or links. Keeping those rules at the original path makes Undo
 * restore the exact access state instead of guessing it from the trash folder.
 */
export async function trashPath(
  store: FileStore,
  options: {
    path: string;
    clearance: Clearance;
    now: number;
    /**
     * The version this delete was asked about — see `movePath`. A delete typed
     * offline must not put somebody's newer text in the trash without the
     * person who asked for it being told it changed. Compared after the
     * visibility check, so a note the caller cannot see is `notFound()` and its
     * version is never on the wire.
     */
    expectedEtag?: string;
  },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  await assertNotProtectedFolder(store, path, options.clearance, "remove");
  assertWritablePath(path);
  // A delete asked against a version (the offline queue's) checks it here, so only a press made online queues.
  // In a keyed workspace the trash is always a row move (`rowTrash.ts`), an offline delete's version included:
  // the row move checks that version, and a byte trash would move frozen copies and leave the note in place.
  const queue = (store as { queueTrash?: QueueTrash }).queueTrash;
  const keyed = await isKeyedStore(store);
  if ((options.expectedEtag === undefined || keyed) && typeof queue === "function") {
    const queued = await queue({
      path,
      clearance: options.clearance,
      now: options.now,
      ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
    });
    if (queued !== null) return queued;
  }
  if (keyed) throw new FileOpError("KEYED_WORKSPACE", KEYED_REFUSAL);
  const state = await loadPrivacyState(store);
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const sourceIsFolder = await isFolder(store, path);
  if (options.expectedEtag !== undefined && sourceIsFolder) {
    throw new FileOpError("PATH_INVALID", "A folder has no version, so it cannot be deleted against one.");
  }
  const walk = sourceIsFolder
    ? await keysUnder(store, path, options.clearance, state.rules, state.overrides)
    : { keys: [path], withheld: [] };
  const source = sourceIsFolder ? null : await store.get(path);
  if (!sourceIsFolder && source === null) throw notFound();
  if (walk.keys.length === 0) throw notFound();
  /*
    A read-compare, made just before the move, on every bucket. `movePairs` is
    shared with the restore and copies-then-deletes unconditionally; the window
    between this read and that delete is the one an online save on a
    read-compare bucket has, and what lands in it is recoverable from the trash
    rather than gone.
  */
  const sourceText = source === null ? null : await source.text();
  const sourceIsCollaborative =
    !sourceIsFolder && sourceText !== null && collaborationSupported(store) &&
    !isEncryptedNote(sourceText) && collaborationEligible(path, sourceText);
  if (options.expectedEtag !== undefined && source !== null && !sourceIsCollaborative && source.etag !== options.expectedEtag) {
    throw new FileOpError(
      "CONFLICT",
      "That note changed somewhere else after this was asked for.",
      source.etag,
    );
  }

  // A migrated note moves into the real hidden trash path with its head and
  // document identity intact. The lifecycle API admits this path only through
  // its internalTrash capability; public collaboration reads still reject it.
  if (sourceIsCollaborative && source !== null && sourceText !== null) {
      if (store.capabilities?.conditionalDelete !== true) {
        throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely trash a collaboratively edited note.");
      }
      let destination = `${TRASH_ROOT}/${timestampSlug(options.now)}/${path}`;
      for (let attempt = 2; await hiddenKeysAt(store, destination).then((keys) => keys.length > 0) && attempt <= 100; attempt += 1) {
        destination = `${TRASH_ROOT}/${timestampSlug(options.now)}-${attempt}/${path}`;
      }
      let moved;
      try {
        moved = await moveCollaborationDocument(store, path, destination, {
          internalTrash: true,
          ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "CONFLICT" || code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
          throw new FileOpError("CONFLICT", "That note changed somewhere else after this was asked for.", source.etag);
        }
        if (code === "UNSUPPORTED_STORAGE") {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely trash a collaboratively edited note.");
        }
        throw error;
      }
      return { from: path, to: destination, paths: [destination], etag: moved.etag };
    }

  const stamp = timestampSlug(options.now);
  let destination = `${TRASH_ROOT}/${stamp}/${path}`;
  for (let attempt = 2; attempt <= 100; attempt += 1) {
    if ((await hiddenKeysAt(store, destination)).length === 0) break;
    destination = `${TRASH_ROOT}/${stamp}-${attempt}/${path}`;
  }
  const pairs = walk.keys.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${destination}${key.slice(path.length)}` : destination,
  }));
  const collaborativePairs = new Set<string>();
  if (collaborationSupported(store)) {
    const candidates: Array<(typeof pairs)[number]> = [];
    for (const pair of pairs) {
      const object = await store.get(pair.source);
      if (object === null) continue;
      const text = await object.text();
      if (!isEncryptedNote(text) && collaborationEligible(pair.source, text)) candidates.push(pair);
    }
    if (candidates.length > 0 && store.capabilities?.conditionalDelete !== true) {
      throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely trash collaboratively edited notes.");
    }
    for (const pair of candidates) {
      try {
        await moveCollaborationDocument(store, pair.source, pair.destination, { internalTrash: true });
        collaborativePairs.add(pair.source);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (["CONFLICT", "BASE_MISSING", "GENERATION_MISMATCH"].includes(code)) {
          throw new FileOpError("CONFLICT", "A note changed somewhere else while this folder was being trashed.");
        }
        if (code === "UNSUPPORTED_STORAGE") {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely trash collaboratively edited notes.");
        }
        throw error;
      }
    }
  }
  const legacyPairs = pairs.filter((pair) => !collaborativePairs.has(pair.source));
  if (legacyPairs.length > 0) await movePairs(store, legacyPairs);
  return { from: path, to: destination, paths: pairs.map((pair) => pair.destination) };
}

type TrashKeyedRows = (trash: {
  path: string;
  clearance: Clearance;
  now: number;
  expectedEtag?: string;
}) => Promise<MoveResult>;

/**
 * Trash a path in a keyed workspace as its rows (`lib/nodes/rowTrash.ts`), for
 * the operations that would otherwise delete it permanently (`removeNewFolder`,
 * a plugin's delete). The rows move to the trash and Restore brings them back,
 * so nothing is lost. Only the barrier attaches the seam, as the trash's own
 * does; a store without it stays refused.
 */
export async function trashKeyedRows(
  store: FileStore,
  options: { path: string; clearance: Clearance; now: number; expectedEtag?: string },
): Promise<DeleteResult> {
  const trash = (store as { trashKeyedRows?: TrashKeyedRows }).trashKeyedRows;
  if (typeof trash !== "function") throw new FileOpError("KEYED_WORKSPACE", KEYED_REFUSAL);
  const moved = await trash(options);
  return { paths: moved.paths };
}

/** Restore one trash result to the original path encoded inside its key. */
export async function restoreTrashedPath(
  given: FileStore,
  options: { from: string; to: string; clearance: Clearance },
): Promise<MoveResult> {
  let store = given;
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(to);
  const match = /^\.context\/trash\/[^/]+\/(.+)$/.exec(from);
  if (match === null || match[1] !== to) {
    throw new FileOpError("PATH_INVALID", "That trash entry does not match this restore path.");
  }
  const state = await loadPrivacyState(store);
  if (!canSee(to, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
  // Deleted a moment ago, its trash may still be queued: turned around, the tree draws it back at once.
  const restoreQueued = (store as { restoreQueuedTrash?: RestoreQueued }).restoreQueuedTrash;
  const queued = typeof restoreQueued === "function" ? await restoreQueued({ trash: from, path: to }) : false;
  if (queued === true) return { from, to, paths: [to], queued: 1 };
  if (queued !== false) store = queued;
  const sources = await hiddenKeysAt(store, from);
  if (sources.length === 0 && collaborationSupported(store)) {
    throw notFound();
  }
  if (sources.length === 0) throw notFound();
  const sourceIsFolder = sources.length > 1 || sources[0] !== from;
  const pairs = sources.map((source) => ({
    source,
    destination: sourceIsFolder ? `${to}${source.slice(from.length)}` : to,
  }));
  const collaborativePairs = new Set<string>();
  if (collaborationSupported(store)) {
    const candidates: Array<(typeof pairs)[number]> = [];
    for (const pair of pairs) {
      const object = await store.get(pair.source);
      if (object === null) continue;
      const text = await object.text();
      // A trash key is plumbing and is intentionally ineligible at the public
      // engine boundary. The retained document is still the ordinary note at
      // its restore destination; use that path for the eligibility check while
      // passing internalTrash to the lifecycle move below.
      if (!isEncryptedNote(text) && collaborationEligible(pair.destination, text)) candidates.push(pair);
    }
    if (candidates.length > 0 && store.capabilities?.conditionalDelete !== true) {
      throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely restore a collaboratively edited note.");
    }
    for (const pair of candidates) {
      try {
        await moveCollaborationDocument(store, pair.source, pair.destination, { internalTrash: true });
        collaborativePairs.add(pair.source);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (["CONFLICT", "BASE_MISSING", "GENERATION_MISMATCH", "MOVED"].includes(code)) {
          throw new FileOpError("CONFLICT", "That note changed somewhere else while it was in the trash.");
        }
        if (code === "UNSUPPORTED_STORAGE") {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely restore a collaboratively edited note.");
        }
        throw error;
      }
    }
  }
  const legacyPairs = pairs.filter((pair) => !collaborativePairs.has(pair.source));
  if (legacyPairs.length > 0) await movePairs(store, legacyPairs);
  return { from, to, paths: pairs.map((pair) => pair.destination) };
}

async function hiddenKeysAt(store: FileStore, path: string): Promise<string[]> {
  if ((await store.get(path)) !== null) return [path];
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
    const listing = await store.list({ prefix: `${path}/`, cursor, limit: 1_000 });
    for (const object of listing.objects) {
      keys.push(object.key);
      if (keys.length > FOLDER_OPERATION_CAP) {
        throw new FileOpError("FOLDER_TOO_LARGE", "That trash entry is too large to restore in one go.");
      }
    }
    if (!listing.truncated) return keys;
    if (!listing.cursor || listing.cursor === cursor) {
      throw new FileOpError("LISTING_INCOMPLETE", "Context could not finish reading that trash entry.");
    }
    cursor = listing.cursor;
  }
  throw new FileOpError("FOLDER_TOO_LARGE", "That trash entry is too large to restore in one go.");
}

async function movePairs(
  store: FileStore,
  pairs: readonly { source: string; destination: string }[],
): Promise<void> {
  // A restore's destination is a name in the tree; a trash entry is plumbing
  // the tree never holds, so the sources are the bucket's (`hiddenKeysAt`).
  // Restored names are asked of the tree, and written only if still absent
  // where the store can hold that (`treeChecks.ts`).
  const restoring = pairs.filter((pair) => !isPlumbing(pair.destination));
  const taken = await filesInTree(store, restoring.map((pair) => pair.destination));
  for (const pair of pairs) {
    if (taken.has(pair.destination) || (isPlumbing(pair.destination) && (await store.get(pair.destination)) !== null)) {
      throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${pair.destination}.`);
    }
  }
  for (const pair of pairs) {
    const object = await store.get(pair.source);
    if (object === null) throw notFound();
    await createAbsent(store, pair.destination, await object.arrayBuffer());
    await store.delete(pair.source);
  }
}

/** The word a caller must send to delete something permanently. */
export const DELETE_CONFIRMATION = "permanently delete";

export interface DeleteResult {
  paths: string[];
}

/**
 * Delete permanently.
 *
 * No `.history/` copy is written **and every existing one is purged**, which is
 * the point: if this left a recoverable copy behind, the console would be
 * telling people their file is gone forever while quietly keeping it, and
 * "permanently delete" would be a lie in a UI whose whole job is to be
 * trustworthy about where their data is. Archive is the recoverable one.
 *
 * Writing no new snapshot was never enough on its own, and for a while this
 * function thought it was. Saves used to leave the replaced version in
 * `.history/`, so any note that had ever been edited kept its content in the
 * bucket after being "permanently" deleted — invisible, because `isPlumbing`
 * hides it from the file tree and from every gateway tool, and unreachable,
 * because `canSee` refuses plumbing at every scope. A copy nobody can read is
 * still a copy: it is in the customer's bucket, it is in their storage bill,
 * and it is in the export their provider hands to whoever subpoenas it.
 *
 * **Nothing writes those snapshots now**, and the purge still runs, because the
 * argument above is about buckets rather than about code: every context
 * connected before the change is still full of them, and this is the only thing
 * that removes them. Delete the purge when no such bucket can exist, which is
 * not a date anyone can name.
 *
 * **What this function cannot reach is now the more important half.** Version
 * history is the customer's own object versioning, at their provider, and this
 * product actively tells them to turn it on. Where they did, the noncurrent
 * version survives this delete: we hold no `DeleteObjectVersion` capability we
 * can rely on across R2, S3, B2 and Wasabi, and on several of them we
 * would need permissions the binding does not ask for. That is not a gap to
 * paper over — it is the customer's copy, in the customer's bucket, under the
 * customer's control, which is the arrangement this product is for. It does
 * mean the console must not promise erasure it cannot perform: see
 * `describeDeleteForever` in apps/mobile/features/console/files/paths.ts, which
 * names the condition instead.
 *
 * `confirmation` must be the literal `DELETE_CONFIRMATION`. A boolean flag
 * would be satisfied by any truthy value a buggy caller passed; a specific
 * string cannot be arrived at by accident.
 */
export async function deletePath(
  store: FileStore,
  options: { path: string; confirmation: string; clearance: Clearance; expectedEtag?: string },
): Promise<DeleteResult> {
  if (options.confirmation !== DELETE_CONFIRMATION) {
    throw new FileOpError(
      "CONFIRMATION_REQUIRED",
      "Permanent deletion has to be confirmed explicitly. This cannot be undone — archive it instead if you might want it back.",
    );
  }
  const path = requirePath(options.path);
  // Refused before anything is read or removed: a keyed row and its key are retired only by emptying the trash.
  if (await isKeyedStore(store)) throw new FileOpError("KEYED_WORKSPACE", KEYED_PERMANENT_REFUSAL);
  await assertNotProtectedFolder(store, path, options.clearance, "remove");
  assertWritablePath(path);

  const state = await loadPrivacyState(store);
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const targetIsFolder = await isFolder(store, path);
  if (options.expectedEtag !== undefined && targetIsFolder) {
    throw new FileOpError("PATH_INVALID", "Plugins may only delete files, not folders.");
  }
  if (options.expectedEtag !== undefined && store.capabilities?.conditionalDelete !== true) {
    throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely delete plugin files.");
  }
  const walk = targetIsFolder
    ? await keysUnder(store, path, options.clearance, state.rules, state.overrides)
    : { keys: [path], withheld: await namesExtending(store, path) };
  const keys = walk.keys;
  if (!targetIsFolder && (await store.get(path)) === null) throw notFound();
  // A folder holding nothing this caller can see is not a folder they can
  // empty. Answering `notFound()` is byte-identical to a folder that was never
  // there, where reporting "deleted 0 files" would say one is present.
  if (targetIsFolder && keys.length === 0) throw notFound();

  // Tombstone migrated plaintext notes before the legacy delete loop. This
  // retains their CRDT history for lifecycle accounting and prevents a stale
  // collaboration head from resurrecting the materialized Markdown later.
  const collaborationDeleted = new Set<string>();
  if (collaborationSupported(store)) {
    const candidates: string[] = [];
    for (const key of keys) {
      const object = await store.get(key);
      if (object === null) continue;
      const text = await object.text();
      if (!isEncryptedNote(text) && collaborationEligible(key, text)) candidates.push(key);
    }
    if (candidates.length > 0 && store.capabilities?.conditionalDelete !== true) {
      throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely delete a collaboratively edited note.");
    }
    for (const key of candidates) {
      try {
        await tombstoneCollaborationDocument(store, key, {
          ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
          permanent: true,
        });
        collaborationDeleted.add(key);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "CONFLICT" || code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
          throw new FileOpError("CONFLICT", "That file changed somewhere else while you were editing it.");
        }
        if (code === "UNSUPPORTED_STORAGE") {
          throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely delete a collaboratively edited note.");
        }
        throw error;
      }
    }
  }

  for (const key of keys) {
    if (collaborationDeleted.has(key)) continue;
    const removed = options.expectedEtag === undefined
      ? await store.delete(key)
      : await store.delete(key, { onlyIf: { etagMatches: options.expectedEtag } });
    if (removed === null) {
      const current = await store.get(key);
      throw new FileOpError("CONFLICT", "That file changed somewhere else while the plugin was using it.", current?.etag);
    }
  }

  // The half that used to be missing. Deleting a folder purges its history
  // subtree in one go; deleting a file purges the snapshots that share its
  // name. Done after the live keys so a failure mid-purge leaves the bucket in
  // the state the *old* behaviour left it in — file gone, history behind —
  // rather than history gone and the file still sitting there.
  for (const key of await historyKeysFor(
    store,
    path,
    targetIsFolder,
    // `null` sweeps the whole subtree, orphans included, and that is a FOLDER
    // idea: everything under it is going, so a snapshot matched by nobody is
    // still this folder's. A single file has no subtree, and its neighbours'
    // names can extend its own, so it always names what it deleted and lets
    // longest match decide — otherwise an owner deleting `a.md` takes the
    // history of `a.md.notes.md`, which they never asked to delete.
    targetIsFolder && options.clearance.scope === "private" ? null : keys,
    walk.withheld,
  )) {
    await store.delete(key);
  }

  await forgetPrivacy(store, keys, targetIsFolder ? path : null, walk.withheld);
  // A folder that is really gone takes its icon with it; one still holding
  // notes this caller could not see is still there, icon and all. A note
  // deleted for good takes its own.
  if (!targetIsFolder || walk.withheld.length === 0) await dropFolderIcons(store, path);

  // `paths` stays the live keys. It is what the console echoes and what the
  // audit log records as "what you deleted"; the history that came with them is
  // plumbing, and listing it would be the first time we ever showed a customer
  // a `.history/` key.
  return { paths: keys };
}
