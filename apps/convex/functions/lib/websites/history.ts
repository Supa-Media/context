/**
 * A site's last five published versions, kept so an agent can roll back.
 *
 * _Decided by the owner, 2026-10-03_ ("Keep last 5"): every Publish already
 * copies each page it releases into the customer's `.context/`. Those copies
 * are now kept for five publishes rather than one, and this table says which
 * pages each kept version holds, by path and copy id, never by its words.
 *
 * What may outlive a page and what may not:
 *
 *  - A page that was **deleted or moved** keeps its copies until its versions
 *    age out. It was public when it was published, and bringing it back is
 *    the point of rolling back.
 *  - A page that was **drafted or made members-only** is still in the folder,
 *    so it is still in every snapshot and its copies stay.
 *  - A page that `privacy.md` **holds back**, or that is **encrypted**, loses
 *    its copies from every kept version at once. Both are absent from the
 *    publication snapshot while still in the bucket, which is how they are
 *    told apart from a deleted page: the wipe reads the path at private scope,
 *    and anything that is there, or cannot be read for certain, is wiped.
 *
 * Every scan looks at every kept page its snapshot lacks, not only the ones it
 * narrowed itself, so a wipe that failed (the bucket refused a delete) is
 * caught by the next scan instead of lingering until it ages out.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../../../_generated/server";
import { READ_BATCH } from "./releases";

export const KEPT_VERSIONS = 5;

/** Kept pages a snapshot lacks, by the version that holds them. */
export type AbsentCopies = Array<{
  releaseId: string;
  pages: Array<{ path: string; pageId: string }>;
}>;

/** Newest first. */
export async function keptVersions(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Array<Doc<"websiteReleaseHistory">>> {
  const rows = await ctx.db
    .query("websiteReleaseHistory")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return rows.sort((a, b) => b.revision - a.revision || b.publishedAt - a.publishedAt);
}

/**
 * A site published before versions were kept has a release and no row for
 * it. Its route index still names every copy that release holds, so it is
 * adopted as it stands; call before the index is replaced or narrowed.
 */
export async function adoptPublishedRelease(
  ctx: MutationCtx,
  state: Doc<"websiteStates">,
  existing: ReadonlyArray<Doc<"websiteRouteIndex">>,
): Promise<void> {
  const releaseId = state.publishedReleaseId;
  if (releaseId === undefined) return;
  const kept = await keptVersions(ctx, state.workspaceId);
  if (kept.some((row) => row.releaseId === releaseId)) return;
  await ctx.db.insert("websiteReleaseHistory", {
    workspaceId: state.workspaceId,
    releaseId,
    revision: state.siteRevision ?? 0,
    publishedAt: state.publishedAt ?? state.updatedAt,
    pages: existing.flatMap((row) =>
      row.releaseId === releaseId && row.releasePageId !== undefined
        ? [{ path: row.objectKey, pageId: row.releasePageId }]
        : [],
    ),
  });
}

/**
 * Keep a Publish's release, and let every version past the fifth go.
 * Returns the releases whose copies are to be deleted: the ones let go, and a
 * grace release from before versions were kept, which has no page list.
 */
export async function keepPublishedRelease(
  ctx: MutationCtx,
  state: Doc<"websiteStates">,
  release: {
    releaseId: string;
    revision: number;
    publishedAt: number;
    pages: Array<{ path: string; pageId: string }>;
  },
): Promise<string[]> {
  await ctx.db.insert("websiteReleaseHistory", { workspaceId: state.workspaceId, ...release });
  const kept = await keptVersions(ctx, state.workspaceId);
  const dropped = kept.slice(KEPT_VERSIONS);
  for (const row of dropped) await ctx.db.delete(row._id);
  const ids = dropped.map((row) => row.releaseId);
  const grace = state.previousReleaseId;
  if (grace !== undefined && !kept.some((row) => row.releaseId === grace)) ids.push(grace);
  return ids;
}

/** Every kept page whose path `snapshot` (a scan's object keys) does not hold. */
export async function absentCopies(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  snapshot: ReadonlySet<string>,
): Promise<AbsentCopies> {
  return (await keptVersions(ctx, workspaceId)).flatMap((row) => {
    const pages = row.pages.filter((page) => !snapshot.has(page.path));
    return pages.length === 0 ? [] : [{ releaseId: row.releaseId, pages }];
  });
}

/** Take paths out of the versions that held them, once their copies are gone. */
export async function forgetKeptPagesHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; releaseId: string; paths: string[] },
): Promise<null> {
  const gone = new Set(args.paths);
  for (const row of await keptVersions(ctx, args.workspaceId)) {
    if (row.releaseId !== args.releaseId) continue;
    await ctx.db.patch(row._id, { pages: row.pages.filter((page) => !gone.has(page.path)) });
  }
  return null;
}

