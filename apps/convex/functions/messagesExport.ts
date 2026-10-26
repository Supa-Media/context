/**
 * The Messages backup in its owner's Download as folders: the texts, one
 * Markdown file per conversation per month under `Messages/`, rendered in the
 * console from the log this reads (`packages/communications/src/backupTranscript.js`;
 * `docs/decisions/communications/messages-backup.md`).
 *
 * Owner only, as the backup is: anyone else's whole-workspace download is the
 * one it always was. Only the texts travel this way; the pictures are too
 * large for a page an action answers and a zip the browser holds.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import type { MessagesLogPage } from "./lib/messagesBackup/exportLog";

const pageValidator = v.object({
  objects: v.array(v.object({ key: v.string(), text: v.string() })),
  next: v.union(v.null(), v.string()),
});

/** One page of the backup's log, after `after`; an empty, finished page for anyone but an owner. */
export const readLogForExport = action({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: pageValidator,
  handler: async (ctx, { workspaceId, after }): Promise<typeof pageValidator.type> => {
    const actorUserId = await callerId(ctx);
    try {
      await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId, workspaceId, minimum: "owner" });
    } catch (error) {
      if (error instanceof ConvexError) return { objects: [], next: null };
      throw error;
    }
    const page = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "readMessagesLog", ...(after === undefined ? {} : { after }) },
    })) as MessagesLogPage;
    return { objects: page.objects, next: page.next };
  },
});
