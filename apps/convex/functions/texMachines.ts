/**
 * Pairing a person's own computer for Tex, and the machines it leaves behind (`docs/decisions/texting-assistant/machines.md`).
 *
 * Who may approve, claim, register, revoke and list a machine is decided here, and only here. The gateway routes in
 * `lib/gatewayRoutes/texMachines.ts` carry the runner's requests in and hash the grants and codes it presents before
 * anything is stored; the app's functions below hash the code a person types. Nothing stores a plain grant or a
 * plain code.
 *
 * Refusals are `ConvexError`s carrying a `code`. The gateway maps each code to a status; the app shows the code's
 * message. Names are `texMachine`, not `machine`, which is already the desktop shell's grant (`lib/machineGrant.ts`).
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { hashToken } from "./lib/crypto";
import { resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { TEXTS_GROUP_CLIENT_ID } from "./textGroups";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { mutation, internalMutation } from "./lib/rowWatch/mutations";
import { requireAuthId } from "./lib/signedIn";
import { consumeRateLimit } from "./lib/rateLimit";
import {
  PAIRING_CLAIM_GRACE_MS,
  PAIRING_RETENTION_MS,
  PAIRING_TTL_MS,
  LAST_SEEN_WRITE_INTERVAL_MS,
  TEX_MACHINE_RUN_ID_PATTERN,
  TEX_MACHINE_RUN_MAX_MS,
  MAIL_ONLY_DEVICE_TTL_MS,
  mayOwnTexMachine,
  normalizePairingCode,
  pairingCodeHashInput,
} from "./lib/texMachineRules";
import { deviceStillLive, purgeEndedDevices } from "./texMachineDevices";
import { getMembership, requireWorkspaceAccess, workspaceNotFound, type WorkspaceRole } from "./lib/workspaceAuth";

/** Approvals one person may attempt per window. Refused attempts count, so guessing a code spends the budget. */
export const APPROVE_ATTEMPT_LIMIT = 10;
export const APPROVE_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const PURGE_BATCH_SIZE = 100;

export type TexMachineRefusal =
  | "PAIRING_NOT_FOUND"
  | "PAIRING_NOT_APPROVED"
  | "PAIRING_EXPIRED"
  | "PAIRING_ALREADY_CLAIMED"
  | "CODE_TAKEN"
  | "MACHINE_NOT_FOUND"
  | "MACHINE_OWNER_GONE"
  | "MACHINE_GRANT_INVALID"
  | "INSUFFICIENT_ROLE"
  | "MACHINE_RUN_PARENT_INVALID"
  | "BAD_RUN"
  | "CHAT_NOT_FOUND"
  | "TOO_MANY_MACHINES";

const MESSAGES: Record<TexMachineRefusal, string> = {
  PAIRING_NOT_FOUND: "That code is not waiting for approval. Check it on the computer and try again.",
  PAIRING_NOT_APPROVED: "That computer has not been approved yet.",
  PAIRING_EXPIRED: "That pairing ran out. Start it again on the computer.",
  PAIRING_ALREADY_CLAIMED: "That computer has already been paired.",
  CODE_TAKEN: "Another computer is showing that code. Wait a moment and try again.",
  MACHINE_NOT_FOUND: "No such computer.",
  MACHINE_OWNER_GONE: "The person who paired this computer no longer has access to its workspace.",
  MACHINE_GRANT_INVALID: "This computer's access has been revoked.",
  INSUFFICIENT_ROLE: "Only an owner or an editor of a shared workspace can add a computer to it.",
  MACHINE_RUN_PARENT_INVALID: "This job's texting access is no longer valid, so it cannot run on a computer.",
  BAD_RUN: "That run's access request is not valid.",
  CHAT_NOT_FOUND: "No such chat, or you are not in it.",
  TOO_MANY_MACHINES: "This chat already has as many computers as it can use. Detach one first.",
};

export function texMachineRefusal(code: TexMachineRefusal): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message: MESSAGES[code] });
}

