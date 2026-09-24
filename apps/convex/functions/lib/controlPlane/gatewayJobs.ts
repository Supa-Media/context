/**
 * Work the gateway queues for itself: the job row's shape, creating and
 * claiming one, and the report it files when done. Opening one — which reads
 * the binding and keys — stays in `functions/controlPlane.ts`.
 *
 * Split out of `functions/controlPlane.ts`, which keeps every registered
 * function and wires these handlers to them; this module registers none. It is on the gateway's path,
 * so `scripts/check-exit-is-ungated.mjs` scans it exactly as it scans that
 * file.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { TOKEN_HASH_PATTERN } from "../crypto";
import { getMembership } from "../workspaceAuth";
import { contextsForGrant, resolveLiveGrant } from "./liveGrants";
import { gatewayOwnerClearance } from "./session";
import type {
  GatewayBinding,
  GatewayEncryptionKey,
  GatewayKeyRotation,
  GatewaySearchIndex,
} from "./bindingShapes";

export const GATEWAY_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GATEWAY_JOB_LEASE_MS = 15 * 60 * 1000;
export const GATEWAY_JOB_ERROR_MAX = 240;
export const MOVE_ID_PATTERN = /^move-[a-f0-9-]{12,}$/;

export const gatewayJobKindValidator = v.union(v.literal("materialize_move"));
export type GatewayJobKind = "materialize_move";

export interface ClaimedGatewayJob {
  workspaceId: Id<"workspaces">;
  actorUserId: Id<"users">;
  actorClientId: string;
  grantId: Id<"oauthGrants">;
  kind: GatewayJobKind;
  moveId?: string;
}

export interface OpenedGatewayJob {
  job: ClaimedGatewayJob;
  binding: GatewayBinding;
  searchIndex?: GatewaySearchIndex;
  encryptionKey?: GatewayEncryptionKey;
  rotation?: GatewayKeyRotation;
}

export function gatewayJobError(message: string | undefined): string | undefined {
  if (typeof message !== "string" || message.length === 0) return undefined;
  return message.slice(0, GATEWAY_JOB_ERROR_MAX);
}

export const createGatewayJobArgs = {
  hashedAccessToken: v.string(),
  expectedWorkspaceId: v.string(),
  hashedTicket: v.string(),
  kind: gatewayJobKindValidator,
  moveId: v.optional(v.string()),
};

export const createGatewayJobReturns = v.boolean();

export async function createGatewayJobHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof createGatewayJobArgs>,
) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return false;
  if (!TOKEN_HASH_PATTERN.test(args.hashedTicket)) return false;
  if (args.kind === "materialize_move" && !MOVE_ID_PATTERN.test(args.moveId || "")) return false;

  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null) return false;
  const workspaceId = gatewayOwnerClearance(
    {
      scopes: live.grant.scopes,
      workspaceId: live.grant.workspaceId,
      workspaces: await contextsForGrant(ctx, live),
    },
    args.expectedWorkspaceId,
  );
  if (workspaceId === null) return false;

  const now = Date.now();
  await ctx.db.insert("gatewayJobs", {
    hashedTicket: args.hashedTicket,
    workspaceId,
    actorUserId: live.grant.userId,
    actorClientId: live.grant.clientId,
    grantId: live.grant._id,
    kind: args.kind,
    moveId: args.moveId,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + GATEWAY_JOB_TTL_MS,
  });
  return true;
}

export const claimGatewayJobArgs = { hashedTicket: v.string() };

export const claimGatewayJobReturns = v.union(
  v.null(),
  v.object({
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    actorClientId: v.string(),
    grantId: v.id("oauthGrants"),
    kind: gatewayJobKindValidator,
    moveId: v.optional(v.string()),
  }),
);

export async function claimGatewayJobHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof claimGatewayJobArgs>,
) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedTicket)) return null;
  const job = await ctx.db
    .query("gatewayJobs")
    .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", args.hashedTicket))
    .unique();
  if (job === null) return null;
  if (job.expiresAt <= Date.now()) return null;
  const now = Date.now();
  const staleLease =
    job.status === "running" &&
    typeof job.leasedAt === "number" &&
    job.leasedAt + GATEWAY_JOB_LEASE_MS <= now;
  if (job.status !== "queued" && !staleLease) return null;
  const membership = await getMembership(ctx, job.workspaceId, job.actorUserId);
  if (membership === null || membership.role !== "owner") return null;
  await ctx.db.patch(job._id, {
    status: "running",
    attempts: job.attempts + 1,
    leasedAt: now,
    updatedAt: now,
    lastError: undefined,
  });
  return {
    workspaceId: job.workspaceId,
    actorUserId: job.actorUserId,
    actorClientId: job.actorClientId,
    grantId: job.grantId,
    kind: job.kind,
    moveId: job.moveId,
  };
}

export const reportGatewayJobArgs = {
  hashedTicket: v.string(),
  result: v.object({
    status: v.union(v.literal("queued"), v.literal("complete"), v.literal("failed")),
    error: v.optional(v.string()),
    progress: v.optional(
      v.object({
        phase: v.union(v.literal("copying"), v.literal("deleting")),
        completed: v.number(),
        total: v.number(),
      }),
    ),
  }),
};

export const reportGatewayJobReturns = v.boolean();

export async function reportGatewayJobHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof reportGatewayJobArgs>,
) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedTicket)) return false;
  const job = await ctx.db
    .query("gatewayJobs")
    .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", args.hashedTicket))
    .unique();
  if (job === null) return false;
  if (job.status !== "running") return false;
  const progress = args.result.progress;
  const validProgress =
    progress !== undefined &&
    Number.isInteger(progress.completed) &&
    Number.isInteger(progress.total) &&
    progress.completed >= 0 &&
    progress.total > 0 &&
    progress.completed <= progress.total;
  await ctx.db.patch(job._id, {
    status: args.result.status,
    updatedAt: Date.now(),
    completedAt: args.result.status === "complete" ? Date.now() : undefined,
    lastError: gatewayJobError(args.result.error),
    ...(validProgress
      ? {
          progressPhase: progress.phase,
          progressCompleted: progress.completed,
          progressTotal: progress.total,
        }
      : {}),
  });
  return true;
}
