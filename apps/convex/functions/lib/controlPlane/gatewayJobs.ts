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
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { TOKEN_HASH_PATTERN } from "../crypto";
import { getMembership } from "../workspaceAuth";
import { contextsForGrant, resolveLiveGrant, validateLiveGrantRecord } from "./liveGrants";
import { gatewayEditorClearance, gatewayOwnerClearance } from "./session";
import type {
  GatewayBinding,
  GatewayEncryptionKey,
  GatewayKeyRotation,
  GatewayMeaningIndex,
  GatewaySearchIndex,
} from "./bindingShapes";

export const GATEWAY_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const GATEWAY_JOB_LEASE_MS = 15 * 60 * 1000;
export const GATEWAY_JOB_ERROR_MAX = 240;
export const MOVE_ID_PATTERN = /^move-[a-f0-9-]{12,}$/;

/*
 * An image upload (`apps/mcp/src/notes/imageUploads.js`): an agent that has a
 * picture as a file, not as text, asks `write_note` for a ticket and sends the
 * bytes with a plain HTTP PUT. The row is the ticket. It names the exact bytes
 * (their SHA-256 and length) it will take, so whoever holds the ticket can put
 * those bytes and nothing else, once, within ten minutes, into the opaque image
 * store of the one context it was minted for, and only while the grant that
 * minted it is still live and its person can still write there.
 */
export const IMAGE_UPLOAD_TTL_MS = 10 * 60 * 1000;
/** `MAX_REMOTE_IMAGE_BYTES` in `packages/shared/src/remoteImage.cjs`, the ceiling every other way in has. */
export const IMAGE_UPLOAD_MAX_BYTES = 5_000_000;
export const IMAGE_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const gatewayJobKindValidator = v.union(v.literal("materialize_move"), v.literal("image_upload"));
export type GatewayJobKind = "materialize_move" | "image_upload";

export interface ClaimedGatewayJob {
  workspaceId: Id<"workspaces">;
  actorUserId: Id<"users">;
  actorClientId: string;
  grantId: Id<"oauthGrants">;
  kind: GatewayJobKind;
  moveId?: string;
  imageSha256?: string;
  imageBytes?: number;
}

/** A redelivered Queue message must wait for the running pass's lease. */
export interface LeasedGatewayJob {
  retryAfterMs: number;
}

export interface OpenedGatewayJob {
  job: ClaimedGatewayJob;
  binding: GatewayBinding;
  searchIndex?: GatewaySearchIndex;
  meaningIndex?: GatewayMeaningIndex;
  encryptionKey?: GatewayEncryptionKey;
  rotation?: GatewayKeyRotation;
  /** Managed-storage encryption mode, as on `OpenedGatewayBinding`. */
  managedEncryption?: { mode: "migrating" | "encrypted" | "decrypting" };
  /** The privacy rules while they are the authority, as on `/gateway/binding` (phase 3). */
  privacy?: {
    etag: string;
    folders: { prefix: string; visibility: string }[];
    notes: { path: string; visibility: string }[];
  };
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
  imageSha256: v.optional(v.string()),
  imageBytes: v.optional(v.number()),
};

export const createGatewayJobReturns = v.union(v.boolean(), v.literal("already_active"));

export async function createGatewayJobHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof createGatewayJobArgs>,
) {
  if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return false;
  if (!TOKEN_HASH_PATTERN.test(args.hashedTicket)) return false;
  if (args.kind === "materialize_move" && !MOVE_ID_PATTERN.test(args.moveId || "")) return false;
  if (args.kind === "image_upload") return await createImageUpload(ctx, args);

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
  const existing = await ctx.db.query("gatewayJobs")
    .withIndex("by_workspace_kind_move", (q) => q
      .eq("workspaceId", workspaceId)
      .eq("kind", args.kind)
      .eq("moveId", args.moveId))
    .collect();
  // A manual retry must not mint a second worker for a move whose queue job
  // is still leased or has recently reported progress. A stale queued ticket
  // can have been lost between row creation and Queue.send, so allow a fresh
  // ticket after five minutes. Running passes keep their full lease.
  if (existing.some((job) => job.expiresAt > now && (
    (job.status === "running" && typeof job.leasedAt === "number" &&
      job.leasedAt + GATEWAY_JOB_LEASE_MS > now) ||
    (job.status === "queued" && job.updatedAt + 5 * 60 * 1000 > now)
  ))) return "already_active";
  for (const job of existing) {
    if (job.expiresAt > now && (job.status === "queued" || job.status === "running")) {
      await ctx.db.patch(job._id, {
        status: "failed",
        updatedAt: now,
        lastError: "superseded by a fresh move worker",
      });
    }
  }
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

/**
 * An image upload's ticket. Writer clearance (owner or editor, `context:write`),
 * not the owner clearance a move needs: putting a picture beside a note is what
 * writing a note already allows. No dedupe, since two pictures are two tickets.
 */
async function createImageUpload(
  ctx: MutationCtx,
  args: ObjectType<typeof createGatewayJobArgs>,
): Promise<boolean> {
  if (args.moveId !== undefined) return false;
  if (!IMAGE_SHA256_PATTERN.test(args.imageSha256 || "")) return false;
  const bytes = args.imageBytes;
  if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1 || bytes > IMAGE_UPLOAD_MAX_BYTES) {
    return false;
  }
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null) return false;
  const workspaceId = gatewayEditorClearance(
    { scopes: live.grant.scopes, workspaces: await contextsForGrant(ctx, live) },
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
    kind: "image_upload",
    imageSha256: args.imageSha256,
    imageBytes: bytes,
    status: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + IMAGE_UPLOAD_TTL_MS,
  });
  return true;
}