/** Whether `userId` may hold a machine in `workspaceId` right now: a member whose role passes the rule. */
async function ownerMayHold(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
): Promise<boolean> {
  const membership = await getMembership(ctx, workspaceId, userId);
  if (membership === null) return false;
  const workspace = await ctx.db.get(workspaceId);
  return workspace !== null && mayOwnTexMachine(workspace.kind, membership.role);
}

async function isWorkspaceOwner(ctx: QueryCtx, workspaceId: Id<"workspaces">, userId: Id<"users">): Promise<boolean> {
  const role: WorkspaceRole | undefined = (await getMembership(ctx, workspaceId, userId))?.role;
  return role === "owner";
}

/** What a runner is told about its new machine, once it is paired or registered. A mail-only one also learns its end. */
function machineShape(
  machine: {
    _id: Id<"texMachines">;
    workspaceId: Id<"workspaces">;
    ownerId: Id<"users">;
    name: string;
    mailOnly?: true;
    expiresAt?: number;
  },
  workspaceHandle: string,
) {
  return {
    machineId: machine._id,
    workspaceId: machine.workspaceId,
    ownerId: machine.ownerId,
    name: machine.name,
    workspaceHandle,
    ...(machine.mailOnly === true ? { mailOnly: true as const, expiresAt: machine.expiresAt } : {}),
  };
}

// ── The gateway's side (reached only through `/gateway/machines/*`) ──────────

/** Open a pairing for the code a runner showed. `CODE_TAKEN` while another live pairing holds the same code. */
export const startTexMachinePairing = internalMutation({
  args: { hashedCode: v.string(), publicKey: v.string(), name: v.string(), os: v.string(), facts: v.string() },
  returns: v.object({ pairingId: v.id("texMachinePairings"), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const sameCode = await ctx.db
      .query("texMachinePairings")
      .withIndex("by_code", (q) => q.eq("hashedCode", args.hashedCode))
      .collect();
    if (sameCode.some((row) => row.expiresAt > now)) throw texMachineRefusal("CODE_TAKEN");

    const expiresAt = now + PAIRING_TTL_MS;
    const pairingId = await ctx.db.insert("texMachinePairings", {
      publicKey: args.publicKey,
      name: args.name,
      os: args.os,
      hashedCode: args.hashedCode,
      status: "waiting",
      facts: args.facts,
      createdAt: now,
      expiresAt,
    });
    return { pairingId, expiresAt };
  },
});

/**
 * The runner's poll: where its pairing stands, and what it is, for the screen that compares codes. `expired` is true
 * once the code has run out, whatever the status. `facts` is the object the runner sent, parsed here.
 */
export const readTexMachinePairing = internalQuery({
  args: { pairingId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("texMachinePairings", args.pairingId);
    const pairing = id === null ? null : await ctx.db.get(id);
    if (pairing === null) throw texMachineRefusal("PAIRING_NOT_FOUND");
    return {
      status: pairing.status,
      publicKey: pairing.publicKey,
      expired: Date.now() > pairing.expiresAt,
      name: pairing.name,
      os: pairing.os,
      facts: pairing.facts === undefined ? null : JSON.parse(pairing.facts),
    };
  },
});

/** Hand a runner its machine, once: the pairing must be approved, unclaimed and inside its grace period. */
export const claimTexMachine = internalMutation({
  args: { pairingId: v.string(), hashedGrant: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("texMachinePairings", args.pairingId);
    const pairing = id === null ? null : await ctx.db.get(id);
    if (pairing === null) throw texMachineRefusal("PAIRING_NOT_FOUND");
    if (pairing.status === "claimed") throw texMachineRefusal("PAIRING_ALREADY_CLAIMED");
    if (pairing.status !== "approved" || pairing.workspaceId === undefined || pairing.approvedBy === undefined) {
      throw texMachineRefusal("PAIRING_NOT_APPROVED");
    }
    if (Date.now() > pairing.expiresAt + PAIRING_CLAIM_GRACE_MS) throw texMachineRefusal("PAIRING_EXPIRED");

    const { workspaceId, approvedBy: ownerId } = pairing;
    if (!(await ownerMayHold(ctx, workspaceId, ownerId))) throw texMachineRefusal("MACHINE_OWNER_GONE");
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null) throw texMachineRefusal("MACHINE_OWNER_GONE");

    // A pairing a session approved through its own connection becomes a mail-only device that ends with that grant
    // and a day after now (`texMachineDevices.ts`). The paired grant is re-checked here: revoked since, nothing is made.
    const pairedByGrantId = pairing.mailOnly === true ? pairing.pairedByGrantId : undefined;
    if (pairing.mailOnly === true) {
      const paired = pairedByGrantId === undefined ? null : await ctx.db.get(pairedByGrantId);
      if (paired === null || paired.status !== "active") throw texMachineRefusal("MACHINE_OWNER_GONE");
    }
    const now = Date.now();
    const machine = {
      workspaceId,
      ownerId,
      name: pairing.name,
      os: pairing.os,
      publicKey: pairing.publicKey,
      hashedGrant: args.hashedGrant,
      status: "active" as const,
      createdAt: now,
      ...(pairedByGrantId !== undefined
        ? { mailOnly: true as const, pairedByGrantId, expiresAt: now + MAIL_ONLY_DEVICE_TTL_MS }
        : {}),
    };
    const machineId = await ctx.db.insert("texMachines", machine);
    await ctx.db.patch(pairing._id, { status: "claimed", machineId });
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: ownerId,
      action: "tex_machine.paired",
      details: { os: pairing.os },
    });
    return machineShape({ ...machine, _id: machineId }, workspace.slug);
  },
});

