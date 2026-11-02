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
import { TOKEN_HASH_PATTERN } from "./lib/crypto";
import { clampAccessTokenExpiry } from "./lib/consentScopes";

export const accessChangeValidator = v.union(
  v.object({ op: v.literal("remove_member"), userId: v.string(), at: v.number(), by: v.string() }),
  v.object({ op: v.literal("set_role"), userId: v.string(), role: v.union(v.literal("editor"), v.literal("member")), at: v.number(), by: v.string() }),
  v.object({ op: v.literal("revoke_invite"), invitationId: v.string(), at: v.number(), by: v.string() }),
  // `by` is absent when the client revoked its own grant (RFC 7009): the person acted through it.
  v.object({ op: v.literal("revoke_connection"), grantId: v.string(), at: v.number(), by: v.optional(v.string()) }),
  // A refresh the object made: the copy takes the new pair, keeping the spent refresh token so its reuse is still named.
  v.object({
    op: v.literal("rotate_connection"),
    grantId: v.string(),
    tokenHash: v.string(),
    refreshHash: v.string(),
    expiresAt: v.number(),
    scopes: v.array(v.string()),
    at: v.number(),
  }),
);

export type MirrorAnswer = { applied: boolean; refused?: "NOT_FOUND" | "OWNER" | "WRONG_WORKSPACE" };

export const apply = internalMutationWriteBehind({
  args: { workspaceId: v.id("workspaces"), change: accessChangeValidator },
  returns: v.object({ applied: v.boolean(), refused: v.optional(v.union(v.literal("NOT_FOUND"), v.literal("OWNER"), v.literal("WRONG_WORKSPACE"))) }),
  handler: async (ctx, { workspaceId, change }): Promise<MirrorAnswer> => {
    const actor = "by" in change && change.by !== undefined ? ctx.db.normalizeId("users", change.by) : null;
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
    if (change.op === "rotate_connection") {
      if (!TOKEN_HASH_PATTERN.test(change.tokenHash) || !TOKEN_HASH_PATTERN.test(change.refreshHash)) return { applied: false, refused: "NOT_FOUND" };
      // Already taken: a retry, or a late copy.
      if (grant.hashedRefreshToken === change.refreshHash || grant.previousHashedRefreshToken === change.refreshHash) return { applied: false };
      // Narrowing only, as the object did: a copy never holds a scope the grant did not.
      const scopes = change.scopes.filter((scope) => grant.scopes.includes(scope));
      await ctx.db.patch(grant._id, {
        previousHashedRefreshToken: grant.hashedRefreshToken,
        hashedRefreshToken: change.refreshHash,
        hashedAccessToken: change.tokenHash,
        accessTokenExpiresAt: clampAccessTokenExpiry(change.expiresAt, now),
        scopes: scopes.length > 0 ? scopes : grant.scopes,
        lastUsedAt: now,
      });
      return { applied: true };
    }
    // Revoked by the person, or by their own client: either way the person acted.
    const by = actor ?? grant.userId;
    await ctx.db.patch(grant._id, { status: "revoked", revokedAt: now });
    await recordAudit(ctx, {
      workspaceId: grant.workspaceId,
      actorUserId: by,
      actorClientId: grant.clientId,
      action: "grant.revoked",
      details: { onBehalfOfSelf: by === grant.userId, via: "object" },
    });
    return { applied: true };
  },
});


