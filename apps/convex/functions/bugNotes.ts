/**
 * Bug reports filed by texting Tex land as notes in the pinned context, under
 * its Areas folder's `tex-bugs/`, rather than in Sentry (decided by the
 * owner, 2026-10-18; `docs/decisions/texting-assistant/bug-reports.md`).
 *
 * `destination` is the one read deciding where: the pinned context, the folder
 * doing its Areas job, and whether the reporter is on the team (a real
 * membership) or a user (reach through the pin alone). `null` where the
 * deployment has no pinned context, a self-hosted one, and the report goes to
 * Sentry as every other report does.
 *
 * `fileBugNote` writes it, and only where nobody reaching the context through
 * the pin can read it: every account on the deployment reads the pinned
 * context's team notes, so a report there at `team` would hand one person's
 * texts to everyone. Checked before the write, never after, and refused rather
 * than written when the folder has been opened up.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalQuery, type ActionCtx } from "../_generated/server";
import { usernameOf } from "./lib/adminFns/people";
import { bugFolder, bugNotePath, renderBugNote } from "./lib/feedback/bugNote";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { getMembership } from "./lib/workspaceAuth";

export const destination = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({ workspaceId: v.id("workspaces"), folder: v.string(), handle: v.union(v.string(), v.null()), team: v.boolean() }),
  ),
  handler: async (ctx, { userId }) => {
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned === null) return null;
    const team = (await getMembership(ctx, pinned._id, userId)) !== null;
    const areas = (await folderJobsOf(ctx.db, pinned._id)).jobs.areas ?? null;
    return { workspaceId: pinned._id, folder: bugFolder(areas, team), handle: await usernameOf(ctx, userId), team };
  },
});

export interface BugDestination {
  workspaceId: Id<"workspaces">;
  folder: string;
  handle: string | null;
  team: boolean;
}

/**
 * Write one report as a note. True once it is there; false when the folder is
 * readable through the pin (nothing written) or the bucket refused it.
 */
export async function fileBugNote(
  ctx: Pick<ActionCtx, "runAction">,
  where: BugDestination,
  report: { message: string; texts?: string; eventId: string; now: number },
): Promise<boolean> {
  const path = bugNotePath(where.folder, report);
  const workspaceId: Id<"workspaces"> = where.workspaceId;
  try {
    const seen = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "team",
      grantedNames: [],
      operation: { kind: "visiblePaths", paths: [path] },
    });
    if (seen.kind !== "visiblePaths" || seen.paths.length > 0) {
      console.error("bug_note_folder_not_private", { workspaceId });
      return false;
    }
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      actorName: null,
      operation: { kind: "write", path, text: renderBugNote({ ...report, handle: where.handle, team: where.team }) },
    });
    return true;
  } catch (error) {
    // Never the report's words: only that it did not land.
    console.error("bug_note_failed", { workspaceId, code: error instanceof ConvexError ? (error.data as { code?: string })?.code : "unknown" });
    return false;
  }
}