/** The Mac app registers the machine it runs, for a person whose session the gateway has already checked. */
export const registerTexMachine = internalMutation({
  args: {
    userId: v.string(),
    workspaceId: v.string(),
    hashedGrant: v.string(),
    publicKey: v.string(),
    name: v.string(),
    os: v.string(),
  },
  handler: async (ctx, args) => {
    const workspaceId = ctx.db.normalizeId("workspaces", args.workspaceId);
    const userId = ctx.db.normalizeId("users", args.userId);
    if (workspaceId === null || userId === null) throw workspaceNotFound();
    const { workspace, membership } = await requireWorkspaceAccess(ctx, workspaceId, userId);
    if (!mayOwnTexMachine(workspace.kind, membership.role)) throw texMachineRefusal("INSUFFICIENT_ROLE");

    const machine = {
      workspaceId,
      ownerId: userId,
      name: args.name,
      os: args.os,
      publicKey: args.publicKey,
      hashedGrant: args.hashedGrant,
      status: "active" as const,
      createdAt: Date.now(),
    };
    const machineId = await ctx.db.insert("texMachines", machine);
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: userId,
      action: "tex_machine.registered",
      details: { os: args.os },
    });
    return machineShape({ ...machine, _id: machineId }, workspace.slug);
  },
});

/** Every request a runner makes carries its grant: find the machine, and check its owner still may hold it. */
export const resolveTexMachine = internalMutation({
  args: { hashedGrant: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db
      .query("texMachines")
      .withIndex("by_grant", (q) => q.eq("hashedGrant", args.hashedGrant))
      .unique();
    if (machine === null || !(await deviceStillLive(ctx, machine))) throw texMachineRefusal("MACHINE_GRANT_INVALID");
    if (!(await ownerMayHold(ctx, machine.workspaceId, machine.ownerId))) throw texMachineRefusal("MACHINE_OWNER_GONE");

    const now = Date.now();
    if (machine.lastSeenAt === undefined || now - machine.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
      await ctx.db.patch(machine._id, { lastSeenAt: now });
    }
    return {
      machineId: machine._id,
      workspaceId: machine.workspaceId,
      ownerId: machine.ownerId,
      name: machine.name,
      os: machine.os,
      publicKey: machine.publicKey,
      ...(machine.mailOnly === true ? { mailOnly: true as const, expiresAt: machine.expiresAt } : {}),
    };
  },
});

