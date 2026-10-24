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
 * the pin can read it: a report a pin reader could open would hand one
 * person's texts to every account. Checked before the write, never after, at
 * the clearance every pin reader holds (`lib/pinnedReaders.ts`), and refused
 * rather than written when the folder has been opened to All Context users.
 *
 * The team reads every report (decided by the owner, 2026-10-19: "bug reports
 * should be team accessible"). `team` there means the context's real members,
 * as everywhere, so `shareWithTeam` sets the note's base to `team` and gives
 * it no `accounts` grant. Until the pinned workspace's migration has run a pin
 * reader still reads `team` (`functions/pinnedAccounts.ts`), so until then the
 * note is granted to the built-in `members` grantee at base `private`, which
 * a pin reader never holds, as it was on 2026-10-19.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type ActionCtx } from "../_generated/server";
import { usernameOf } from "./lib/adminFns/people";
import { TEXTS_CLIENT_ID } from "./lib/feedback/agentReport";
import { bugFolder, bugNotePath, renderBugNote } from "./lib/feedback/bugNote";
import { folderJobsOf } from "./lib/nodes/folderJobs";
import { setAccessRow } from "./lib/nodes/setAccess";
import { recordAudit } from "./lib/audit";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { guestNamesIn, pinReadersAreGuests } from "./lib/pinnedReaders";
import { getMembership } from "./lib/workspaceAuth";

export const destination = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      folder: v.string(),
      handle: v.union(v.string(), v.null()),
      team: v.boolean(),
      pinReaders: v.array(v.string()),
    }),
  ),
  handler: async (ctx, { userId }) => {
    const pinned = await pinnedContextWorkspace(ctx);
    if (pinned === null) return null;
    const team = (await getMembership(ctx, pinned._id, userId)) !== null;
    const areas = (await folderJobsOf(ctx.db, pinned._id)).jobs.areas ?? null;
    return {
      workspaceId: pinned._id,
      folder: bugFolder(areas, team),
      handle: await usernameOf(ctx, userId),
      team,
      // What every pin reader holds there: the clearance the report must stay out of (`fileBugNote`).
      pinReaders: await guestNamesIn(ctx, pinned._id),
    };
  },
});

/**
 * Open one report to every real member of the context, to view: base `team`,
 * which follows the member list, so someone who joins later reads earlier
 * reports too, and which a pin reader never reads (`lib/pinnedReaders.ts`).
 * Before the migration, base `private` and the built-in `members` grantee
 * instead (see the module comment). Only where the access rows judge:
 * elsewhere the note stays owner-only. False only for a change that was
 * refused. Made under the first owner's name, since a note's access is the
 * owner's, and audited as Tex acting under it rather than as their own hand.
 */
export const shareWithTeam = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, path }) => {
    const owner = (
      await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect()
    ).find((member) => member.role === "owner");
    if (owner === undefined) return false;
    const actor = { userId: owner.userId, role: "owner" as const, clientId: TEXTS_CLIENT_ID };
    if (!(await pinReadersAreGuests(ctx.db))) {
      const legacy = await setAccessRow(ctx, { workspaceId, path, base: "private", grantees: [{ kind: "members", role: "view" }], actor });
      return legacy.ok;
    }
    const answer = await setAccessRow(ctx, { workspaceId, path, base: "team", grantees: [], actor });
    if (!answer.ok) return false;
    // A base is not a list, so `setAccessRow` records nothing for it; the trail still says Tex opened this one.
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: actor.userId,
      actorClientId: actor.clientId,
      action: "access.base",
      details: { nodeId: String(row?._id ?? ""), base: "team" },
    });
    return true;
  },
});

export interface BugDestination {
  workspaceId: Id<"workspaces">;
  folder: string;
  handle: string | null;
  team: boolean;
  /** The names every pin reader holds there (`guestNamesIn`); `[]` before the migration, when they read `team`. */
  pinReaders: string[];
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
  return await fileTeamNote(ctx, where, path, renderBugNote({ ...report, handle: where.handle, team: where.team }), "bug_note");
}

/**
 * Write a note into the pinned context that the team reads and nobody reaching
 * it through the pin does: a bug report, or Tex's review of a conversation
 * (`texReviews.ts`). Checked before the write, never after, at the clearance
 * every pin reader holds, and refused (false, nothing written) when the path
 * is readable through the pin. `log` names the kind in the error lines, which
 * never carry the note's words.
 */
export async function fileTeamNote(
  ctx: Pick<ActionCtx, "runAction" | "runMutation">,
  where: Pick<BugDestination, "workspaceId" | "pinReaders">,
  path: string,
  text: string,
  log: string,
): Promise<boolean> {
  const workspaceId: Id<"workspaces"> = where.workspaceId;
  try {
    // As a pin reader sees it: a guest's names and rules once they read as guests, plain `team` before.
    const seen = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "team",
      grantedNames: where.pinReaders,
      operation: { kind: "visiblePaths", paths: [path] },
    });
    if (seen.kind !== "visiblePaths" || seen.paths.length > 0) {
      console.error(`${log}_folder_not_private`, { workspaceId });
      return false;
    }
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      actorName: null,
      operation: { kind: "write", path, text },
    });
    // The note is filed either way; a team that cannot see it yet is a log line, not a lost note.
    // Its own catch: outside one, a throw here is read as "not sent", which releases the person's
    // budget and asks them to send the same texts again, though the note already holds them.
    try {
      if (!(await ctx.runMutation(internal.functions.bugNotes.shareWithTeam, { workspaceId, path }))) {
        console.error(`${log}_not_shared`, { workspaceId });
      }
    } catch (error) {
      console.error(`${log}_not_shared`, { workspaceId, code: error instanceof ConvexError ? (error.data as { code?: string })?.code : "unknown" });
    }
    return true;
  } catch (error) {
    // Never the note's words: only that it did not land.
    console.error(`${log}_failed`, { workspaceId, code: error instanceof ConvexError ? (error.data as { code?: string })?.code : "unknown" });
    return false;
  }
}
