import { isNotePath, putMirroredNotes, readIndex, type MirrorIndex } from "./mirror";
import { commitListing, listContext, MIRROR_BATCH, type ManifestEntry, type MirrorSyncDeps } from "./mirrorSync";
import type { OpenNote } from "../console/files/types";
import type { VisibilityTier } from "../console/visibility";

/**
 * Bring one folder's notes up to date on this device now, ahead of the
 * whole-context pass.
 *
 * A project List or Board is drawn from this device's copy (`mirrorLists.ts`),
 * and a note whose body has not been downloaded — or whose copy is an older
 * version — has no status there. The whole-context pass (`mirrorSync.ts`)
 * fetches in listing order, every context one after another, and a phone gets
 * it in pieces: a few minutes in the foreground, a timeout on a slow network,
 * two hundred saved sessions under `0-inbox/` that sort ahead of
 * `1-projects/`. So the page somebody is looking at could stay days behind
 * the web while the pass never reached it: the same `1-projects` read "In
 * progress 2" on a phone and "In progress 9" on the web, every reshaped
 * project filed under "Notes · no status" with "Make it a project" beside it.
 *
 * This walks the manifest (the same walk the console's refresh does, so the
 * tree is current too) and reads only what the open folder needs: every note
 * under it, and the notes directly inside each folder above it, which is where
 * an inherited status list is declared (`folderPage/statuses.ts`). Fetched
 * when missing or at another version — the pass's own rule. At most
 * `FOLDER_FRESHEN_LIMIT` notes, so opening a huge folder is a bounded cost.
 *
 * The listing is committed exactly as `refreshMetadata` commits it; beyond
 * that this only ever *adds* current copies, and the index's own sync status
 * (last synced, complete, remaining) is left for the pass that owns it.
 */

export const FOLDER_FRESHEN_LIMIT = 500;

/** Direct children of `folder`'s ancestors, and everything under `folder`. */
function wanted(path: string, folder: string): boolean {
  if (folder === "" || path.startsWith(`${folder}/`)) return true;
  const at = path.lastIndexOf("/");
  const parent = at < 0 ? "" : path.slice(0, at);
  return parent === "" || folder.startsWith(`${parent}/`);
}

/** The notes `folder` needs that this device holds no current copy of, in listing order. */
export function stalePathsFor(
  listed: ReadonlyMap<string, ManifestEntry>,
  index: MirrorIndex | null,
  folder: string,
): string[] {
  const paths: string[] = [];
  for (const entry of listed.values()) {
    if (!isNotePath(entry.path) || !wanted(entry.path, folder)) continue;
    const local = index?.entries.get(entry.path);
    if (
      local === undefined ||
      !local.body ||
      entry.etag === undefined ||
      (local.rawEtag ?? local.etag) !== entry.etag
    ) {
      paths.push(entry.path);
    }
  }
  return paths;
}

/** How many notes it put on the device. Never throws. */
export async function freshenFolder(
  deps: MirrorSyncDeps,
  target: { workspaceId: string; tier: VisibilityTier },
  folder: string,
): Promise<number> {
  const listing = await listContext(deps, target).catch(() => null);
  if (listing === null || listing === "aborted" || listing.pagesListed === 0) return 0;
  const { store, epoch } = deps;
  const { workspaceId, scope, listed } = listing;
  const committed = await commitListing(deps, listing).catch(() => null);
  if (!deps.mine()) return 0;
  if (committed !== null) deps.onListed?.(workspaceId);

  const index = await readIndex(store, scope, workspaceId).catch(() => null);
  const queue = stalePathsFor(listed, index, folder).slice(0, FOLDER_FRESHEN_LIMIT);
  let fetched = 0;
  while (queue.length > 0) {
    const batch = queue.splice(0, MIRROR_BATCH);
    let results;
    try {
      results = await deps.readNotes(workspaceId, batch);
    } catch {
      break; // Offline or timed out: the pass will get there.
    }
    if (!deps.mine()) return fetched;
    const read: (OpenNote & { updatedAt?: number })[] = [];
    const deferred: string[] = [];
    for (const result of results) {
      if (!batch.includes(result.path)) continue; // an answer to a question not asked
      if (result.outcome === "read") {
        const updatedAt = listed.get(result.path)?.updatedAt;
        read.push({ ...result.note, ...(updatedAt !== undefined ? { updatedAt } : {}) });
      } else if (result.outcome === "deferred") {
        deferred.push(result.path);
      }
    }
    // Deferred by the server's byte budget: asked again, unless nothing was read at all.
    if (read.length === 0) {
      if (deferred.length === batch.length) break;
      continue;
    }
    queue.unshift(...deferred);
    const needed = await deps.needed(workspaceId);
    if (!deps.mine()) return fetched;
    const kept = await putMirroredNotes(store, epoch, scope, workspaceId, read, needed, deps.now()).catch(() => false);
    if (!kept) return fetched;
    fetched += read.length;
    deps.onFetched?.(workspaceId);
  }
  return fetched;
}