/** Revoke by id as whoever the gateway says is asking. A caller who may not revoke learns only that it is not found. */
export const revokeTexMachineAs = internalMutation({
  args: { machineId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    const machineId = ctx.db.normalizeId("texMachines", args.machineId);
    const userId = ctx.db.normalizeId("users", args.userId);
    if (machineId === null || userId === null) throw texMachineRefusal("MACHINE_NOT_FOUND");
    return await revokeMachineAs(ctx, machineId, userId);
  },
});

/** The app's pending lookup. Hashing needs an action, so the lookup runs here. */
export const pendingByHash = internalQuery({
  args: { hashedCode: v.string() },
  handler: async (ctx, args) => {
    const pairing = await waitingPairingFor(ctx, args.hashedCode);
    if (pairing === null) return null;
    return { name: pairing.name, os: pairing.os, createdAt: pairing.createdAt, expiresAt: pairing.expiresAt };
  },
});

/** Spends one approval attempt. Its own transaction, so a refused approval below cannot roll the count back. */
export const countPairingAttempt = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await consumeRateLimit(ctx, {
      key: `tex_machine_pair:${args.userId}`,
      limit: APPROVE_ATTEMPT_LIMIT,
      windowMs: APPROVE_ATTEMPT_WINDOW_MS,
    });
    return null;
  },
});

export const approveByHash = internalMutation({
  args: { userId: v.id("users"), hashedCode: v.string(), workspaceId: v.id("workspaces") },
  returns: v.object({ pairingId: v.id("texMachinePairings"), name: v.string(), os: v.string() }),
  handler: async (ctx, args) => {
    const pairing = await waitingPairingFor(ctx, args.hashedCode);
    if (pairing === null) throw texMachineRefusal("PAIRING_NOT_FOUND");

    const { workspace, membership } = await requireWorkspaceAccess(ctx, args.workspaceId, args.userId);
    if (!mayOwnTexMachine(workspace.kind, membership.role)) throw texMachineRefusal("INSUFFICIENT_ROLE");

    await ctx.db.patch(pairing._id, {
      status: "approved",
      workspaceId: args.workspaceId,
      approvedBy: args.userId,
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.userId,
      action: "tex_machine.approved",
      details: { os: pairing.os },
    });
    return { pairingId: pairing._id, name: pairing.name, os: pairing.os };
  },
});

export const declineByHash = internalMutation({
  args: { hashedCode: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pairing = await waitingPairingFor(ctx, args.hashedCode);
    if (pairing === null) throw texMachineRefusal("PAIRING_NOT_FOUND");
    await ctx.db.patch(pairing._id, { status: "declined" });
    return null;
  },
});

/**
 * Mint a run grant for one job part on one machine. The parent must be a live texting grant (a 1:1 chat's or a group
 * chat's); anything else, including an MCP client's own grant, is refused. Its lifetime is clamped to the run maximum.
 */
