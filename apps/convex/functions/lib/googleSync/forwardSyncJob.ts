/**
 * The forward sync pass's job: what one pass for one Google connection is
 * allowed to do, re-asked at the moment it runs.
 *
 * Split out of `functions/googleSync.ts`, which keeps the registered
 * `googleForwardSyncJob` and wires this handler to it; this module registers
 * nothing and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import { defaultGoogleDestinationFolder, mailConnectEnabled } from "../../googleConnect";
import { calendarConnectEnabled } from "../../calendarConnect";
import { nextProductToSync, syncableProductsOf, syncBytesUsed } from "../googleSchedule";
import { REPAIR_DAYS_PER_PASS } from "./repairDays";

export const googleForwardSyncJobArgs = {
  workspaceId: v.id("workspaces"),
  connectionId: v.id("googleConnections"),
};

export const googleForwardSyncJobReturns = v.union(
  v.null(),
  v.object({ kind: v.literal("skip"), reason: v.string() }),
  v.object({
    kind: v.literal("run"),
    connectionId: v.id("googleConnections"),
    product: v.literal("gmail"),
    address: v.string(),
    mailboxSlug: v.string(),
    destinationFolder: v.string(),
    folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
    quotaBytes: v.number(),
    bytesAlreadyUsed: v.number(),
    attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
    attachmentRetentionDays: v.optional(v.union(v.number(), v.literal("forever"))),
    historyId: v.optional(v.string()),
    recentImport: v.optional(v.boolean()),
    repairDays: v.optional(v.array(v.string())),
  }),
  v.object({
    kind: v.literal("run"),
    connectionId: v.id("googleConnections"),
    product: v.literal("calendar"),
    address: v.string(),
    destinationFolder: v.string(),
    syncToken: v.optional(v.string()),
    lastFullSyncDate: v.optional(v.string()),
    contributorSourceIds: v.array(v.id("googleConnections")),
  }),
  v.object({
    kind: v.literal("run"),
    connectionId: v.id("googleConnections"),
    product: v.literal("chat"),
    address: v.string(),
    destinationFolder: v.string(),
    nonceSeed: v.string(),
    workspaceNonceSeed: v.string(),
    cursors: v.record(v.string(), v.string()),
    spaceSettings: v.record(
      v.string(),
      v.union(v.literal("included"), v.literal("excluded"), v.literal("paused")),
    ),
    contributorSourceIds: v.array(v.id("googleConnections")),
  }),
);

/**
 * What the pass is allowed to do, re-asked at the moment it runs.
 *
 * The sweep that scheduled this ran up to a few minutes ago and holds no
 * decision (see above); in that time the account can have been disconnected,
 * the product turned off, or the grant revoked. So every gate is asked here,
 * **before** `runFileOperation` opens a bucket credential — the same ordering,
 * and the same reason, as the projection pass that asks
 * `projectionTargetForWorkspace` first.
 *
 * `null` means there is no row to report against at all. `skip` means there is
 * a row, it is not to be synced, and the claim on it must still be released.
 *
 * No secret is returned. This is the settings-and-cursor view; the refresh
 * token never leaves `mintGoogleAccessToken`.
 */