/**
 * `contentSha256` is the hash of the bytes the gateway is holding. An upload's
 * ticket opens only for exactly the bytes it was minted for, and a mismatch
 * leaves the ticket unspent: somebody who learned it cannot burn it with
 * other bytes, and cannot open the bucket's credentials with them either.
 */
export const claimGatewayJobArgs = { hashedTicket: v.string(), contentSha256: v.optional(v.string()) };

export const claimGatewayJobReturns = v.union(
  v.null(),
  v.object({ retryAfterMs: v.number() }),
  v.object({
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    actorClientId: v.string(),
    grantId: v.id("oauthGrants"),
    kind: gatewayJobKindValidator,
    moveId: v.optional(v.string()),
    imageSha256: v.optional(v.string()),
    imageBytes: v.optional(v.number()),
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
  const leasedUntil = typeof job.leasedAt === "number" ? job.leasedAt + GATEWAY_JOB_LEASE_MS : 0;
  const staleLease = job.status === "running" && leasedUntil <= now;
  if (job.status === "running" && !staleLease) {
    return { retryAfterMs: Math.max(1_000, leasedUntil - now) };
  }
  if (job.status !== "queued" && !staleLease) return null;
  const membership = await getMembership(ctx, job.workspaceId, job.actorUserId);
  if (job.kind === "image_upload") {
    // Exactly the bytes it was minted for, by a grant still live, for a
    // person who can still write there. Never retried: a stale lease is spent.
    if (job.status !== "queued" || args.contentSha256 !== job.imageSha256) return null;
    if (membership === null || (membership.role !== "owner" && membership.role !== "editor")) return null;
    const grant = await ctx.db.get(job.grantId);
    if (grant === null || (await validateLiveGrantRecord(ctx, grant)) === null) return null;
    if (!grant.scopes.includes("context:write")) return null;
  } else if (membership === null || membership.role !== "owner") {
    return null;
  }
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
    ...(job.kind === "image_upload" ? { imageSha256: job.imageSha256, imageBytes: job.imageBytes } : {}),
  };
}

export const reportGatewayJobArgs = {
  hashedTicket: v.string(),
  result: v.object({
    status: v.union(v.literal("queued"), v.literal("complete"), v.literal("failed")),
    error: v.optional(v.string()),
    progress: v.optional(
      v.object({
        phase: v.union(v.literal("copying"), v.literal("deleting"), v.literal("rewriting")),
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
  const now = Date.now();
  const progressChanged = validProgress && (job.progressPhase !== progress.phase ||
    job.progressCompleted === undefined || progress.completed > job.progressCompleted);
  const elapsed = now - (job.progressChangedAt ?? now);
  const measuredRate = progressChanged && job.progressPhase === progress.phase &&
    job.progressCompleted !== undefined && progress.completed > job.progressCompleted && elapsed > 0
    ? (progress.completed - job.progressCompleted) * 60_000 / elapsed : undefined;
  await ctx.db.patch(job._id, {
    status: args.result.status,
    updatedAt: now,
    completedAt: args.result.status === "complete" ? now : undefined,
    lastError: gatewayJobError(args.result.error),
    ...(validProgress
      ? {
          progressPhase: progress.phase,
          progressCompleted: progress.completed,
          progressTotal: progress.total,
          ...(progressChanged ? { progressChangedAt: now, progressPerMinute: measuredRate } : {}),
        }
      : {}),
  });
  return true;
}

/**
 * The workspace a job's ticket may act on while it holds its lease: a job
 * that is running, not stale, and whose actor still owns the workspace. The
 * privacy authority's route takes this as its proof for a queued move, which
 * has a ticket and no person's token (`gatewayRoutes/privacy.ts`).
 */
export async function leasedGatewayJobWorkspace(
  ctx: QueryCtx,
  hashedTicket: string,
): Promise<Id<"workspaces"> | null> {
  if (!TOKEN_HASH_PATTERN.test(hashedTicket)) return null;
  const job = await ctx.db
    .query("gatewayJobs")
    .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", hashedTicket))
    .unique();
  const now = Date.now();
  // A move's lease only: an image upload's ticket proves nothing beyond its own bytes.
  if (job === null || job.kind !== "materialize_move" || job.status !== "running" || job.expiresAt <= now) return null;
  if (typeof job.leasedAt !== "number" || job.leasedAt + GATEWAY_JOB_LEASE_MS <= now) return null;
  const membership = await getMembership(ctx, job.workspaceId, job.actorUserId);
  return membership?.role === "owner" ? job.workspaceId : null;
}

export const IMAGE_UPLOAD_SWEEP_BATCH = 200;

/** Delete image-upload tickets past their ten minutes, spent or not. They are tickets, not history. */
export async function sweepImageUploadsHandler(ctx: MutationCtx): Promise<number> {
  const expired = await ctx.db
    .query("gatewayJobs")
    .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
    .filter((q) => q.eq(q.field("kind"), "image_upload"))
    .take(IMAGE_UPLOAD_SWEEP_BATCH);
  for (const row of expired) await ctx.db.delete(row._id);
  return expired.length;
}