export const issueTexMachineRunGrant = internalMutation({
  args: {
    hashedParentToken: v.string(),
    hashedAccessToken: v.string(),
    machineId: v.string(),
    runId: v.string(),
    expiresAt: v.number(),
  },
  returns: v.object({ expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const parent = await resolveLiveGrant(ctx, args.hashedParentToken);
    if (parent === null) throw texMachineRefusal("MACHINE_RUN_PARENT_INVALID");
    const clientId = parent.grant.clientId;
    if (clientId !== TEXTS_CLIENT_ID && clientId !== TEXTS_GROUP_CLIENT_ID) {
      throw texMachineRefusal("MACHINE_RUN_PARENT_INVALID");
    }

    const machineId = ctx.db.normalizeId("texMachines", args.machineId);
    const machine = machineId === null ? null : await ctx.db.get(machineId);
    // A mail-only device takes mail and never jobs: no part runs on it, whatever the gateway asks.
    if (machine === null || machine.status !== "active" || machine.mailOnly === true) throw texMachineRefusal("MACHINE_NOT_FOUND");
    if (!TEX_MACHINE_RUN_ID_PATTERN.test(args.runId)) throw texMachineRefusal("BAD_RUN");

    const now = Date.now();
    const expiresAt = Math.min(args.expiresAt, now + TEX_MACHINE_RUN_MAX_MS);
    if (expiresAt <= now) throw texMachineRefusal("BAD_RUN");

    await ctx.db.insert("texMachineRunGrants", {
      hashedAccessToken: args.hashedAccessToken,
      parentGrantId: parent.grant._id,
      machineId: machine._id,
      runId: args.runId,
      expiresAt,
      createdAt: now,
    });
    return { expiresAt };
  },
});

/** Revoke every run grant of one job part, at the part's end. Idempotent: a run with no rows revokes zero. */
export const revokeTexMachineRunGrant = internalMutation({
  args: { runId: v.string() },
  returns: v.object({ revoked: v.number() }),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("texMachineRunGrants")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return { revoked: rows.length };
  },
});


/**
 * Pairings an hour past their code's expiry are swept, in batches, and so are run grants past their own expiry and
 * mail-only devices an hour past their end (`texMachineDevices.ts`). The count covers all three; `moreRemaining` is
 * true when any batch was full.
 */
export const purgeExpiredTexMachinePairings = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number(), moreRemaining: v.boolean() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - PAIRING_RETENTION_MS;
    const expired = await ctx.db
      .query("texMachinePairings")
      .withIndex("by_expires", (q) => q.lt("expiresAt", cutoff))
      .take(PURGE_BATCH_SIZE);
    for (const row of expired) await ctx.db.delete(row._id);
    const expiredRuns = await ctx.db
      .query("texMachineRunGrants")
      .withIndex("by_expires", (q) => q.lt("expiresAt", Date.now()))
      .take(PURGE_BATCH_SIZE);
    for (const row of expiredRuns) await ctx.db.delete(row._id);
    const devices = await purgeEndedDevices(ctx);
    return {
      deleted: expired.length + expiredRuns.length + devices.deleted,
      moreRemaining: expired.length === PURGE_BATCH_SIZE || expiredRuns.length === PURGE_BATCH_SIZE || devices.full,
    };
  },
});

// ── The app's side ───────────────────────────────────────────────────────────

/** A waiting, unexpired pairing whose code hashes to `hashedCode`, or `null`. */
async function waitingPairingFor(ctx: QueryCtx, hashedCode: string) {
  const now = Date.now();
  const rows = await ctx.db
    .query("texMachinePairings")
    .withIndex("by_code", (q) => q.eq("hashedCode", hashedCode))
    .collect();
  return rows.find((row) => row.status === "waiting" && row.expiresAt > now) ?? null;
}

/** The one place a machine is revoked, by the owner or by an owner of its workspace. Idempotent once revoked. */
export async function revokeMachineAs(
  ctx: MutationCtx,
  machineId: Id<"texMachines">,
  userId: Id<"users">,
): Promise<{ revoked: true; workspaceId: Id<"workspaces"> }> {
  const machine = await ctx.db.get(machineId);
  if (machine === null) throw texMachineRefusal("MACHINE_NOT_FOUND");
  const allowed = machine.ownerId === userId || (await isWorkspaceOwner(ctx, machine.workspaceId, userId));
  if (!allowed) throw texMachineRefusal("MACHINE_NOT_FOUND");
  if (machine.status === "revoked") return { revoked: true, workspaceId: machine.workspaceId };

  await ctx.db.patch(machine._id, { status: "revoked", revokedAt: Date.now() });
  // A revoked machine's run grants go with it: a part still running on it stops at its next request.
  const runs = await ctx.db
    .query("texMachineRunGrants")
    .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
    .collect();
  for (const run of runs) await ctx.db.delete(run._id);
  // Lent to a chat, it is no longer lent: its attachments go with it.
  const chats = await ctx.db
    .query("texMachineChats")
    .withIndex("by_machine", (q) => q.eq("machineId", machine._id))
    .collect();
  for (const chat of chats) await ctx.db.delete(chat._id);
  await recordAudit(ctx, {
    workspaceId: machine.workspaceId,
    actorUserId: userId,
    action: "tex_machine.revoked",
    details: { os: machine.os },
  });
  return { revoked: true, workspaceId: machine.workspaceId };
}

