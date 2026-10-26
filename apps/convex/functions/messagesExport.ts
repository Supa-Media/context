/**
 * The Messages backup, from the console, for its owner
 * (`docs/decisions/communications/messages-backup.md`):
 *
 *  - in their Download as folders: the texts, one Markdown file per
 *    conversation per month under `Messages/`, rendered in the console from
 *    the log this reads (`packages/communications/src/backupTranscript.js`).
 *    Only the texts travel this way; the pictures are too large for a page an
 *    action answers and a zip the browser holds.
 *  - Delete the backup: every key under `.context/messages/imessage/`, a page
 *    at a time, then the texts index in the context's search database, which
 *    is rebuilt from those keys and so goes last.
 *
 * Owner only, as the backup is: anyone else's download is the one it always
 * was, and anyone else is refused the delete.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalAction, internalMutation } from "../_generated/server";
import { TEXTS_STATE, TEXTS_STATEMENTS } from "../../mcp/src/communications/textsIndex.js";
import { recordAudit } from "./lib/audit";
import { searchDatabaseClient } from "./lib/fastSearchFns/client";
import { callerId } from "./lib/filesFns/access";
import type { MessagesErasedPage, MessagesLogPage, MessagesReadsPage } from "./lib/messagesBackup/exportLog";

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

/**
 * Delete the backup, for good: the owner has asked twice on Settings ›
 * Messages. Recorded in the audit trail under their name, then erased in the
 * background, a page at a time.
 */
export const deleteBackup = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    const actorUserId = await callerId(ctx);
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId, workspaceId, minimum: "owner" });
    await ctx.runMutation(internal.functions.messagesExport.recordDeleteAsked, { workspaceId, actorUserId });
    await ctx.scheduler.runAfter(0, internal.functions.messagesExport.eraseBackupPage, { workspaceId });
    return null;
  },
});

export const recordDeleteAsked = internalMutation({
  args: { workspaceId: v.id("workspaces"), actorUserId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { workspaceId, actorUserId }) => {
    await recordAudit(ctx, { workspaceId, actorUserId, action: "file.delete", paths: [], details: { messagesBackup: true } });
    return null;
  },
});

/** The index's rows go once the keys they are rebuilt from have. */
export const TEXTS_ERASE_STATEMENTS: readonly { sql: string; params?: unknown[] }[] = [
  ...TEXTS_STATEMENTS.map((sql: string) => ({ sql })),
  { sql: "DELETE FROM texts_records" },
  { sql: "DELETE FROM texts_fts" },
  { sql: "DELETE FROM index_state WHERE key IN (?, ?)", params: [TEXTS_STATE.ready, TEXTS_STATE.walkAfter] },
];

/** Times a page that failed (a bucket or database down) is tried again, a minute and then longer apart. */
export const ERASE_ATTEMPTS = 6;

/** One page of the erasing; the next is scheduled until nothing under the backup is left, then the index is emptied. */
export const eraseBackupPage = internalAction({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, after, attempt = 0 }): Promise<null> => {
    try {
      const page = (await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId,
        scope: "private",
        operation: { kind: "eraseMessagesBackup", ...(after === undefined ? {} : { after }) },
      })) as MessagesErasedPage;
      if (page.next !== null) {
        await ctx.scheduler.runAfter(0, internal.functions.messagesExport.eraseBackupPage, { workspaceId, after: page.next });
        return null;
      }
      const target = await ctx.runQuery(internal.functions.fastSearch.projectionTargetForWorkspace, { workspaceId });
      const client = target === null ? null : await searchDatabaseClient(ctx, target);
      if (client !== null) await client.runAll(TEXTS_ERASE_STATEMENTS);
    } catch {
      // Never left half done in silence: the same page again, later. Idempotent, so a page that did land is passed over.
      if (attempt + 1 < ERASE_ATTEMPTS) {
        await ctx.scheduler.runAfter(60_000 * 2 ** attempt, internal.functions.messagesExport.eraseBackupPage, { workspaceId, ...(after === undefined ? {} : { after }), attempt: attempt + 1 });
      } else {
        console.error(JSON.stringify({ event: "messages_backup_erase_failed", workspaceId }));
      }
    }
    return null;
  },
});

const readValidator = v.object({ at: v.number(), who: v.string(), how: v.string() });

/** Who read the backup lately, newest first, for Settings › Messages › Who reads them; nothing for anyone but the owner. */
export const recentReads = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(readValidator),
  handler: async (ctx, { workspaceId }): Promise<(typeof readValidator.type)[]> => {
    const actorUserId = await callerId(ctx);
    try {
      await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId, workspaceId, minimum: "owner" });
    } catch (error) {
      if (error instanceof ConvexError) return [];
      throw error;
    }
    const page = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "readMessagesReads" },
    })) as MessagesReadsPage;
    return page.reads;
  },
});
