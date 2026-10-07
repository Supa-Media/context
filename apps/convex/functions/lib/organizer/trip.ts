/**
 * One trip through the credential barrier for the organizer, and the owner
 * check its public actions start with. Shared by `functions/organizer.ts` and
 * `functions/organizerRoutes.ts`.
 */

import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { OperationResult } from "../filesFns/operationTypes";
import type { OrganizerAction } from "./sweepOps";

/**
 * At the caller's own clearance, never above it: `owner` in the workspace the
 * organizer belongs to, `editor` when a note is sent into one of their teams.
 */
export async function organizerOp(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  actorUserId: Id<"users">,
  op: { action: OrganizerAction; input?: unknown; autopilot?: boolean },
  minimum: "owner" | "editor" = "owner",
): Promise<unknown> {
  const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId,
    minimum,
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId,
    scope,
    grantedNames,
    actorName,
    operation: {
      kind: "organizer",
      action: op.action,
      input: JSON.stringify(op.input ?? {}),
      ...(op.autopilot === true ? { autopilot: true } : {}),
    },
  })) as OperationResult;
  if (result.kind !== "organizerResult") throw new ConvexError({ code: "ORGANIZER_FAILED", message: "Auto-organize couldn't reach your notes." });
  return JSON.parse(result.output) as unknown;
}

/** Owner check for an action, which cannot read the database itself. */
export async function ownerOf(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Sign in first." });
  const allowed = await ctx.runQuery(internal.functions.organizer.isOwnerOnPlan, { workspaceId, userId });
  if (!allowed) throw new ConvexError({ code: "INSUFFICIENT_ROLE", message: "Only the owner can do this." });
  return userId;
}
