/**
 * A session's own computer as a mail-only device (`docs/decisions/texting-assistant/machines.md`, "A cloud VM as a
 * mail-only device").
 *
 * A cloud VM's Claude Code session already has a Context connection, but the VM cannot use that connection's token
 * (the AI client holds it). So the VM's runner shows a pairing code, and the session approves it through its own
 * connection (`pair_device`). The control plane approves it as that grant's person, into that grant's own workspace,
 * and always as a mail-only device tied to that grant:
 *
 *  - it takes note mail and never jobs (the workspace object holds `mailOnly` and refuses it every job);
 *  - it stops resolving the moment the grant that paired it is revoked, and a day after it was paired;
 *  - it leaves when its session ends (`/machines/leave`), and the purge deletes it, with its mailboxes, an hour after
 *    it ends.
 *
 * The rules a mail-only machine is held to are here, and only here; `texMachines.ts` and `noteMail.ts` ask
 * `deviceStillLive` and nothing else.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { internalMutation } from "./lib/rowWatch/mutations";
import { MAIL_ONLY_DEVICE_RETENTION_MS, mayOwnTexMachine } from "./lib/texMachineRules";
import { getMembership } from "./lib/workspaceAuth";
import { TEX_MACHINE_RUN_CLIENT_ID } from "./lib/texMachineRules";
import { TEXTS_GROUP_CLIENT_ID } from "./textGroups";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { APPROVE_ATTEMPT_LIMIT, APPROVE_ATTEMPT_WINDOW_MS, revokeMachineAs, texMachineRefusal } from "./texMachines";

/** Connections that may never pair a device: Tex's own, which act for a chat, not for a session on a computer. */
const MAY_NOT_PAIR = new Set([TEXTS_CLIENT_ID, TEXTS_GROUP_CLIENT_ID, TEX_MACHINE_RUN_CLIENT_ID]);

/** Mail-only machines deleted per purge run. */
const PURGE_BATCH_SIZE = 100;

/**
 * Whether a machine may still act now. A full machine (the Mac app, `pair` in a terminal) lives until it is revoked.
 * A mail-only one also ends at its `expiresAt` and the moment the grant that paired it is no longer active: that
 * grant's own token rotates, so its standing is checked, not its token's time.
 */
export async function deviceStillLive(ctx: QueryCtx, machine: Doc<"texMachines">, now = Date.now()): Promise<boolean> {
  if (machine.status !== "active") return false;
  if (machine.expiresAt !== undefined && now > machine.expiresAt) return false;
  if (machine.pairedByGrantId !== undefined) {
    const grant = await ctx.db.get(machine.pairedByGrantId);
    if (grant === null || grant.status !== "active" || grant.userId !== machine.ownerId) return false;
  }
  return true;
}

type ApproveRefusal = "UNAUTHORIZED" | "WORKSPACE_MISMATCH" | "INSUFFICIENT_ROLE" | "PAIRING_NOT_FOUND" | "RATE_LIMITED";

/**
 * Approve the code a session's own computer shows, as the person whose connection `hashedAccessToken` is. The
 * workspace must be that connection's own. Refusals are values, not throws, so the attempt counted first stands:
 * a wrong code spends the budget as a right one does. `hashedCode` is null when the code was not well formed.
 */
