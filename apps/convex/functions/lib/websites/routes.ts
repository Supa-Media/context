/** Bucket scan and derived-index reconciliation for website route metadata. */

import {
  DEFAULT_WEBSITE_ROOT,
  buildWebsiteRouteStatuses,
  websiteRouteLookupKey,
  type WebsiteRouteStatus,
} from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../../../_generated/server";
import { callerId } from "../filesFns/access";
import { isEncryptedNote } from "../noteEncryption";
import { websiteTextRestricts } from "./changes";
import { workspaceNotFound } from "../workspaceAuth";
import { PUBLICATION_CLEARANCE, ensureWebsitePublicationRule } from "./publication";
import { narrowedRows } from "./narrowing";
import {
  READ_BATCH,
  commitPublicationSnapshot,
  scanError,
  type IndexedRoute,
} from "./releases";
import { ensureWebsiteStarter } from "./state";

const MAX_WEBSITE_ROUTES = 500;

type Clearance = {
  scope: "private" | "team";
  grantedNames: string[];
};

type ReconciliationCommit = {
  committed: boolean;
  cleanupReleaseId: string | null;
  /** The release this commit demoted to grace, and its pages that go now. */
  retiredReleaseId: string | null;
  retiredPageIds: string[];
};


/**
 * Read one complete, privacy-filtered website snapshot through the existing
 * credential barrier. A partial manifest is never treated as evidence that a
 * previously indexed route was deleted.
 */
export async function scanWebsiteRoutes(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  clearance: Clearance,
  options: { publication?: boolean } = {},
): Promise<{
  statuses: WebsiteRouteStatus[];
  indexed: IndexedRoute[];
  restricted: string[];
}> {
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
    // `truncated` means the manifest is only a non-resumable floor. Ordinary
    // complete pagination has `truncated: false` plus a non-null cursor.
    if (manifest.truncated) {
      throw scanError("The bucket could not complete a website listing safely.");
    }
    const nextCursor = manifest.cursor ?? undefined;
    if (nextCursor === undefined) {
      cursor = undefined;
    } else {
      if (nextCursor === cursor || seenCursors.has(nextCursor)) {
        throw scanError(
          "The bucket could not complete a website listing safely.",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
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
        // Ciphertext can never be published, so a publication snapshot holds
        // it as it holds a private note: absent. As a "problem" it would stop
        // every later rebuild while it sat in the folder.
        if (options.publication === true && isEncryptedNote(result.note.text)) {
          continue;
        }
        pages.push({ objectKey: result.path, markdown: result.note.text });
        // The effective etag includes collaboration updates. Using only the
        // provider object's raw etag could leave changed frontmatter live when
        // a Yjs sidecar advanced without rewriting the Markdown base object.
        etags.set(result.path, result.note.etag);
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
    restricted: pages
      .filter((page) => websiteTextRestricts(page.markdown))
      .map((page) => page.objectKey),
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
  args: {
    workspaceId: Id<"workspaces">;
    enabledOnly?: boolean;
    expectedGeneration?: number;
  },
): Promise<number | null> {
  if ((await ctx.db.get(args.workspaceId)) === null) {
    throw workspaceNotFound();
  }
  const current = await websiteState(ctx, args.workspaceId);
  if (args.enabledOnly === true && current?.state !== "enabled") return null;
  if (args.expectedGeneration !== undefined) {
    if (current?.routeGeneration !== args.expectedGeneration) return null;
    await ctx.db.patch(current._id, { routeAttemptedAt: Date.now() });
    return args.expectedGeneration;
  }
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
    releaseId?: string;
    enabledOnly?: boolean;
    problemsOnlyIfUnpublished?: boolean;
    restricted?: string[];
  },
): Promise<ReconciliationCommit> {
  const state = await websiteState(ctx, args.workspaceId);
  if (
    state?.routeGeneration !== args.generation ||
    (args.enabledOnly === true && state.state !== "enabled") ||
    (args.problemsOnlyIfUnpublished === true &&
      state.routeReconciledGeneration !== undefined)
  ) {
    return {
      committed: false,
      cleanupReleaseId: null,
      retiredReleaseId: null,
      retiredPageIds: [],
    };
  }
  const existing = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  // The release this commit demotes to grace keeps a copy of every page it
  // held; the ones this snapshot narrowed go now, not a generation later.
  const retiredPageIds =
    args.releaseId === undefined
      ? []
      : narrowedRows(existing, args.routes, new Set(args.restricted ?? []))
          .filter((row) => row.releaseId === state.publishedReleaseId)
          .flatMap((row) =>
            row.releasePageId === undefined ? [] : [row.releasePageId],
          );
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
      ...(route.releaseId === undefined ? {} : { releaseId: route.releaseId }),
      ...(route.releasePageId === undefined
        ? {}
        : { releasePageId: route.releasePageId }),
      status: route.status,
      audience: route.audience,
      title: route.title,
      description: route.description,
      nav: route.nav,
      problems: route.problems,
      updatedAt: now,
    });
  }
  const cleanupReleaseId =
    args.releaseId === undefined ? null : (state.previousReleaseId ?? null);
  await ctx.db.patch(state._id, {
    routeReconciledGeneration: args.generation,
    routeReconciledAt: now,
    routeUnsafeGeneration: undefined,
    siteRevision: (state.siteRevision ?? 0) + 1,
    ...(args.releaseId === undefined
      ? {}
      : {
          publishedReleaseId: args.releaseId,
          previousReleaseId: state.publishedReleaseId,
          publishedAt: now,
        }),
  });
  return {
    committed: true,
    cleanupReleaseId,
    retiredReleaseId:
      retiredPageIds.length > 0 ? (state.publishedReleaseId ?? null) : null,
    retiredPageIds,
  };
}

