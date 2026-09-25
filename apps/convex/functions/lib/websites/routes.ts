/** Bucket scan and derived-index reconciliation for website route metadata. */

import {
  DEFAULT_WEBSITE_ROOT,
  buildWebsiteRouteStatuses,
  websiteRouteLookupKey,
  type WebsiteRouteStatus,
} from "@context/shared";
import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../../../_generated/server";
import { callerId } from "../filesFns/access";
import { workspaceNotFound } from "../workspaceAuth";

const MAX_WEBSITE_ROUTES = 500;
const READ_BATCH = 50;

type Clearance = {
  scope: "private" | "team";
  grantedNames: string[];
};

type IndexedRoute = WebsiteRouteStatus & { sourceEtag: string };

function scanError(
  message: string,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "WEBSITE_SCAN_INCOMPLETE", message });
}

/**
 * Read one complete, privacy-filtered website snapshot through the existing
 * credential barrier. A partial manifest is never treated as evidence that a
 * previously indexed route was deleted.
 */
export async function scanWebsiteRoutes(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  clearance: Clearance,
): Promise<{ statuses: WebsiteRouteStatus[]; indexed: IndexedRoute[] }> {
  const paths: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const manifest = await ctx.runAction(
      internal.functions.files.runFileOperation,
      {
        workspaceId,
        scope: clearance.scope,
        grantedNames: clearance.grantedNames,
        operation: {
          kind: "manifest",
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
    );
    if (manifest.kind !== "manifest")
      throw scanError("The website listing returned an invalid result.");
    for (const entry of manifest.entries) {
      if (
        entry.path.startsWith(`${DEFAULT_WEBSITE_ROOT}/`) &&
        /\.md$/i.test(entry.path)
      ) {
        paths.push(entry.path);
        if (paths.length > MAX_WEBSITE_ROUTES) {
          throw scanError(
            `A website may contain at most ${MAX_WEBSITE_ROUTES} route files.`,
          );
        }
      }
    }
    if (manifest.truncated) {
      const nextCursor = manifest.cursor ?? undefined;
      if (
        nextCursor === undefined ||
        nextCursor === cursor ||
        seenCursors.has(nextCursor)
      ) {
        throw scanError(
          "The bucket could not complete a website listing safely.",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    } else {
      cursor = undefined;
    }
  } while (cursor !== undefined);

  const pages: Array<{ objectKey: string; markdown: string }> = [];
  const etags = new Map<string, string>();
  for (let offset = 0; offset < paths.length; offset += READ_BATCH) {
    let pending = paths.slice(offset, offset + READ_BATCH);
    while (pending.length > 0) {
      const batch = await ctx.runAction(
        internal.functions.files.runFileOperation,
        {
          workspaceId,
          scope: clearance.scope,
          grantedNames: clearance.grantedNames,
          operation: { kind: "readMany", paths: pending },
        },
      );
      if (batch.kind !== "notes")
        throw scanError("The website read returned an invalid result.");
      const deferred: string[] = [];
      const expected = new Set(pending);
      let progressed = false;
      for (const result of batch.results) {
        if (!expected.delete(result.path)) {
          throw scanError("The bucket returned an invalid website read set.");
        }
        if (result.outcome === "deferred") {
          deferred.push(result.path);
          continue;
        }
        progressed = true;
        // A file deleted between listing and read simply is not in this
        // snapshot; hidden and missing are already the same result below the
        // barrier, so no existence detail escapes.
        if (result.outcome !== "read") continue;
        pages.push({ objectKey: result.path, markdown: result.note.text });
        etags.set(result.path, result.note.rawEtag ?? result.note.etag);
      }
      if (expected.size > 0) {
        throw scanError("The bucket returned an incomplete website read set.");
      }
      if (!progressed && deferred.length > 0) {
        throw scanError("The bucket made no progress reading website files.");
      }
      pending = deferred;
    }
  }

  const statuses = buildWebsiteRouteStatuses(pages);
  return {
    statuses,
    indexed: statuses.map((status) => ({
      ...status,
      sourceEtag: etags.get(status.objectKey)!,
    })),
  };
}

async function websiteState(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"websiteStates"> | null> {
  return await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** Allocate a monotonic fence before opening the bucket. */
export async function beginRouteReconciliationHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; enabledOnly?: boolean },
): Promise<number | null> {
  if ((await ctx.db.get(args.workspaceId)) === null) {
    throw workspaceNotFound();
  }
  const current = await websiteState(ctx, args.workspaceId);
  if (args.enabledOnly === true && current?.state !== "enabled") return null;
  const generation = (current?.routeGeneration ?? 0) + 1;
  const attemptedAt = Date.now();
  if (current === null) {
    await ctx.db.insert("websiteStates", {
      workspaceId: args.workspaceId,
      state: "disabled",
      routeGeneration: generation,
      routeAttemptedAt: attemptedAt,
      updatedAt: attemptedAt,
    });
  } else {
    await ctx.db.patch(current._id, {
      routeGeneration: generation,
      routeAttemptedAt: attemptedAt,
    });
  }
  return generation;
}

/** Atomically replace the disposable index only if this scan still owns it. */
export async function commitRouteReconciliationHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    generation: number;
    routes: IndexedRoute[];
    enabledOnly?: boolean;
  },
): Promise<boolean> {
  const state = await websiteState(ctx, args.workspaceId);
  if (
    state?.routeGeneration !== args.generation ||
    (args.enabledOnly === true && state.state !== "enabled")
  ) {
    return false;
  }
  const existing = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  for (const row of existing) await ctx.db.delete(row._id);
  const now = Date.now();
  for (const route of args.routes) {
    await ctx.db.insert("websiteRouteIndex", {
      workspaceId: args.workspaceId,
      objectKey: route.objectKey,
      routePath: route.routePath,
      ...(route.routePath === null
        ? {}
        : { lookupKey: websiteRouteLookupKey(route.routePath) }),
      sourceEtag: route.sourceEtag,
      status: route.status,
      audience: route.audience,
      title: route.title,
      description: route.description,
      nav: route.nav,
      problems: route.problems,
      updatedAt: now,
    });
  }
  await ctx.db.patch(state._id, {
    routeReconciledGeneration: args.generation,
    routeReconciledAt: now,
  });
  return true;
}

/** Live owner/member view; owners additionally refresh the global derivative. */
export async function refreshRouteStatusesHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<WebsiteRouteStatus[]> {
  const actorUserId = await callerId(ctx);
  const access = await ctx.runQuery(
    internal.functions.files.authorizeFileAccess,
    {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    },
  );
  const generation =
    access.role === "owner"
      ? await ctx.runMutation(
          internal.functions.websites.beginRouteReconciliation,
          args,
        )
      : null;
  const snapshot = await scanWebsiteRoutes(ctx, args.workspaceId, {
    scope: access.scope,
    grantedNames: access.grantedNames,
  });
  if (generation !== null) {
    await ctx.runMutation(
      internal.functions.websites.commitRouteReconciliation,
      {
        workspaceId: args.workspaceId,
        generation,
        routes: snapshot.indexed,
      },
    );
  }
  return snapshot.statuses;
}

/** Unattended repair pass; disabled sites are re-checked and refused. */
export async function reconcileWorkspaceHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<boolean> {
  const generation = await ctx.runMutation(
    internal.functions.websites.beginRouteReconciliation,
    { ...args, enabledOnly: true },
  );
  if (generation === null) return false;
  const snapshot = await scanWebsiteRoutes(ctx, args.workspaceId, {
    scope: "private",
    grantedNames: [],
  });
  return await ctx.runMutation(
    internal.functions.websites.commitRouteReconciliation,
    {
      workspaceId: args.workspaceId,
      generation,
      routes: snapshot.indexed,
      enabledOnly: true,
    },
  );
}

/** Queue a bounded oldest-attempted batch so one broken bucket cannot starve peers. */
export async function sweepRouteReconciliationHandler(
  ctx: MutationCtx,
): Promise<number> {
  const states = await ctx.db
    .query("websiteStates")
    .withIndex("by_state_attempted", (q) => q.eq("state", "enabled"))
    .take(20);
  for (const state of states) {
    await ctx.scheduler.runAfter(
      0,
      internal.functions.websites.reconcileWorkspace,
      {
        workspaceId: state.workspaceId,
      },
    );
  }
  return states.length;
}
