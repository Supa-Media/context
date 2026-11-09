/**
 * A person's own computers, set up by texting Tex (`docs/decisions/texting-assistant/computer-setup.md`; decided by
 * the owner, 2026-11-08: "we should never really make functionality that only humans are native to like setting up
 * a computer by pressing UI").
 *
 * Two things the app did alone, now reachable from the person's own texts:
 *
 *  - **Approving a pairing code they texted Tex.** Only a person's own 1:1 texting grant (`context_texts`) may, never
 *    a group chat's (a code read out in a group could be approved by somebody else, into their own workspace, and
 *    that person's jobs would then run on the computer), never an MCP connection (that path is
 *    `texMachineDevices.ts`, which makes a mail-only device), never a job's run grant. The code is approved into the
 *    grant's own workspace under the app's own role rule and the same ten-in-ten-minutes budget, and becomes a full
 *    computer, as one approved in the app does: whoever texts the code is the person the grant names, who is the
 *    person approving it in the app.
 *  - **Listing a person's own computers** for a chat turn, by the person the grant names (`userId` comes from the
 *    gateway's resolved session, never from words): active, never mail-only. A group chat's turn reads the tagger's
 *    computers this way, because a group's grant reaches only its shared workspace and a computer lives in its
 *    owner's own.
 *
 * Whether the person asked for it in their own words is the gateway's check (`machines/texActions.js`); who may
 * approve, into where, is decided here and only here.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { internalMutation } from "./lib/rowWatch/mutations";
import { internalQuery } from "../_generated/server";
import { mayOwnTexMachine } from "./lib/texMachineRules";
import { getMembership } from "./lib/workspaceAuth";
import { TEXTS_CLIENT_ID } from "./textLinks";
import { APPROVE_ATTEMPT_LIMIT, APPROVE_ATTEMPT_WINDOW_MS } from "./texMachines";

type TextsApproveRefusal = "UNAUTHORIZED" | "INSUFFICIENT_ROLE" | "PAIRING_NOT_FOUND" | "RATE_LIMITED";

/** Computers listed per person: more than anyone pairs. */
const OWNED_LIMIT = 50;

/**
 * Approve the code a person texted Tex, as the person whose own texting grant `hashedAccessToken` is, into that
 * grant's own workspace. Refusals are values, so the attempt counted first stands: a wrong code spends the budget as
 * a right one does. `hashedCode` is null when the code was not well formed.
 */
export const approveTexMachinePairingFromTexts = internalMutation({
  args: { hashedAccessToken: v.string(), hashedCode: v.union(v.string(), v.null()) },
  returns: v.union(
    v.object({ ok: v.literal(true), name: v.string(), os: v.string(), workspaceId: v.id("workspaces") }),
    v.object({ ok: v.literal(false), code: v.string() }),
  ),
  handler: async (ctx, args) => {
    const refuse = (code: TextsApproveRefusal) => ({ ok: false as const, code });
    const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
    if (live === null) return refuse("UNAUTHORIZED");
    const { grant, workspace } = live;
    // Their own 1:1 texts only: a group chat's grant, an MCP connection or a job's run grant never approves one here.
    if (grant.clientId !== TEXTS_CLIENT_ID) return refuse("INSUFFICIENT_ROLE");
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

    await ctx.db.patch(pairing._id, { status: "approved", workspaceId: workspace._id, approvedBy: grant.userId });
    await recordAudit(ctx, {
      workspaceId: workspace._id,
      actorUserId: grant.userId,
      action: "tex_machine.approved",
      details: { os: pairing.os, clientId: grant.clientId },
    });
    return { ok: true as const, name: pairing.name, os: pairing.os, workspaceId: workspace._id };
  },
});

/** A person's own active computers, never a mail-only device: `[{ machineId, workspaceId }]`. A malformed id is none. */
export const texMachinesOwnedBy = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args): Promise<{ machineId: Id<"texMachines">; workspaceId: Id<"workspaces"> }[]> => {
    const userId = ctx.db.normalizeId("users", args.userId);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("texMachines")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .take(OWNED_LIMIT * 2);
    return rows
      .filter((machine) => machine.status === "active" && machine.mailOnly !== true)
      .slice(0, OWNED_LIMIT)
      .map((machine) => ({ machineId: machine._id, workspaceId: machine.workspaceId }));
  },
});