/**
 * The paths among `paths` that are still in the bucket, read at private
 * scope. A path the bucket could not answer for is counted as still there:
 * wiping a deleted page's copies costs a rollback, keeping a held-back one's
 * costs the promise.
 */
async function stillInBucket(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  paths: string[],
): Promise<Set<string>> {
  const present = new Set<string>();
  for (let offset = 0; offset < paths.length; offset += READ_BATCH) {
    let pending = paths.slice(offset, offset + READ_BATCH);
    for (let round = 0; pending.length > 0 && round < 5; round += 1) {
      const batch = await ctx
        .runAction(internal.functions.files.runFileOperation, {
          workspaceId,
          scope: "private",
          grantedNames: [],
          operation: { kind: "readMany", paths: pending },
        })
        .catch(() => null);
      if (batch === null || batch.kind !== "notes") break;
      const deferred: string[] = [];
      for (const result of batch.results) {
        if (result.outcome === "deferred") deferred.push(result.path);
        else if (result.outcome === "read" || result.code !== "FILE_NOT_FOUND") present.add(result.path);
      }
      pending = deferred;
    }
    for (const path of pending) present.add(path);
  }
  return present;
}

/**
 * Delete the copies of every absent page that is still in the bucket (held
 * back or encrypted) from every kept version, then forget them. A version
 * whose delete fails keeps its row entries, so the next scan tries again.
 */
export async function wipeWithheldCopies(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  absent: AbsentCopies,
): Promise<void> {
  if (absent.length === 0) return;
  const paths = [...new Set(absent.flatMap((version) => version.pages.map((page) => page.path)))];
  const withheld = await stillInBucket(ctx, workspaceId, paths);
  if (withheld.size === 0) return;
  for (const version of absent) {
    const pages = version.pages.filter((page) => withheld.has(page.path));
    if (pages.length === 0) continue;
    let deleted = true;
    for (let offset = 0; offset < pages.length; offset += READ_BATCH) {
      deleted = await ctx
        .runAction(internal.functions.files.runFileOperation, {
          workspaceId,
          scope: "private",
          grantedNames: [],
          operation: {
            kind: "deleteWebsiteRelease",
            releaseId: version.releaseId,
            pageIds: pages.slice(offset, offset + READ_BATCH).map((page) => page.pageId),
          },
        })
        .then(() => deleted, () => false);
    }
    if (!deleted) continue;
    await ctx.runMutation(internal.functions.websites.forgetKeptPages, {
      workspaceId,
      releaseId: version.releaseId,
      paths: pages.map((page) => page.path),
    });
  }
}

/** The kept versions an agent may roll back to, and which one is live. */
export async function keptVersionsHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<{
  publishedReleaseId: string | null;
  versions: Array<{ releaseId: string; revision: number; publishedAt: number; pages: Array<{ path: string; pageId: string }> }>;
}> {
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  return {
    publishedReleaseId: state?.publishedReleaseId ?? null,
    versions: (await keptVersions(ctx, args.workspaceId)).map((row) => ({
      releaseId: row.releaseId,
      revision: row.revision,
      publishedAt: row.publishedAt,
      pages: row.pages,
    })),
  };
}