/**
 * The narrowing half of a scan that does not publish. Fenced like a commit;
 * drops the rows `narrowedRows` names without adding any, and retires the
 * grace release (which holds a copy of every page the current one does).
 *
 * The scan is then complete for everything it may change, so the reconciled
 * generation advances and the unsafe marker lifts: widening is no longer a
 * later scan's job but the next Publish's.
 */
export async function narrowRouteIndexHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    generation: number;
    routes: IndexedRoute[];
    restricted: string[];
    enabledOnly?: boolean;
  },
): Promise<{
  releaseId: string | null;
  pageIds: string[];
  previousReleaseId: string | null;
}> {
  const nothing = {
    releaseId: null,
    pageIds: [] as string[],
    previousReleaseId: null,
  };
  const state = await websiteState(ctx, args.workspaceId);
  if (
    state?.routeGeneration !== args.generation ||
    state.routeReconciledGeneration === undefined ||
    (args.enabledOnly === true && state.state !== "enabled")
  ) {
    return nothing;
  }
  const existing = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  const narrowed = narrowedRows(existing, args.routes, new Set(args.restricted));
  const liftUnsafe =
    state.routeUnsafeGeneration !== undefined &&
    state.routeUnsafeGeneration <= args.generation;
  const reconciled = {
    routeReconciledGeneration: args.generation,
    routeReconciledAt: Date.now(),
    ...(liftUnsafe ? { routeUnsafeGeneration: undefined } : {}),
    // What a visitor is served changed, or its menu is back.
    ...(narrowed.length > 0 || liftUnsafe
      ? { siteRevision: (state.siteRevision ?? 0) + 1 }
      : {}),
  };
  if (narrowed.length === 0) {
    await ctx.db.patch(state._id, reconciled);
    return nothing;
  }
  for (const row of narrowed) await ctx.db.delete(row._id);
  const pageIds = narrowed
    .filter((row) => row.releaseId === state.publishedReleaseId)
    .flatMap((row) => (row.releasePageId === undefined ? [] : [row.releasePageId]));
  await ctx.db.patch(state._id, { ...reconciled, previousReleaseId: undefined });
  return {
    releaseId: pageIds.length > 0 ? (state.publishedReleaseId ?? null) : null,
    pageIds,
    previousReleaseId: state.previousReleaseId ?? null,
  };
}

/** Mark a complete derivative stale after a runtime source mismatch. */
export async function invalidateRouteIndexHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; unsafe?: boolean },
): Promise<boolean> {
  const state = await websiteState(ctx, args.workspaceId);
  if (state?.state !== "enabled") return false;
  if (
    state.routeGeneration === undefined ||
    state.routeGeneration !== state.routeReconciledGeneration
  ) {
    if (args.unsafe === true && state.routeUnsafeGeneration === undefined) {
      await ctx.db.patch(state._id, {
        routeUnsafeGeneration: state.routeGeneration ?? 0,
      });
    }
    return false;
  }
  const generation = (state.routeGeneration ?? 0) + 1;
  await ctx.db.patch(state._id, {
    routeGeneration: generation,
    routeAttemptedAt: Date.now(),
    ...(args.unsafe === true ? { routeUnsafeGeneration: generation } : {}),
  });
  // A stale index serves nothing, so rebuild it now rather than at the next
  // sweep: waiting left a site on "Nothing here" for up to a quarter hour
  // after every edit. The short delay lets a burst of saves share one scan;
  // only a fresh index is invalidated, so a burst schedules once.
  await ctx.scheduler.runAfter(
    RECONCILE_AFTER_CHANGE_MS,
    internal.functions.websites.reconcileWorkspace,
    { workspaceId: args.workspaceId, expectedGeneration: generation },
  );
  return true;
}

