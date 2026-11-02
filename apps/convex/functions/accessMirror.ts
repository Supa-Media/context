/**
 * Convex written behind an object's access write (decided by the owner, 2026-11-01:
 * `docs/decisions/identity-and-access/access-in-objects.md`).
 *
 * Once a workspace's members (or a person's connections) are decided in its object, the app's take-away writes go
 * there first (thread F's access socket: remove a member, change a role, withdraw an invitation, revoke a connection).
 * The object then calls this, through the gateway (`POST /gateway/access/mirror`), so Convex's rows say the same: the
 * copy switch's one-step rollback to `dual` loses nothing, and Convex's own checks never let in someone the object
 * already let go. The object does not report the change done until this answered.
 *
 * Every change is idempotent: a retry with the same `at`, or a change already made, is `applied: false`, never an
 * error. A change that names a row outside the object's own workspace, or one the object would itself refuse (removing
 * or demoting the owner), is refused here too, so a fault on the other side cannot widen into Convex.
 *
 * Built with `internalMutationWriteBehind`: its access writes are never refused by the switch and never pushed back
 * to the object (`lib/accessHandOff/flush.ts`).
 */

import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutationWriteBehind } from "./lib/rowWatch/mutations";
import { recordAudit } from "./lib/audit";
import { getMembership } from "./lib/workspaceAuth";
import { deleteMemberPlaces } from "./lib/places";
import { removeUserGrantsIn } from "./lib/grants/removeUserGrants";
import { personalWorkspaceOf } from "./lib/faces/people";
import { isPending } from "./lib/invitations/forCaller";
import { invalidateInvitationSignInCode } from "./invitationEmail";

export const accessChangeValidator = v.union(
  v.object({ op: v.literal("remove_member"), userId: v.string(), at: v.number(), by: v.string() }),
  v.object({ op: v.literal("set_role"), userId: v.string(), role: v.union(v.literal("editor"), v.literal("member")), at: v.number(), by: v.string() }),
  v.object({ op: v.literal("revoke_invite"), invitationId: v.string(), at: v.number(), by: v.string() }),
  v.object({ op: v.literal("revoke_connection"), grantId: v.string(), at: v.number(), by: v.string() }),
);

export type MirrorAnswer = { applied: boolean; refused?: "NOT_FOUND" | "OWNER" | "WRONG_WORKSPACE" };

export const apply = internalMutationWriteBehind({
  args: { workspaceId: v.id("workspaces"), change: accessChangeValidator },
  returns: v.object({ applied: v.boolean(), refused: v.optional(v.union(v.literal("NOT_FOUND"), v.literal("OWNER"), v.literal("WRONG_WORKSPACE"))) }),
  handler: async (ctx, { workspaceId, change }): Promise<MirrorAnswer> => {
    const actor = ctx.db.normalizeId("users", change.by);
    const now = Date.now();

    if (change.op === "remove_member" || change.op === "set_role") {
      const userId = ctx.db.normalizeId("users", change.userId);
      if (userId === null) return { applied: false, refused: "NOT_FOUND" };
      const target = await getMembership(ctx, workspaceId, userId);
      // Already gone: the change is made.
      if (target === null) return change.op === "remove_member" ? { applied: false } : { applied: false, refused: "NOT_FOUND" };
      if (target.role === "owner") return { applied: false, refused: "OWNER" };
      if (change.op === "set_role") {
        if (target.role === change.role) return { applied: false };
        await ctx.db.patch(target._id, { role: change.role });
        await recordAudit(ctx, {
          workspaceId,
          actorUserId: actor ?? undefined,
          action: "member.role_changed",
          details: { targetUserId: userId, previousRole: target.role, role: change.role, via: "object" },
        });
        return { applied: true };
      }
      await ctx.db.delete(target._id);
      await deleteMemberPlaces(ctx, workspaceId, userId);
      if (actor !== null) await removeUserGrantsIn(ctx, { workspaceId, userId, actorUserId: actor });
      await recordAudit(ctx, {
        workspaceId,
        actorUserId: actor ?? undefined,
        action: "member.removed",
        details: { targetUserId: userId, previousRole: target.role, via: "object" },
      });
      return { applied: true };
    }

    if (change.op === "revoke_invite") {
      const invitationId = ctx.db.normalizeId("workspaceInvitations", change.invitationId);
      const invitation = invitationId === null ? null : await ctx.db.get(invitationId);
      if (invitation === null) return { applied: false, refused: "NOT_FOUND" };
      if (invitation.workspaceId !== workspaceId) return { applied: false, refused: "WRONG_WORKSPACE" };
      if (!isPending(invitation, now)) return { applied: false };
      await ctx.db.patch(invitation._id, { status: "revoked", respondedAt: now });
      await invalidateInvitationSignInCode(ctx, invitation);
      await recordAudit(ctx, {
        workspaceId,
        actorUserId: actor ?? undefined,
        action: "invitation.revoked",
        details: { via: "object" },
      });
      return { applied: true };
    }

    // A connection is its person's: the object asking is that person's personal workspace's, or nobody's.
    const grantId = ctx.db.normalizeId("oauthGrants", change.grantId);
    const grant: Doc<"oauthGrants"> | null = grantId === null ? null : await ctx.db.get(grantId);
    if (grant === null) return { applied: false, refused: "NOT_FOUND" };
    const personal = await personalWorkspaceOf(ctx, grant.userId);
    if (personal === null || personal._id !== workspaceId) return { applied: false, refused: "WRONG_WORKSPACE" };
    if (grant.status === "revoked") return { applied: false };
    await ctx.db.patch(grant._id, { status: "revoked", revokedAt: now });
    await recordAudit(ctx, {
      workspaceId: grant.workspaceId,
      actorUserId: actor ?? undefined,
      actorClientId: grant.clientId,
      action: "grant.revoked",
      details: { onBehalfOfSelf: actor === grant.userId, via: "object" },
    });
    return { applied: true };
  },
});


