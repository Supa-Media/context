/**
 * A Gmail backfill run's rows: stopping one, what the next pass should fetch,
 * recording a pass, and failing a run.
 *
 * Split out of `functions/googleConnect.ts`, which keeps every registered
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { defaultGoogleDestinationFolder } from "./validation";

export const stopGoogleGmailBackfillRunArgs = {
  workspaceId: v.id("workspaces"),
  runId: v.id("googleSyncRuns"),
  errorCode: v.string(),
  message: v.string(),
};

export const stopGoogleGmailBackfillRunReturns = v.null();

export async function stopGoogleGmailBackfillRunHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof stopGoogleGmailBackfillRunArgs>,
) {
  const run = await ctx.db.get(args.runId);
  if (
    run === null ||
    run.workspaceId !== args.workspaceId ||
    run.mode !== "backfill" ||
    !run.services.includes("gmail") ||
    (run.status !== "queued" && run.status !== "running")
  ) {
    return null;
  }
  const now = Date.now();
  await ctx.db.patch(args.runId, {
    status: "failed" as const,
    currentService: "gmail" as const,
    completedAt: now,
    lastError: args.message.slice(0, 240),
    errorCode: args.errorCode,
    updatedAt: now,
  });
  const connection = await ctx.db.get(run.connectionId);
  if (
    connection !== null &&
    connection.workspaceId === args.workspaceId &&
    connection.disconnectedAt === undefined
  ) {
    await ctx.db.patch(connection._id, {
      health: connection.gmail?.historyId ? ("active" as const) : ("backfilling" as const),
      lastError: undefined,
      errorCode: undefined,
      updatedAt: now,
    });
  }
  return null;
}

export const googleGmailBackfillForRunArgs = { workspaceId: v.id("workspaces"), runId: v.id("googleSyncRuns") };

export const googleGmailBackfillForRunReturns = v.union(
  v.null(),
  v.object({
    runId: v.id("googleSyncRuns"),
    connectionId: v.id("googleConnections"),
    requestedBackfillDays: v.number(),
    createdAt: v.number(),
    totalUnits: v.number(),
    completedUnits: v.number(),
    bytesWritten: v.number(),
    transientFailures: v.number(),
    address: v.string(),
    mailboxSlug: v.string(),
    destinationFolder: v.string(),
    folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
    quotaBytes: v.number(),
    attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
    attachmentRetentionDays: v.optional(v.union(v.number(), v.literal("forever"))),
  }),
);

export async function googleGmailBackfillForRunHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof googleGmailBackfillForRunArgs>,
) {
  const run = await ctx.db.get(args.runId);
  if (
    run === null ||
    run.workspaceId !== args.workspaceId ||
    run.mode !== "backfill" ||
    !run.services.includes("gmail") ||
    (run.status !== "queued" && run.status !== "running")
  ) {
    return null;
  }
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null || workspace.kind !== "personal") return null;
  const connection = await ctx.db.get(run.connectionId);
  if (
    connection === null ||
    connection.workspaceId !== args.workspaceId ||
    connection.disconnectedAt !== undefined ||
    !connection.gmail
  ) {
    return null;
  }
  return {
    runId: run._id,
    connectionId: connection._id,
    requestedBackfillDays: run.requestedBackfillDays,
    createdAt: run.createdAt,
    totalUnits: run.totalUnits,
    completedUnits: run.completedUnits,
    bytesWritten: run.bytesWritten ?? 0,
    transientFailures: run.transientFailures ?? 0,
    address: connection.address,
    mailboxSlug: connection.gmail.mailboxSlug,
    destinationFolder:
      run.destinationFolder ??
      connection.gmail.destinationFolder ??
      defaultGoogleDestinationFolder("gmail", connection.gmail.mailboxSlug),
    folders: connection.gmail.folders,
    quotaBytes: connection.gmail.quotaBytes,
    attachmentMode: connection.gmail.attachmentMode,
    attachmentRetentionDays: connection.gmail.attachmentRetentionDays,
  };
}

export const recordGoogleGmailBackfillPassArgs = {
  runId: v.id("googleSyncRuns"),
  connectionId: v.id("googleConnections"),
  fromUnit: v.number(),
  toUnit: v.number(),
  totalUnits: v.number(),
  itemsFound: v.number(),
  daysWithMail: v.number(),
  bytesWritten: v.number(),
  currentUnit: v.optional(v.string()),
  status: v.union(v.literal("running"), v.literal("complete"), v.literal("failed")),
  historyId: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  error: v.optional(v.string()),
  transientFailures: v.optional(v.number()),
};

export const recordGoogleGmailBackfillPassReturns = v.object({ accepted: v.boolean(), complete: v.boolean() });

export async function recordGoogleGmailBackfillPassHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordGoogleGmailBackfillPassArgs>,
) {
  const run = await ctx.db.get(args.runId);
  if (run === null || run.connectionId !== args.connectionId) {
    return { accepted: false, complete: false };
  }
  const connection = await ctx.db.get(args.connectionId);
  if (connection === null || connection.disconnectedAt !== undefined || !connection.gmail) {
    return { accepted: false, complete: false };
  }
  const now = Date.now();
  if (run.status !== "queued" && run.status !== "running") {
    return { accepted: false, complete: run.status === "complete" };
  }
  if (run.completedUnits !== args.fromUnit) {
    return { accepted: false, complete: false };
  }

  const completedUnits = Math.min(args.totalUnits, Math.max(run.completedUnits, args.toUnit));
  const itemsFound = (run.itemsFound ?? 0) + args.itemsFound;
  const daysWithMail = (run.daysWithMail ?? 0) + args.daysWithMail;
  const bytesWritten = (run.bytesWritten ?? 0) + args.bytesWritten;
  const error = args.error?.slice(0, 240);

  if (args.status === "failed") {
    await ctx.db.patch(args.runId, {
      status: "failed" as const,
      completedUnits,
      totalUnits: args.totalUnits,
      itemsFound,
      daysWithMail,
      bytesWritten,
      currentService: "gmail" as const,
      currentUnit: args.currentUnit,
      completedAt: now,
      lastError: error ?? "Gmail backfill stopped before it finished.",
      errorCode: args.errorCode ?? "GOOGLE_SYNC_FAILED",
      transientFailures: args.transientFailures,
      updatedAt: now,
    });
    await ctx.db.patch(args.connectionId, {
      health: "error" as const,
      lastError: error ?? "Gmail backfill stopped before it finished.",
      errorCode: args.errorCode ?? "GOOGLE_SYNC_FAILED",
      updatedAt: now,
    });
    return { accepted: true, complete: false };
  }

  if (args.status === "complete") {
    const gmail = {
      ...connection.gmail,
      historyId: args.historyId ?? connection.gmail.historyId,
      lastSyncedAt: now,
    };
    const calendarReady = !connection.products.includes("calendar") || connection.calendar?.syncToken !== undefined;
    const chatReady = !connection.products.includes("chat") || Object.keys(connection.chat?.cursors ?? {}).length > 0;
    await ctx.db.patch(args.runId, {
      status: "complete" as const,
      completedUnits,
      totalUnits: args.totalUnits,
      itemsFound,
      daysWithMail,
      bytesWritten,
      currentService: undefined,
      currentUnit: undefined,
      completedAt: now,
      lastError: undefined,
      errorCode: undefined,
      transientFailures: undefined,
      updatedAt: now,
    });
    await ctx.db.patch(args.connectionId, {
      gmail,
      health: calendarReady && chatReady ? ("active" as const) : ("backfilling" as const),
      lastError: undefined,
      errorCode: undefined,
      updatedAt: now,
    });
    return { accepted: true, complete: true };
  }

  await ctx.db.patch(args.runId, {
    status: "running" as const,
    startedAt: run.startedAt ?? now,
    completedUnits,
    totalUnits: args.totalUnits,
    itemsFound,
    daysWithMail,
    bytesWritten,
    currentService: "gmail" as const,
    currentUnit: args.currentUnit,
    lastError: error,
    errorCode: args.errorCode,
    transientFailures: error ? args.transientFailures : undefined,
    updatedAt: now,
  });
  return { accepted: true, complete: false };
}

export const failGoogleGmailBackfillRunArgs = {
  workspaceId: v.id("workspaces"),
  runId: v.id("googleSyncRuns"),
  errorCode: v.string(),
  error: v.string(),
};

export const failGoogleGmailBackfillRunReturns = v.null();

export async function failGoogleGmailBackfillRunHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof failGoogleGmailBackfillRunArgs>,
) {
  const run = await ctx.db.get(args.runId);
  if (
    run === null ||
    run.workspaceId !== args.workspaceId ||
    run.mode !== "backfill" ||
    !run.services.includes("gmail") ||
    (run.status !== "queued" && run.status !== "running")
  ) {
    return null;
  }
  const now = Date.now();
  const error = args.error.slice(0, 240);
  await ctx.db.patch(args.runId, {
    status: "failed" as const,
    currentService: "gmail" as const,
    completedAt: now,
    lastError: error,
    errorCode: args.errorCode,
    updatedAt: now,
  });
  const connection = await ctx.db.get(run.connectionId);
  if (
    connection !== null &&
    connection.workspaceId === args.workspaceId &&
    connection.disconnectedAt === undefined
  ) {
    await ctx.db.patch(connection._id, {
      health: "error" as const,
      lastError: error,
      errorCode: args.errorCode,
      updatedAt: now,
    });
  }
  return null;
}