/** Record every in-product write, so the last save in a burst owns the rebuild. */
export async function recordRouteChangeHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; unsafe?: boolean },
): Promise<boolean> {
  const state = await websiteState(ctx, args.workspaceId);
  if (state?.state !== "enabled") return false;
  const generation = (state.routeGeneration ?? 0) + 1;
  const now = Date.now();
  await ctx.db.patch(state._id, {
    routeGeneration: generation,
    routeAttemptedAt: now,
    ...(args.unsafe === true ? { routeUnsafeGeneration: generation } : {}),
  });
  await ctx.scheduler.runAfter(
    RECONCILE_AFTER_CHANGE_MS,
    internal.functions.websites.reconcileWorkspace,
    { workspaceId: args.workspaceId, expectedGeneration: generation },
  );
  return true;
}

/** How long a changed website waits before its index is rebuilt. */
export const RECONCILE_AFTER_CHANGE_MS = 2_000;

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
    // The caller's own view says what they can see; what the site publishes
    // is decided at the publication clearance. An owner reads every note, so
    // committing their snapshot would put private notes on the internet.
    const published = await scanWebsiteRoutes(
      ctx,
      args.workspaceId,
      PUBLICATION_CLEARANCE,
      { publication: true },
    );
    // Looking at the statuses applies restrictions; only Publish widens.
    await commitPublicationSnapshot(
      ctx,
      args.workspaceId,
      generation,
      published,
      false,
      await firstScan(ctx, args.workspaceId),
    );
  }
  return snapshot.statuses;
}

/** Unattended repair pass; disabled sites are re-checked and refused. */
export async function reconcileWorkspaceHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    expectedGeneration?: number;
    /** Someone pressed Publish or turned the site on: widen as well. */
    publish?: boolean;
  },
): Promise<boolean> {
  let generation = await ctx.runMutation(
    internal.functions.websites.beginRouteReconciliation,
    {
      workspaceId: args.workspaceId,
      enabledOnly: true,
      ...(args.expectedGeneration === undefined
        ? {}
        : { expectedGeneration: args.expectedGeneration }),
    },
  );
  if (generation === null) return false;
  const repairStarter = await ctx.runQuery(
    internal.functions.websites.websiteStarterRepairNeeded,
    { workspaceId: args.workspaceId },
  );
  if (repairStarter) {
    await ensureWebsiteStarter(ctx, {
      workspaceId: args.workspaceId,
      scope: "private",
      grantedNames: [],
      actorName: null,
    });
    await ctx.runMutation(
      internal.functions.websites.markWebsiteStarterEnsured,
      { workspaceId: args.workspaceId },
    );
    // The starter write is itself a website change and advances the fence.
    // Claim the now-current generation before scanning the bytes it created.
    generation = await ctx.runMutation(
      internal.functions.websites.beginRouteReconciliation,
      { workspaceId: args.workspaceId, enabledOnly: true },
    );
    if (generation === null) return false;
  }
  const repairPublication = await ctx.runQuery(
    internal.functions.websites.websitePublicationRepairNeeded,
    { workspaceId: args.workspaceId },
  );
  if (repairPublication) {
    // A missing or unreadable `privacy.md` leaves the repair for a later
    // pass; the scan below then publishes only what the manifest allows,
    // which without a manifest is nothing.
    const repaired = await ensureWebsitePublicationRule(ctx, {
      workspaceId: args.workspaceId,
    }).then(
      () => true,
      () => false,
    );
    if (repaired) {
      await ctx.runMutation(
        internal.functions.websites.markWebsitePublicationEnsured,
        { workspaceId: args.workspaceId },
      );
      // A manifest write is a website change and advances the fence.
      generation = await ctx.runMutation(
        internal.functions.websites.beginRouteReconciliation,
        { workspaceId: args.workspaceId, enabledOnly: true },
      );
      if (generation === null) return false;
    }
  }
  // The committed index is what anonymous visitors are served from, so it is
  // built at the clearance a link resolves at, never at the owner's.
  const snapshot = await scanWebsiteRoutes(
    ctx,
    args.workspaceId,
    PUBLICATION_CLEARANCE,
    { publication: true },
  );
  return await commitPublicationSnapshot(
    ctx,
    args.workspaceId,
    generation,
    snapshot,
    true,
    args.publish === true || (await firstScan(ctx, args.workspaceId)),
  );
}

/**
 * A site that has never had a complete scan has nothing published to keep,
 * so its first scan publishes: turning a site on is the first Publish.
 */
async function firstScan(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  return !(await ctx.runQuery(internal.functions.websites.websiteEverReconciled, {
    workspaceId,
  }));
}

export async function websiteEverReconciledHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<boolean> {
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  return state?.routeReconciledGeneration !== undefined;
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