export const approveTexMachinePairingFromGrant = internalMutation({
  args: { hashedAccessToken: v.string(), workspaceId: v.string(), hashedCode: v.union(v.string(), v.null()) },
  returns: v.union(
    v.object({ ok: v.literal(true), name: v.string(), os: v.string() }),
    v.object({ ok: v.literal(false), code: v.string() }),
  ),
  handler: async (ctx, args) => {
    const refuse = (code: ApproveRefusal) => ({ ok: false as const, code });
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null) return refuse("UNAUTHORIZED");
    const { grant, workspace } = live;
    if (MAY_NOT_PAIR.has(grant.clientId)) return refuse("INSUFFICIENT_ROLE");
    if (workspace._id !== args.workspaceId) return refuse("WORKSPACE_MISMATCH");
    // The same budget as approving in the app: one person, ten attempts in ten minutes, wherever they come from.
    const allowed = await tryConsumeRateLimit(ctx, {
      key: `tex_machine_pair:${grant.userId}`,
      limit: APPROVE_ATTEMPT_LIMIT,
      windowMs: APPROVE_ATTEMPT_WINDOW_MS,
    });
    if (!allowed) return refuse("RATE_LIMITED");
    const membership = await getMembership(ctx, workspace._id, grant.userId);
    if (membership === null || !mayOwnTexMachine(workspace.kind, membership.role)) return refuse("INSUFFICIENT_ROLE");
    if (args.hashedCode === null) return refuse("PAIRING_NOT_FOUND");

    const now = Date.now();
    const rows = await ctx.db
      .query("texMachinePairings")
      .withIndex("by_code", (q) => q.eq("hashedCode", args.hashedCode as string))
      .collect();
    const pairing = rows.find((row) => row.status === "waiting" && row.expiresAt > now);
    if (pairing === undefined) return refuse("PAIRING_NOT_FOUND");

    await ctx.db.patch(pairing._id, {
      status: "approved",
      workspaceId: workspace._id,
      approvedBy: grant.userId,
      mailOnly: true,
      pairedByGrantId: grant._id,
    });
    await recordAudit(ctx, {
      workspaceId: workspace._id,
      actorUserId: grant.userId,
      action: "tex_machine.approved",
      details: { os: pairing.os, mailOnly: true, clientId: grant.clientId },
    });
    return { ok: true as const, name: pairing.name, os: pairing.os };
  },
});

/** A device's mailboxes go with it: nothing is pushed to a machine that is gone. */
export async function removeDeviceMailboxes(ctx: MutationCtx, machineId: Id<"texMachines">): Promise<void> {
  const boxes = await ctx.db
    .query("noteMailboxes")
    .withIndex("by_machine", (q) => q.eq("machineId", machineId))
    .collect();
  for (const box of boxes) await ctx.db.delete(box._id);
}

/**
 * A machine giving its own grant back, as a cloud VM does when its session ends. Revoked as its owner would revoke
 * it, its mailboxes removed. An unknown or already-revoked grant is the same refusal, so a guess learns nothing.
 */
export const leaveTexMachine = internalMutation({
  args: { hashedGrant: v.string() },
  returns: v.object({ machineId: v.id("texMachines"), workspaceId: v.id("workspaces") }),
  handler: async (ctx, args) => {
    const machine = await ctx.db
      .query("texMachines")
      .withIndex("by_grant", (q) => q.eq("hashedGrant", args.hashedGrant))
      .unique();
    if (machine === null || machine.status !== "active") throw texMachineRefusal("MACHINE_GRANT_INVALID");
    await revokeMachineAs(ctx, machine._id, machine.ownerId);
    await removeDeviceMailboxes(ctx, machine._id);
    return { machineId: machine._id, workspaceId: machine.workspaceId };
  },
});

/**
 * Mail-only machines an hour past their end are deleted, with their mailboxes. Only ever a mail-only one: a full
 * machine has no `expiresAt`, and the index range starts above zero so a row without one is never read.
 */
export async function purgeEndedDevices(ctx: MutationCtx, now = Date.now()): Promise<{ deleted: number; full: boolean }> {
  const ended = await ctx.db
    .query("texMachines")
    .withIndex("by_expires", (q) => q.gt("expiresAt", 0).lt("expiresAt", now - MAIL_ONLY_DEVICE_RETENTION_MS))
    .take(PURGE_BATCH_SIZE);
  for (const machine of ended) {
    if (machine.mailOnly !== true) continue;
    await removeDeviceMailboxes(ctx, machine._id);
    await ctx.db.delete(machine._id);
  }
  return { deleted: ended.length, full: ended.length === PURGE_BATCH_SIZE };
}
