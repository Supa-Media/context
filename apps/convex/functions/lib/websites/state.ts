/**
 * The website lifecycle switch and its safe bucket handoff.
 *
 * Page content and route ownership stay in the customer's bucket. Convex holds
 * only the explicit enabled/disabled setting, because the presence of a
 * `website/` folder is not consent to publish it. Enabling first makes sure an
 * ordinary starter homepage exists, without overwriting one, and records the
 * lifecycle state only after that bucket step succeeds.
 */

import { requireAuthId } from "@supa-media/convex/auth";
import {
  DEFAULT_WEBSITE_ROOT,
  WEBSITE_CONTRACT_VERSION,
  WEBSITE_STARTER_MARKDOWN,
  type WebsiteEnableResult,
  type WebsiteStateView,
} from "@context/shared";
import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type {
  ActionCtx,
  MutationCtx,
  QueryCtx,
} from "../../../_generated/server";
import { recordAudit } from "../audit";
import { callerId } from "../filesFns/access";
import { ensureWebsitePublicationRule } from "./publication";
import { requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";

const STARTER_PATH = `${DEFAULT_WEBSITE_ROOT}/index.md`;

type WebsiteStateRow = Doc<"websiteStates"> | null;

async function stateRow(
  ctx: QueryCtx | MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<WebsiteStateRow> {
  return await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

function view(
  slug: string,
  canManage: boolean,
  row: WebsiteStateRow,
  canPublish = canManage,
): WebsiteStateView {
  const base = {
    contractVersion: WEBSITE_CONTRACT_VERSION,
    root: DEFAULT_WEBSITE_ROOT,
    handlePath: `/@${slug}/`,
    canManage,
  } as const;
  if (row?.state === "enabled" && row.enabledAt !== undefined) {
    return {
      ...base,
      state: "enabled",
      enabledAt: row.enabledAt,
      canPublish,
      ...(row.publishedAt === undefined ? {} : { publishedAt: row.publishedAt }),
    };
  }
  return { ...base, state: "disabled" };
}

/** Public, membership-scoped read for the Website settings section. */
export async function getWebsiteStateHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<WebsiteStateView> {
  const actorId = (await requireAuthId(ctx)) as Id<"users">;
  const { workspace, membership } = await requireWorkspaceAccess(
    ctx,
    args.workspaceId,
    actorId,
  );
  return view(
    workspace.slug,
    membership.role === "owner",
    await stateRow(ctx, args.workspaceId),
    membership.role === "owner" || membership.role === "editor",
  );
}

/**
 * Internal half read by the enable action before it opens the bucket.
 *
 * It repeats the owner gate rather than trusting the public action: this is an
 * independently callable internal function, and the role is the Settings
 * permission Seyi approved for the lifecycle switch.
 */
export async function websiteStateForEnableHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId: Id<"users"> },
): Promise<WebsiteStateView> {
  const { workspace } = await requireWorkspaceRole(
    ctx,
    args.workspaceId,
    args.actorUserId,
    "owner",
  );
  return view(workspace.slug, true, await stateRow(ctx, args.workspaceId));
}

/** Record enabled only after the action has completed its bucket step. */
export async function recordWebsiteEnabledHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId: Id<"users"> },
): Promise<Extract<WebsiteStateView, { state: "enabled" }>> {
  const { workspace } = await requireWorkspaceRole(
    ctx,
    args.workspaceId,
    args.actorUserId,
    "owner",
  );
  const existing = await stateRow(ctx, args.workspaceId);
  if (existing?.state === "enabled" && existing.enabledAt !== undefined) {
    return view(workspace.slug, true, existing) as Extract<
      WebsiteStateView,
      { state: "enabled" }
    >;
  }

  const now = Date.now();
  if (existing === null) {
    await ctx.db.insert("websiteStates", {
      workspaceId: args.workspaceId,
      state: "enabled",
      enabledAt: now,
      enabledBy: args.actorUserId,
      starterEnsuredAt: now,
      publicationRuleEnsuredAt: now,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, {
      state: "enabled",
      enabledAt: now,
      enabledBy: args.actorUserId,
      starterEnsuredAt: now,
      publicationRuleEnsuredAt: now,
      updatedAt: now,
    });
  }
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: "website.enabled",
  });
  // Index the homepage straight away: until a first scan lands, the resolver
  // fails closed and the site the card calls Live says "Nothing here".
  // Turning a site on publishes what its folder holds now.
  await ctx.scheduler.runAfter(
    0,
    internal.functions.websites.reconcileWorkspace,
    { workspaceId: args.workspaceId, publish: true },
  );
  return {
    contractVersion: WEBSITE_CONTRACT_VERSION,
    state: "enabled",
    root: DEFAULT_WEBSITE_ROOT,
    handlePath: `/@${workspace.slug}/`,
    canManage: true,
    enabledAt: now,
  };
}