export async function googleForwardSyncJobHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof googleForwardSyncJobArgs>,
) {
  const connection = await ctx.db.get(args.connectionId);
  if (connection === null) return null;
  /*
   * THE TWO ARGUMENTS HAVE TO AGREE, AND THIS IS WHERE THAT IS CHECKED.
   *
   * The pass runs inside `runFileOperation`, which opens the bucket
   * credential of the `workspaceId` it was handed, and then writes mail read
   * from the account named by `connectionId`. A mismatched pair would file
   * one context's mail into another context's bucket. Nothing constructs
   * such a pair today — the sweep reads both off one row — but "no caller
   * does that" is not a tenant boundary, and this is the one place that can
   * be one, because it is the only function that sees both.
   */
  if (connection.workspaceId !== args.workspaceId) return null;
  if (connection.disconnectedAt !== undefined) {
    return { kind: "skip" as const, reason: "GOOGLE_DISCONNECTED" };
  }
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null || workspace.kind !== "personal") {
    // A mailbox may only ever land in a personal context
    // (`identity-and-access.md`). A workspace that changed kind under a
    // connection is not a state this writes mail through.
    return { kind: "skip" as const, reason: "NOT_PERSONAL_CONTEXT" };
  }
  if (connection.health === "reconnect_required") {
    // Minting would fail against a grant Google has already refused, once
    // per pass, forever. A reconnect rewrites `health`, which is what puts
    // this connection back in the loop.
    return { kind: "skip" as const, reason: "GOOGLE_RECONNECT_REQUIRED" };
  }
  const products = syncableProductsOf(connection).filter((product) => {
    if (product === "gmail") return mailConnectEnabled() && connection.gmail !== undefined;
    if (product === "calendar") {
      return calendarConnectEnabled() && connection.calendar !== undefined;
    }
    return mailConnectEnabled() && connection.chat !== undefined;
  });
  if (products.length === 0) {
    if (
      !mailConnectEnabled() &&
      (connection.products.includes("gmail") || connection.products.includes("chat"))
    ) {
      return { kind: "skip" as const, reason: "MAIL_CONNECT_DISABLED" };
    }
    if (!calendarConnectEnabled() && connection.products.includes("calendar")) {
      return { kind: "skip" as const, reason: "CALENDAR_CONNECT_DISABLED" };
    }
    return { kind: "skip" as const, reason: "NO_SYNCABLE_PRODUCT" };
  }

  // One claim, a cursor per product: Google's pushed product first, then
  // the least-recently-synced one, so no product starves (`googleSchedule.ts`).
  const product = nextProductToSync(connection, products, Date.now());
  // Every product is waiting out a failure of its own (`retryAt`).
  if (product === undefined) return { kind: "skip" as const, reason: "GOOGLE_PRODUCT_BACKOFF" };

  if (product === "calendar") {
    const calendar = connection.calendar!;
    const destinationFolder =
      calendar.destinationFolder ?? defaultGoogleDestinationFolder("calendar", undefined);
    const workspaceConnections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(51);
    if (workspaceConnections.length > 50) {
      return { kind: "skip" as const, reason: "CALENDAR_SOURCE_LIMIT" };
    }
    const calendarContributors = workspaceConnections.filter((row) => {
      if (row.calendar === undefined) return false;
      const contributesHistory =
        (row.disconnectedAt === undefined && row.products.includes("calendar")) ||
        row.calendar.lastSyncedAt !== undefined;
      if (!contributesHistory) return false;
      const folder =
        row.calendar.destinationFolder ?? defaultGoogleDestinationFolder("calendar", undefined);
      return folder === destinationFolder;
    });
    return {
      kind: "run" as const,
      connectionId: connection._id,
      product: "calendar" as const,
      address: connection.address,
      destinationFolder,
      syncToken: calendar.syncToken,
      lastFullSyncDate: calendar.lastFullSyncDate,
      contributorSourceIds: calendarContributors.map((row) => row._id),
    };
  }

  if (product === "chat") {
    const workspaceConnections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(51);
    if (workspaceConnections.length > 50) {
      return { kind: "skip" as const, reason: "CHAT_SOURCE_LIMIT" };
    }
    // A disconnect stops provider reads; it does not delete notes already
    // written into the customer's bucket. Keep rows that can contribute now,
    // plus disconnected rows that have actually contributed before. A row
    // disconnected before its first pass has no manifest to wait on, and
    // including it turns every active Chat pass into a permanent
    // CHAT_WAITING_FOR_ACCOUNT.
    const chatContributors = workspaceConnections.filter((row) => {
      if (row.chat === undefined) return false;
      return (
        (row.disconnectedAt === undefined && row.products.includes("chat")) ||
        row.chat.lastSyncedAt !== undefined
      );
    });
    const chat = connection.chat!;
    return {
      kind: "run" as const,
      connectionId: connection._id,
      product: "chat" as const,
      address: connection.address,
      destinationFolder:
        chat.destinationFolder ?? defaultGoogleDestinationFolder("chat", undefined),
      nonceSeed: chat.nonceSeed,
      // Every writer in the same active source set must render the same
      // fence nonce. The seeds are non-credentials; sorting makes the value
      // independent of which account's pass happened to run last.
      workspaceNonceSeed: chatContributors
        .map((row) => row.chat!.nonceSeed)
        .sort()
        .join(":"),
      cursors: chat.cursors ?? {},
      spaceSettings: chat.spaceSettings ?? {},
      contributorSourceIds: chatContributors.map((row) => row._id),
    };
  }

  const gmail = connection.gmail!;
  return {
    kind: "run" as const,
    connectionId: connection._id,
    product: "gmail" as const,
    address: connection.address,
    mailboxSlug: gmail.mailboxSlug,
    destinationFolder:
      gmail.destinationFolder ?? defaultGoogleDestinationFolder("gmail", gmail.mailboxSlug),
    folders: gmail.folders,
    quotaBytes: gmail.quotaBytes,
    bytesAlreadyUsed: syncBytesUsed(connection),
    attachmentMode: gmail.attachmentMode,
    attachmentRetentionDays: gmail.attachmentRetentionDays,
    historyId: gmail.historyId,
    // Owed only where the first Gmail connect marked it; its last failed
    // attempt marks it `abandoned` (`googleConnect/recentImport.ts`).
    ...(gmail.recentImport?.status === "pending" ? { recentImport: true } : {}),
    // The window repair waits for the import, then rides the forward pass a few days at a time.
    ...(gmail.recentImport?.status !== "pending" && (gmail.repairDays?.length ?? 0) > 0
      ? { repairDays: gmail.repairDays!.slice(0, REPAIR_DAYS_PER_PASS) }
      : {}),
  };
}
