/**
 * Archiving, trashing, restoring and permanently deleting.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isEncryptedNote } from "../noteEncryption";
import { canSee, visibilityOf, archiveRoot, archiveRoots, insideArchive } from "../privacy";
import { type Clearance } from "../clearance";
import {
  eligible as collaborationEligible,
  moveDocument as moveCollaborationDocument,
  supported as collaborationSupported,
  tombstoneDocument as tombstoneCollaborationDocument,
} from "@context/collaboration";
import { LIST_PAGE_CAP, FOLDER_OPERATION_CAP, TRASH_ROOT, type FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath, timestampSlug } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { assertWritablePath } from "./writing";
import { keysUnder, namesExtending, historyKeysFor, isFolder } from "./walk";
import { type MoveResult, movePath } from "./moving";
import { forgetPrivacy } from "./privacyRewrite";

/* -------------------------------------------------------------------------- */
/*                            archiving and deleting                          */
/* -------------------------------------------------------------------------- */

/**
 * Archive: move into `<this context's archive>/<timestamp>/<original path>`.
 *
 * This is the destructive-looking action people should reach for, and it is
 * **not destructive** — the file is intact, its original path is preserved
 * inside the archive path, and moving it back restores it exactly. The
 * timestamp segment means archiving the same note twice never collides.
 *
 * Same destination shape the gateway's `archive_note` uses, **and now the same
 * destination**, which it was not. Both were written against a literal
 * `4-archive`; the gateway refused a context that did not declare one, and
 * this created it regardless. So on a `company`-preset workspace — a layout
 * whose archive is `5-archive`, and the default for a shared context — Claude
 * refused to archive and the console quietly opened a second archive beside
 * the real one, in a bucket the owner also sees in Obsidian. One resolver
 * (`archiveRoot`) now answers for both, and this path adopts the gateway's
 * refusal rather than its own invention: a context with no archive folder is
 * told so, instead of being given one nobody chose.
 */
export async function archivePath(
  store: FileStore,
  options: {
    path: string;
    clearance: Clearance;
    now: number;
    /** The version this archive was asked about. See `movePath`. */
    expectedEtag?: string;
  },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  // Ahead of the destination rather than after it: which folder this context
  // archives into is a fact about its manifest, so the manifest is read first
  // and the same state answers the visibility check below.
  const state = await loadPrivacyState(store);
  const roots = archiveRoots(state.rules);
  const archive = archiveRoot(state.rules);
  // Every archive it has, not the one we would write to: a note already in
  // `5-archive/` must not be moved into `4-archive/` because the resolver
  // preferred the latter.
  if (insideArchive(path, roots)) {
    throw new FileOpError("PATH_INVALID", "That is already in the archive.");
  }
  if (archive === null) {
    throw new FileOpError(
      "ARCHIVE_UNAVAILABLE",
      "This context has no archive folder, and archiving will not create one — its layout is yours. Move this to wherever you keep inactive material, or add an archive folder to privacy.md.",
    );
  }
  // A free destination, because `movePath` refuses to merge onto an existing
  // folder and archiving a child and then its parent inside the same
  // millisecond lands the second one on top of the first. The stamp is
  // server-generated and never caller-chosen, so disambiguating it discloses
  // nothing and keeps "never merges" true rather than carving an exception into
  // it. Archiving twice in one millisecond is a scripted or concurrent caller,
  // not a person clicking twice.
  const stamp = timestampSlug(options.now);
  let destination = `${archive}/${stamp}/${path}`;
  for (let attempt = 2; attempt <= 100; attempt += 1) {
    if (!(await isFolder(store, destination)) && (await store.get(destination)) === null) break;
    destination = `${archive}/${stamp}-${attempt}/${path}`;
  }

  // Archiving is a move, so it inherits the destination rule — and on the
  // scaffold's defaults the archive is private, which means a team caller
  // cannot archive. That is right: archiving a shared note into a private
  // archive takes it away from everybody else, irreversibly for the person who
  // did it. The gateway's `archive_note` has always refused it.
  //
  // What it must not do is inherit the *message*. "That file does not exist"
  // about a note the caller is looking at explains nothing and points at the
  // wrong thing. Naming the folder discloses nothing they do not already hold:
  // whether it is shared is visible in their own root listing.
  if (options.clearance.scope !== "private" && visibilityOf(destination, state.rules) !== "team") {
    throw new FileOpError(
      "ARCHIVE_UNAVAILABLE",
      `Archiving needs access to ${archive}, which has not been shared with you. Ask the owner to share it, or move this somewhere you can both see.`,
    );
  }

  return await movePath(store, {
    from: path,
    to: destination,
    clearance: options.clearance,
    now: options.now,
    ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
  });
}

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
  assertWritablePath(path);
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

/** Restore one trash result to the original path encoded inside its key. */
export async function restoreTrashedPath(
  store: FileStore,
  options: { from: string; to: string; clearance: Clearance },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(to);
  const match = /^\.context\/trash\/[^/]+\/(.+)$/.exec(from);
  if (match === null || match[1] !== to) {
    throw new FileOpError("PATH_INVALID", "That trash entry does not match this restore path.");
  }
  const state = await loadPrivacyState(store);
  if (!canSee(to, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
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
  for (const pair of pairs) {
    if ((await store.get(pair.destination)) !== null) {
      throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${pair.destination}.`);
    }
  }
  for (const pair of pairs) {
    const object = await store.get(pair.source);
    if (object === null) throw notFound();
    await store.put(pair.destination, await object.arrayBuffer());
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
 * can rely on across R2, S3, B2, Wasabi and Dropbox, and on several of them we
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

  // `paths` stays the live keys. It is what the console echoes and what the
  // audit log records as "what you deleted"; the history that came with them is
  // plumbing, and listing it would be the first time we ever showed a customer
  // a `.history/` key.
  return { paths: keys };
}
