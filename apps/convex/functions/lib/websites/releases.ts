/**
 * Website releases: staging page copies, committing a publication snapshot,
 * and deleting copies that must not outlive their pages.
 *
 * Split out of `routes.ts`, which owns scanning and the route-index fence.
 * Every bucket touch here goes through the one credential barrier.
 */

import type { WebsiteRouteStatus } from "@context/shared";
import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";

export const READ_BATCH = 50;

export type IndexedRoute = WebsiteRouteStatus & {
  sourceEtag: string;
  releaseId?: string;
  releasePageId?: string;
};

export function scanError(
  message: string,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "WEBSITE_SCAN_INCOMPLETE", message });
}

async function deleteReleaseObjects(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  releaseId: string,
  pageIds?: string[],
): Promise<void> {
  if (pageIds !== undefined && pageIds.length === 0) return;
  for (
    let offset = 0;
    offset < (pageIds?.length ?? 1);
    offset += READ_BATCH
  ) {
    await ctx
      .runAction(internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private",
        grantedNames: [],
        operation: {
          kind: "deleteWebsiteRelease",
          releaseId,
          ...(pageIds === undefined
            ? {}
            : { pageIds: pageIds.slice(offset, offset + READ_BATCH) }),
        },
      })
      .catch(() => {});
  }
}

/**
 * Commit a publication snapshot.
 *
 * `publish` is someone pressing Publish (or the site's first scan): a clean
 * snapshot becomes the new release. Every other scan, and a publish that met
 * a broken page, applies only the narrowing half: pages deleted, drafted,
 * made members-only, encrypted or held back leave the site now, and nothing
 * new reaches it until the next Publish.
 */
export async function commitPublicationSnapshot(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  generation: number,
  snapshot: { statuses: WebsiteRouteStatus[]; indexed: IndexedRoute[]; restricted: string[] },
  enabledOnly: boolean,
  publish: boolean,
): Promise<boolean> {
  const clean = !snapshot.statuses.some((status) => status.status === "problem");
  if (clean && publish) {
    return await finishWebsiteRelease(
      ctx,
      workspaceId,
      generation,
      snapshot.indexed,
      snapshot.restricted,
      enabledOnly,
    );
  }
  if (publish) {
    // A half-written frontmatter block, a temporary empty document, or a
    // route clash is not a release. A site that has never had one records
    // its rows without page bytes, so a clash still fails closed.
    const first = await ctx.runMutation(
      internal.functions.websites.commitRouteReconciliation,
      {
        workspaceId,
        generation,
        routes: snapshot.indexed,
        problemsOnlyIfUnpublished: true,
        ...(enabledOnly ? { enabledOnly: true } : {}),
      },
    );
    if (first.committed) return false;
  }
  const narrowed = await ctx.runMutation(
    internal.functions.websites.narrowRouteIndex,
    {
      workspaceId,
      generation,
      routes: snapshot.indexed,
      restricted: snapshot.restricted,
      ...(enabledOnly ? { enabledOnly: true } : {}),
    },
  );
  if (narrowed.releaseId !== null) {
    await deleteReleaseObjects(ctx, workspaceId, narrowed.releaseId, narrowed.pageIds);
  }
  if (narrowed.previousReleaseId !== null) {
    await deleteReleaseObjects(ctx, workspaceId, narrowed.previousReleaseId);
  }
  return false;
}

async function stageWebsiteRelease(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  routes: IndexedRoute[],
): Promise<{ releaseId: string; routes: IndexedRoute[] }> {
  const releaseId = crypto.randomUUID();
  const released = routes.map((route) =>
    route.status === "live"
      ? { ...route, releaseId, releasePageId: crypto.randomUUID() }
      : route,
  );
  const pages = released.flatMap((route) =>
    route.releasePageId === undefined
      ? []
      : [
          {
            pageId: route.releasePageId,
            path: route.objectKey,
            expectedEtag: route.sourceEtag,
          },
        ],
  );
  try {
    for (let offset = 0; offset < pages.length; offset += READ_BATCH) {
      const written = await ctx.runAction(
        internal.functions.files.runFileOperation,
        {
          workspaceId,
          scope: "private",
          grantedNames: [],
          operation: {
            kind: "writeWebsiteRelease",
            releaseId,
            pages: pages.slice(offset, offset + READ_BATCH),
          },
        },
      );
      if (written.kind !== "websiteReleaseWritten") {
        throw scanError("The bucket returned an invalid website release result.");
      }
    }
  } catch (error) {
    await ctx
      .runAction(internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private",
        grantedNames: [],
        operation: { kind: "deleteWebsiteRelease", releaseId },
      })
      .catch(() => {});
    throw error;
  }
  return { releaseId, routes: released };
}

async function finishWebsiteRelease(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  generation: number,
  routes: IndexedRoute[],
  restricted: string[],
  enabledOnly: boolean,
): Promise<boolean> {
  const release = await stageWebsiteRelease(ctx, workspaceId, routes);
  const result = await ctx.runMutation(
    internal.functions.websites.commitRouteReconciliation,
    {
      workspaceId,
      generation,
      routes: release.routes,
      releaseId: release.releaseId,
      restricted,
      ...(enabledOnly ? { enabledOnly: true } : {}),
    },
  );
  if (!result.committed) {
    await deleteReleaseObjects(ctx, workspaceId, release.releaseId);
    return false;
  }
  if (result.retiredReleaseId !== null) {
    await deleteReleaseObjects(
      ctx,
      workspaceId,
      result.retiredReleaseId,
      result.retiredPageIds,
    );
  }
  if (result.cleanupReleaseId !== null) {
    await deleteReleaseObjects(ctx, workspaceId, result.cleanupReleaseId);
  }
  return true;
}
