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
 *
 * The team still reads every report (decided by the owner, 2026-10-19: "bug
 * reports should be team accessible"). "Team" there means the context's real
 * members, never the `team` tier, which the pin opens to every account: so
 * `shareWithTeam` grants the note to the built-in `members` grantee, and it
 * stays private to everyone else.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { usernameOf } from "./lib/adminFns/people";
import { bugFolder, bugNotePath, renderBugNote } from "./lib/feedback/bugNote";
import { accessSourceOf } from "./lib/nodes/accessBackfill";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { setAccessRow } from "./lib/nodes/setAccess";
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

/**
 * Open one report to every real member of the context, to view, through the
 * built-in `members` grantee (`lib/nodes/rowAccess.ts`): it follows the member
 * list, so someone who joins later reads earlier reports too, and a pin reader
 * never holds it. Only where the access rows judge: a list lives on a row, so
 * elsewhere the note stays owner-only. False only for a change that was
 * refused. Granted under the first owner's name, since a list is the owner's.
 */
export const shareWithTeam = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, path }) => {
    if ((await accessSourceOf(ctx.db)) !== "rows") return true;
    const owner = (
      await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect()
    ).find((member) => member.role === "owner");
    if (owner === undefined) return false;
    const answer = await setAccessRow(ctx, {
      workspaceId,
      path,
      base: "private",
      grantees: [{ kind: "members", role: "view" }],
      actor: { userId: owner.userId, role: "owner" },
    });
    return answer.ok;
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
  ctx: Pick<ActionCtx, "runAction" | "runMutation">,
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
    // The report is filed either way; a team that cannot see it yet is a log line, not a lost report.
    if (!(await ctx.runMutation(internal.functions.bugNotes.shareWithTeam, { workspaceId, path }))) {
      console.error("bug_note_not_shared", { workspaceId });
    }
    return true;
  } catch (error) {
    // Never the report's words: only that it did not land.
    console.error("bug_note_failed", { workspaceId, code: error instanceof ConvexError ? (error.data as { code?: string })?.code : "unknown" });
    return false;
  }
}
