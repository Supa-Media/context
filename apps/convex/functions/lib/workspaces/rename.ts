/**
 * The handler for `workspaces.setWorkspaceDisplayName`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context. The display name is the label beside the address: it is
 * drawn in every member's switcher and in the invitation emails the workspace
 * sends, so like the icon it is the owner's to change. The slug never moves
 * here; it is the stable name people type and links point at.
 */

import { ConvexError } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireWorkspaceRole } from "../workspaceAuth";
import { MAX_DISPLAY_NAME_LENGTH } from "./constants";

/**
 * The shape rule `createWorkspace` applies, as one function: trimmed, not
 * empty, at most `MAX_DISPLAY_NAME_LENGTH`. Throws the same error code.
 */
export function normalizeDisplayName(raw: string): string {
  const displayName = raw.trim();
  if (displayName.length === 0) {
    throw new ConvexError({
      code: "INVALID_DISPLAY_NAME",
      message: "A workspace needs a display name.",
    });
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new ConvexError({
      code: "INVALID_DISPLAY_NAME",
      message: `Display names must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
    });
  }
  return displayName;
}

export async function setWorkspaceDisplayNameHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; displayName: string },
): Promise<null> {
  const actorId = (await requireAuthId(ctx)) as Id<"users">;
  const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");
  const displayName = normalizeDisplayName(args.displayName);
  if (displayName === workspace.displayName) return null;
  await ctx.db.patch(args.workspaceId, { displayName, updatedAt: Date.now() });
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: actorId,
    action: "workspace.renamed",
    details: { from: workspace.displayName, to: displayName },
  });
  return null;
}
