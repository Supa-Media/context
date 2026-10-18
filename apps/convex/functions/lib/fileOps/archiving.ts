/**
 * Archiving: the destructive-looking action people should reach for, which is
 * not destructive. The note or folder moves, intact, into the folder doing
 * the Archive's job, and moving it back restores it.
 *
 * Split out of `lib/fileOps/deleting.ts`; `lib/fileOps.ts` re-exports it, and
 * that file's header holds the rules every operation keeps.
 *
 * **Archive keeps the workspace's shape** (owner, 2026-10-18;
 * `archiveMirror.cjs`, `docs/decisions/app-and-console/folder-jobs.md`):
 * `Projects/launch` lands at `Archive/Projects/launch`, beside every other
 * project archived before it. It used to land under a folder named for the
 * millisecond (`Archive/2026-10-15T22-16-49-545Z/...`), so finding every
 * archived project meant opening each date. A name already in Archive is
 * merged into, and a note whose name is taken arrives numbered,
 * `notes (2).md`; nothing is overwritten (`mergeInto`).
 *
 * Same destination as the gateway's `archive_note`: one resolver for the
 * folder (the one doing the Archive's job, `treeJobs`, else the rules'
 * `archiveRoot`) and one for the path (`archiveDestination`), so Claude and the
 * console never file the same note in two places. A context with no archive
 * folder is told so rather than given one nobody chose.
 */

import { archiveDestination, isArchiveStamp, mergeInto } from "@context/shared/src/archiveMirror.cjs";
import { type FolderJobs, jobPath } from "@context/shared/src/folderRoles.cjs";
import { visibilityOf, archiveRoot, archiveRoots, insideArchive } from "../privacy";
import { type Clearance } from "../clearance";
import { type FileStore } from "./store";
import { assertNotProtectedFolder } from "./nameTwins";
import { fileInTree, treeJobs } from "./treeChecks";
import { FileOpError } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { isFolder, namesListing } from "./walk";
import { type MoveResult, movePath } from "./moving";

/** Pages of a folder's direct children read for a merge: far past any real folder, a bound on a loop. */
const CHILD_PAGES = 50;

/** The names directly in `folder`, as the tree lists them (`namesListing`). */
async function childNames(store: FileStore, folder: string): Promise<string[]> {
  const names = new Set<string>();
  const prefix = `${folder}/`;
  let cursor: string | undefined;
  for (let page = 0; page < CHILD_PAGES; page += 1) {
    const listing = await namesListing(store).list({ prefix, delimiter: "/", cursor, limit: 1_000 });
    for (const object of listing.objects ?? []) {
      const name = object.key.slice(prefix.length);
      if (name !== "" && !name.includes("/")) names.add(name);
    }
    for (const raw of listing.delimitedPrefixes ?? []) {
      const name = raw.slice(prefix.length).replace(/\/$/, "");
      if (name !== "" && !name.includes("/")) names.add(name);
    }
    if (!listing.truncated || !listing.cursor || listing.cursor === cursor) break;
    cursor = listing.cursor;
  }
  return [...names].sort();
}

