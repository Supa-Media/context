/**
 * A change named by its paths that may narrow a website from outside
 * `website/`: a privacy change, a move, a delete, or a queued move starting,
 * turning round or finishing (`nodeMoves.ts`).
 *
 * `operationTouchesWebsite` (`./changes.ts`) answers for `website/` by path
 * alone. A page can also publish the notes of a folder it names with
 * `folder:`, and nothing about `features/` says so: moving it, or making it
 * private, took its notes off the site only at the next quarter-hourly sweep,
 * and the menu went on listing their titles until then. The route index knows
 * which notes are published, so a change reaches the site when one of its
 * paths is `website/`, `privacy.md`, or holds (or is held by) a published
 * note's key. A folder a page names that published nothing has nothing a
 * change could take away; anything it would add waits for Publish.
 */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../../../_generated/server";
import type { FileOperation, OperationResult } from "../filesFns/operationTypes";
import { PRIVACY_KEY, foldPath } from "../privacy";
import { operationMayRestrictWebsite, operationTouchesWebsite, websiteNarrowingPaths } from "./changes";
import { pathsOverlap } from "./movingScan";
import { recordRouteChangeHandler } from "./routes";

function normalized(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

/** Whether a change at any of `paths` may change what this workspace's site publishes. */
export async function routeChangeReaches(
  ctx: Pick<QueryCtx, "db">,
  workspaceId: Id<"workspaces">,
  paths: readonly string[],
): Promise<boolean> {
  const named = paths.map(normalized).filter((path) => path !== "");
  if (named.length === 0) return false;
  if (named.some((path) => foldPath(path) === PRIVACY_KEY || pathsOverlap(path, DEFAULT_WEBSITE_ROOT))) {
    return true;
  }
  const rows = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return rows.some((row) => named.some((path) => pathsOverlap(path, row.objectKey)));
}

/** Mark the site stale (and, with `unsafe`, withhold its menu) when the change reaches it. */
export async function recordRouteChangeAtHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; paths: string[]; unsafe?: boolean },
): Promise<boolean> {
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (state?.state !== "enabled") return false;
  if (!(await routeChangeReaches(ctx, args.workspaceId, args.paths))) return false;
  return await recordRouteChangeHandler(ctx, {
    workspaceId: args.workspaceId,
    ...(args.unsafe === undefined ? {} : { unsafe: args.unsafe }),
  });
}

/** A queued move was drawn, turned round or finished: its names changed for everyone at once. */
export async function markWebsiteMoved(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  move: { from: string; to: string },
): Promise<void> {
  // A move is a narrowing for every page it carries away, as a one-go move is.
  await recordRouteChangeAtHandler(ctx, { workspaceId, paths: [move.from, move.to], unsafe: true });
}

/**
 * After a file operation lands (the credential barrier): a change under
 * `website/` or to `privacy.md` marks the index stale, unsafe when it may
 * restrict; a privacy change, move or delete elsewhere does when it reaches a
 * published note. Never fails the operation, whose answer already stands.
 */
export async function markWebsiteAfterOperation(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  operation: FileOperation,
  result: OperationResult,
): Promise<void> {
  if (operationTouchesWebsite(operation, result)) {
    await ctx
      .runMutation(internal.functions.websites.recordRouteChange, {
        workspaceId,
        unsafe: operationMayRestrictWebsite(operation, result),
      })
      .catch(() => {});
  }
  const paths = websiteNarrowingPaths(operation, result);
  if (paths.length > 0) {
    await ctx
      .runMutation(internal.functions.websites.recordRouteChangeAt, { workspaceId, paths, unsafe: true })
      .catch(() => {});
  }
}
