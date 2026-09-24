/**
 * The handler for `workspaces.setMeetingsFolder`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row,
 * and see `setMeetingsFolder`'s own doc comment there for why this setting
 * exists and what it does not change.
 */

import { ConvexError } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { requireWorkspaceRole, workspaceNotFound } from "../workspaceAuth";
/*
  The gateway's own gate on this value, not a second one. An offer
  `normalizeMeetingFolder` refuses is an offer the meeting write then rejects,
  so a setting validated any other way could be saved and silently ignored.
*/
import { MEETINGS_FOLDER, normalizeMeetingFolder } from "../../../../../packages/meetings/src/paths.js";

export async function setMeetingsFolderHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; folder: string | null },
): Promise<{ folder: string }> {
  const actorId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

  const workspace = await ctx.db.get(args.workspaceId);
  /*
    The helper, not a literal. `workspaceAuth.ts` is the one place this error
    is constructed so that "not a member" and "does not exist" stay
    byte-identical, and `workspaceAuth.test.ts` fails if the string appears
    anywhere else in `functions/` — which is how this line was caught.
  */
  if (workspace === null) throw workspaceNotFound();
  if (workspace.kind !== "personal") {
    throw new ConvexError({
      code: "MEETINGS_FOLDER_NOT_PERSONAL",
      message:
        "Meetings are offered your own workspace first, so the folder is a setting on a personal workspace rather than on a shared one.",
    });
  }

  /*
    `null` clears the choice rather than storing the default's spelling. A
    stored "0-inbox/meetings" would stop following the default if it ever
    moved, which is how a person who never expressed a preference ends up
    pinned to an old one.
  */
  const folder =
    args.folder === null ? null : normalizeMeetingFolder(args.folder);
  if (args.folder !== null && folder === null) {
    throw new ConvexError({
      code: "MEETINGS_FOLDER_INVALID",
      message: "Use a folder inside this context — not the root, and not a note.",
    });
  }

  await ctx.db.patch(args.workspaceId, {
    meetingsFolder: folder ?? undefined,
    updatedAt: Date.now(),
  });

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: actorId,
    action: "meetings.folder_set",
    details: { meetingsFolder: folder ?? MEETINGS_FOLDER },
  });

  return { folder: folder ?? MEETINGS_FOLDER };
}