/** Disable the lifecycle switch and preserve the whole bucket verbatim. */
export async function disableWebsiteHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<Extract<WebsiteStateView, { state: "disabled" }>> {
  const actorId = (await requireAuthId(ctx)) as Id<"users">;
  const { workspace } = await requireWorkspaceRole(
    ctx,
    args.workspaceId,
    actorId,
    "owner",
  );
  const existing = await stateRow(ctx, args.workspaceId);
  if (existing?.state !== "enabled") {
    return view(workspace.slug, true, existing) as Extract<
      WebsiteStateView,
      { state: "disabled" }
    >;
  }

  await ctx.db.patch(existing._id, {
    state: "disabled",
    enabledAt: undefined,
    enabledBy: undefined,
    updatedAt: Date.now(),
  });
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: actorId,
    action: "website.disabled",
  });
  return {
    contractVersion: WEBSITE_CONTRACT_VERSION,
    state: "disabled",
    root: DEFAULT_WEBSITE_ROOT,
    handlePath: `/@${workspace.slug}/`,
    canManage: true,
  };
}

function codeOf(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data;
  if (typeof data !== "object" || data === null || !("code" in data)) {
    return null;
  }
  return typeof data.code === "string" ? data.code : null;
}

/**
 * Ensure the starter through the existing credential barrier.
 *
 * The read-before-create avoids even attempting to rewrite an encrypted or
 * otherwise special existing homepage. The create itself still carries the
 * bucket's absent precondition; a concurrent creator becomes `existing`, not
 * an overwrite or a failed enable.
 */
export async function ensureWebsiteStarter(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId?: Id<"users">;
    scope: "private" | "team";
    grantedNames: string[];
    actorName?: string | null;
  },
): Promise<"created" | "existing"> {
  try {
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: args.scope,
      grantedNames: args.grantedNames,
      actorName: args.actorName,
      operation: { kind: "read", path: STARTER_PATH },
    });
    return "existing";
  } catch (error) {
    if (codeOf(error) !== "FILE_NOT_FOUND") throw error;
  }

  try {
    const written = await ctx.runAction(
      internal.functions.files.runFileOperation,
      {
        workspaceId: args.workspaceId,
        scope: args.scope,
        grantedNames: args.grantedNames,
        actorName: args.actorName,
        operation: {
          kind: "write",
          path: STARTER_PATH,
          text: WEBSITE_STARTER_MARKDOWN,
        },
      },
    );
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      ...(args.actorUserId === undefined
        ? {}
        : { actorUserId: args.actorUserId }),
      action: "file.create",
      paths: [STARTER_PATH],
      details: {
        conflictCheck:
          "conflictCheck" in written
            ? String(written.conflictCheck)
            : "conditional",
        ...(args.actorUserId === undefined
          ? { source: "website-starter-repair" }
          : {}),
      },
    });
    return "created";
  } catch (error) {
    if (codeOf(error) === "CONFLICT") return "existing";
    throw error;
  }
}

/** Whether this pre-marker enabled site still needs its one safe repair. */
export async function websiteStarterRepairNeededHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<boolean> {
  const state = await stateRow(ctx, args.workspaceId);
  return state?.state === "enabled" && state.starterEnsuredAt === undefined;
}

/** Mark the legacy repair complete only while the site remains enabled. */
export async function markWebsiteStarterEnsuredHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<boolean> {
  const state = await stateRow(ctx, args.workspaceId);
  if (state?.state !== "enabled" || state.starterEnsuredAt !== undefined) {
    return false;
  }
  const now = Date.now();
  await ctx.db.patch(state._id, { starterEnsuredAt: now, updatedAt: now });
  return true;
}

/** Whether this enabled site predates its `privacy.md` folder rule. */
export async function websitePublicationRepairNeededHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<boolean> {
  const state = await stateRow(ctx, args.workspaceId);
  return (
    state?.state === "enabled" && state.publicationRuleEnsuredAt === undefined
  );
}

/** Mark the one publication-rule repair complete while the site is enabled. */
export async function markWebsitePublicationEnsuredHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<boolean> {
  const state = await stateRow(ctx, args.workspaceId);
  if (
    state?.state !== "enabled" ||
    state.publicationRuleEnsuredAt !== undefined
  ) {
    return false;
  }
  const now = Date.now();
  await ctx.db.patch(state._id, {
    publicationRuleEnsuredAt: now,
    updatedAt: now,
  });
  return true;
}

/**
 * Public action: safe starter, then the `privacy.md` rule that publishes the
 * folder, then lifecycle state — so a site is never recorded as enabled over a
 * folder the manifest has not been told about.
 */
export async function enableWebsiteHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<WebsiteEnableResult> {
  const actorUserId = await callerId(ctx);
  const current = await ctx.runQuery(
    internal.functions.workspaces.websiteStateForEnable,
    { workspaceId: args.workspaceId, actorUserId },
  );
  if (current.state === "enabled") {
    return { ...current, starter: "existing" };
  }

  const access = await ctx.runQuery(
    internal.functions.files.authorizeFileAccess,
    {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    },
  );
  const starter = await ensureWebsiteStarter(ctx, {
    workspaceId: args.workspaceId,
    actorUserId,
    scope: access.scope,
    grantedNames: access.grantedNames,
    actorName: access.actorName,
  });
  await ensureWebsitePublicationRule(ctx, {
    workspaceId: args.workspaceId,
    actorUserId,
    actorName: access.actorName,
  });
  const enabled = await ctx.runMutation(
    internal.functions.workspaces.recordWebsiteEnabled,
    { workspaceId: args.workspaceId, actorUserId },
  );
  return { ...enabled, starter };
}