async function kindAt(store: FileStore, path: string): Promise<"file" | "folder" | null> {
  if (await isFolder(store, path)) return "folder";
  return (await fileInTree(store, path)) ? "file" : null;
}

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
  await assertNotProtectedFolder(store, path, options.clearance, "remove");
  // Ahead of the destination rather than after it: which folder this context
  // archives into is a fact about its manifest, so the manifest is read first
  // and the same state answers the visibility check below.
  const state = await loadPrivacyState(store);
  // The folder doing the Archive's job wins, whatever it is called now (`folderJobs.ts`); the rules' archive
  // names are still the archives a note may already be in.
  const archiveJob = (await treeJobs(store))?.jobs.archive ?? null;
  const roots = [...new Set([...(archiveJob === null ? [] : [archiveJob]), ...archiveRoots(state.rules)])];
  const archive = archiveJob ?? archiveRoot(state.rules);
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
  const destination = archiveDestination(archive, path);

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

  const results: MoveResult[] = [];
  const moved = await mergeInto(path, destination, {
    kindAt: async (at) => await kindAt(store, at),
    children: async (folder) => await childNames(store, folder),
    move: async (from, to) => {
      results.push(
        await movePath(store, {
          from,
          to,
          clearance: options.clearance,
          now: options.now,
          // The version names the note asked about, which moves whole or not at all.
          ...(options.expectedEtag === undefined || from !== path ? {} : { expectedEtag: options.expectedEtag }),
        }),
      );
    },
  });
  if (results.length === 1) return results[0]!;
  // A merge: several moves, answered as one archive of `path` into `destination`.
  return {
    from: path,
    to: moved.length === 1 ? moved[0]!.to : destination,
    paths: results.flatMap((result) => result.paths),
    ...(results.some((result) => result.rowed) ? { rowed: true as const } : {}),
    ...(results.some((result) => result.queued !== undefined)
      ? { queued: results.reduce((sum, result) => sum + (result.queued ?? 0), 0) }
      : {}),
    moved: results.flatMap((result) => result.moved ?? []),
  };
}

/** Moves one tidy pass makes before it stops, so a pass is bounded; the next pass carries on. */
export const TIDY_MOVES = 200;

export interface ArchiveTidy {
  /** The folder doing the Archive's job, or null when there is none to tidy. */
  archive: string | null;
  /** The moves made, each at its old and new path (a whole folder is one). */
  moved: { from: string; to: string }[];
  /** Whether date folders are still left, for another pass. */
  left: boolean;
}

/**
 * The one-time tidy (board 10, owner 2026-10-18): each date folder archiving
 * used to make (`<archive>/2026-10-15T22-16-49-545Z/...`) is emptied into the
 * matching place in Archive, as it would be archived now. A name a date
 * folder holds under a built-in folder's old name (`1-projects`) goes to that
 * folder's twin wherever the folder is now (`jobPath`). A name already there
 * is merged into, a taken note numbered (`mergeInto`); the emptied date
 * folders go as any emptied folder does. Made as the owner, as the
 * workspace's own housekeeping. The oldest date folder a pass, at most
 * `limit` moves; `left` says another pass is owed.
 */
export async function tidyArchive(
  store: FileStore,
  options: { clearance: Clearance; now: number; limit?: number },
): Promise<ArchiveTidy> {
  const limit = options.limit ?? TIDY_MOVES;
  const tree = await treeJobs(store);
  const archive = tree?.jobs.archive ?? null;
  if (tree === null || archive === null) return { archive: null, moved: [], left: false };
  const jobs = { jobs: tree.jobs, roots: tree.roots } as FolderJobs;
  const moved: { from: string; to: string }[] = [];
  const ops = {
    kindAt: async (at: string) => await kindAt(store, at),
    children: async (folder: string) => await childNames(store, folder),
    move: async (from: string, to: string) => {
      if (moved.length >= limit) throw new TidyPaused();
      await movePath(store, { from, to, clearance: options.clearance, now: options.now });
      moved.push({ from, to });
    },
  };
  // One date folder a pass: its names are distinct, so no two of its moves aim at one place, and the next
  // pass reads the tree after this one's moves have landed in it (a move made the old way is drawn when its
  // operation answers).
  const stamps = (await childNames(store, archive)).filter(isArchiveStamp);
  const stamp = stamps[0];
  if (stamp === undefined) return { archive, moved, left: false };
  try {
    for (const name of await childNames(store, `${archive}/${stamp}`)) {
      await mergeInto(`${archive}/${stamp}/${name}`, archiveDestination(archive, jobPath(jobs, name)), ops);
    }
  } catch (error) {
    if (!(error instanceof TidyPaused)) throw error;
    return { archive, moved, left: true };
  }
  return { archive, moved, left: stamps.length > 1 };
}

class TidyPaused extends Error {}
