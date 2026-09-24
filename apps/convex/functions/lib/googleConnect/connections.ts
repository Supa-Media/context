/**
 * The connections a workspace has: the mailbox slugs already taken, and the
 * console's view of every Google connection.
 *
 * Split out of `functions/googleConnect.ts`, which keeps every registered
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

// The scheduling half of a connection is the loop's (`googleSync.ts`), and the
// console reads both halves off one row. The view is imported from the leaf
// both files share rather than from the loop itself: importing the loop here
// would close a cycle, and a cycle in this module graph surfaces as an export
// that is sometimes missing rather than as an error.
import { syncStatusOf } from "../googleSchedule";
import { destinationPattern } from "../../../../../packages/communications/src/destination.js";
import { defaultGoogleDestinationFolder } from "./validation";

export const listMailboxSlugsArgs = { workspaceId: v.id("workspaces") };

export const listMailboxSlugsReturns = v.array(v.string());

/**
 * Every mailbox slug already used in this workspace, so a newly connected
 * one can be disambiguated at the moment it is chosen rather than colliding
 * silently. Reads across every `googleConnections` row regardless of which
 * products it carries — a slug is a Gmail-folder fact, so only rows with a
 * `gmail` object contribute one. Excludes disconnected connections' slugs —
 * deliberately not: a disconnected mailbox's notes are still sitting in that
 * folder (`disconnectGoogleConnection` never deletes them), so its slug stays
 * taken until the person deletes the folder themselves.
 */
export async function listMailboxSlugsHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listMailboxSlugsArgs>,
) {
  const rows = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  return rows.flatMap((row) => (row.gmail ? [row.gmail.mailboxSlug] : []));
}

export const listGoogleConnectionsArgs = { workspaceId: v.id("workspaces") };