/** Look up a waiting pairing by the code a person typed. Hashing needs Web Crypto, so this is an action. */
export const pendingTexMachinePairing = action({
  args: { code: v.string() },
  returns: v.union(
    v.null(),
    v.object({ name: v.string(), os: v.string(), createdAt: v.number(), expiresAt: v.number() }),
  ),
  handler: async (ctx, args): Promise<{ name: string; os: string; createdAt: number; expiresAt: number } | null> => {
    const userId = await requireAuthId(ctx);
    // Looking a code up spends the same budget as approving one, so codes cannot be probed for free.
    await ctx.runMutation(internal.functions.texMachines.countPairingAttempt, { userId });
    const normalized = normalizePairingCode(args.code);
    if (normalized === null) return null;
    return await ctx.runQuery(internal.functions.texMachines.pendingByHash, {
      hashedCode: await hashToken(pairingCodeHashInput(normalized)),
    });
  },
});

/**
 * Approve a waiting pairing into a workspace the person may own a machine in. The attempt is counted before the
 * code is looked at, so a wrong code costs the same as a right one.
 */
export const approveTexMachinePairing = action({
  args: { code: v.string(), workspaceId: v.id("workspaces") },
  returns: v.object({ pairingId: v.id("texMachinePairings"), name: v.string(), os: v.string() }),
  handler: async (ctx, args): Promise<{ pairingId: Id<"texMachinePairings">; name: string; os: string }> => {
    const userId = await requireAuthId(ctx);
    await ctx.runMutation(internal.functions.texMachines.countPairingAttempt, { userId });
    const normalized = normalizePairingCode(args.code);
    if (normalized === null) throw texMachineRefusal("PAIRING_NOT_FOUND");
    return await ctx.runMutation(internal.functions.texMachines.approveByHash, {
      userId,
      hashedCode: await hashToken(pairingCodeHashInput(normalized)),
      workspaceId: args.workspaceId,
    });
  },
});

export const declineTexMachinePairing = action({
  args: { code: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await requireAuthId(ctx);
    // A decline costs an attempt too: nobody may guess codes to turn other people's computers away.
    await ctx.runMutation(internal.functions.texMachines.countPairingAttempt, { userId });
    const normalized = normalizePairingCode(args.code);
    if (normalized === null) throw texMachineRefusal("PAIRING_NOT_FOUND");
    return await ctx.runMutation(internal.functions.texMachines.declineByHash, {
      hashedCode: await hashToken(pairingCodeHashInput(normalized)),
    });
  },
});

/** The machines of a workspace, newest first. Never the grant's hash. Any member may see them. */
export const listTexMachines = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(
    v.object({
      _id: v.id("texMachines"),
      name: v.string(),
      os: v.string(),
      ownerId: v.id("users"),
      status: v.union(v.literal("active"), v.literal("revoked")),
      createdAt: v.number(),
      lastSeenAt: v.optional(v.number()),
      revokedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await requireAuthId(ctx);
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);
    const rows = await ctx.db
      .query("texMachines")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(100);
    return rows.map((row) => ({
      _id: row._id,
      name: row.name,
      os: row.os,
      ownerId: row.ownerId,
      status: row.status,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      revokedAt: row.revokedAt,
    }));
  },
});

export const revokeTexMachine = mutation({
  args: { machineId: v.id("texMachines") },
  returns: v.object({ revoked: v.literal(true), workspaceId: v.id("workspaces") }),
  handler: async (ctx, args) => {
    const userId = await requireAuthId(ctx);
    return await revokeMachineAs(ctx, args.machineId, userId);
  },
});