export const listGoogleConnectionsReturns = v.array(
  v.object({
    connectionId: v.id("googleConnections"),
    email: v.string(),
    syncServices: v.object({ gmail: v.boolean(), calendar: v.boolean(), chat: v.boolean() }),
    syncStatus: v.string(),
    lastSyncStartedAt: v.optional(v.number()),
    lastSyncCompletedAt: v.optional(v.number()),
    /**
     * THE ANSWER TO "IS THIS THING ACTUALLY RUNNING?"
     *
     * `syncStatus` above is the connection's health, which a freshly
     * connected account and a happily syncing one both report as fine —
     * which is exactly how a mailbox that never synced once looked identical
     * to one working. These five fields are the difference: how often it is
     * polled, whether it has *ever* read mail, when it is next due, and what
     * went wrong last, kept after a later pass succeeded.
     */
    sync: v.object({
      intervalMinutes: v.number(),
      everSynced: v.boolean(),
      /** A cursor exists, so new mail will be read — which is not the same as having read any. */
      cursorReady: v.boolean(),
      /** The last pass ran out of history pages and there is more to drain. */
      catchingUp: v.boolean(),
      lastAttemptAt: v.optional(v.number()),
      nextDueAt: v.optional(v.number()),
      lastFailureAt: v.optional(v.number()),
      lastFailureCode: v.optional(v.string()),
      lastFailure: v.optional(v.string()),
    }),
    errorCode: v.optional(v.string()),
    lastError: v.optional(v.string()),
    gmail: v.optional(
      v.object({
        backfillDays: v.number(),
        folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
        destinationFolder: v.string(),
        destinationPath: v.string(),
        historyCursorReady: v.boolean(),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    calendar: v.optional(
      v.object({
        destinationFolder: v.string(),
        destinationPath: v.string(),
        syncCursorReady: v.boolean(),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    chat: v.optional(
      v.object({
        destinationFolder: v.string(),
        destinationPath: v.string(),
        cursorCount: v.number(),
        lastSyncedAt: v.optional(v.number()),
      }),
    ),
    syncRun: v.optional(
      v.object({
        runId: v.id("googleSyncRuns"),
        mode: v.literal("backfill"),
        services: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
        status: v.union(
          v.literal("queued"),
          v.literal("running"),
          v.literal("complete"),
          v.literal("failed"),
        ),
        requestedBackfillDays: v.number(),
        totalUnits: v.number(),
        completedUnits: v.number(),
        itemsFound: v.optional(v.number()),
        daysWithMail: v.optional(v.number()),
        bytesWritten: v.optional(v.number()),
        currentService: v.optional(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
        currentUnit: v.optional(v.string()),
        startedAt: v.optional(v.number()),
        completedAt: v.optional(v.number()),
        errorCode: v.optional(v.string()),
        lastError: v.optional(v.string()),
      }),
    ),
    disconnectedAt: v.optional(v.number()),
  }),
);

export async function listGoogleConnectionsHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listGoogleConnectionsArgs>,
) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return [];
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null || workspace.kind !== "personal") return [];
  const membership = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("userId", userId),
    )
    .unique();
  if (membership?.role !== "owner") return [];

  const rows = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  const out = [];
  for (const row of rows) {
    const gmail = row.products.includes("gmail") ? row.gmail : undefined;
    const calendar = row.products.includes("calendar") ? row.calendar : undefined;
    const chat = row.products.includes("chat") ? row.chat : undefined;
    const lastSyncCompletedAt = Math.max(
      gmail?.lastSyncedAt ?? 0,
      calendar?.lastSyncedAt ?? 0,
      chat?.lastSyncedAt ?? 0,
    );
    const gmailDestinationFolder = gmail
      ? (gmail.destinationFolder ?? defaultGoogleDestinationFolder("gmail", gmail.mailboxSlug))
      : undefined;
    const calendarDestinationFolder = calendar
      ? (calendar.destinationFolder ?? defaultGoogleDestinationFolder("calendar", undefined))
      : undefined;
    const chatDestinationFolder = chat
      ? (chat.destinationFolder ?? defaultGoogleDestinationFolder("chat", undefined))
      : undefined;
    const latestRun = await ctx.db
      .query("googleSyncRuns")
      .withIndex("by_connection_created", (q) => q.eq("connectionId", row._id))
      .order("desc")
      .first();
    const visibleLatestRun =
      latestRun?.errorCode === "GOOGLE_GMAIL_BACKFILL_DISABLED" ? null : latestRun;
    out.push({
      connectionId: row._id,
      email: row.address,
      sync: syncStatusOf(row),
      syncServices: {
        gmail: gmail !== undefined,
        calendar: calendar !== undefined,
        chat: chat !== undefined,
      },
      syncStatus:
        row.disconnectedAt !== undefined
          ? "disconnected"
          : row.health === "backfilling" &&
              (visibleLatestRun === null ||
                (visibleLatestRun.status !== "queued" && visibleLatestRun.status !== "running"))
            ? "connected"
            : row.health,
      lastSyncCompletedAt: lastSyncCompletedAt === 0 ? undefined : lastSyncCompletedAt,
      errorCode: row.errorCode,
      lastError: row.lastError,
      gmail: gmail
        ? {
            backfillDays: gmail.backfillDays,
            folders: gmail.folders,
            destinationFolder: gmailDestinationFolder!,
            destinationPath: destinationPattern(gmailDestinationFolder!),
            historyCursorReady: gmail.historyId !== undefined,
            lastSyncedAt: gmail.lastSyncedAt,
          }
        : undefined,
      calendar: calendar
        ? {
            destinationFolder: calendarDestinationFolder!,
            destinationPath: destinationPattern(calendarDestinationFolder!),
            syncCursorReady: calendar.syncToken !== undefined,
            lastSyncedAt: calendar.lastSyncedAt,
          }
        : undefined,
      chat: chat
        ? {
            destinationFolder: chatDestinationFolder!,
            destinationPath: destinationPattern(chatDestinationFolder!),
            cursorCount: Object.keys(chat.cursors ?? {}).length,
            lastSyncedAt: chat.lastSyncedAt,
          }
        : undefined,
      syncRun: visibleLatestRun
        ? {
            runId: visibleLatestRun._id,
            mode: visibleLatestRun.mode,
            services: visibleLatestRun.services,
            status: visibleLatestRun.status,
            requestedBackfillDays: visibleLatestRun.requestedBackfillDays,
            totalUnits: visibleLatestRun.totalUnits,
            completedUnits: visibleLatestRun.completedUnits,
            itemsFound: visibleLatestRun.itemsFound,
            daysWithMail: visibleLatestRun.daysWithMail,
            bytesWritten: visibleLatestRun.bytesWritten,
            currentService: visibleLatestRun.currentService,
            currentUnit: visibleLatestRun.currentUnit,
            startedAt: visibleLatestRun.startedAt,
            completedAt: visibleLatestRun.completedAt,
            errorCode: visibleLatestRun.errorCode,
            lastError: visibleLatestRun.lastError,
          }
        : undefined,
      disconnectedAt: row.disconnectedAt,
    });
  }
  return out;
}
