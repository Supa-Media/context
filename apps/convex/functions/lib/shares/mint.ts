/**
 * Note shares — handing one document to one person who is not a member.
 *
 * The product problem this solves is narrow and worth stating exactly, because
 * every temptation to widen it is a security regression wearing a feature
 * request. Somebody wants to send a colleague a link to *one note*. Today the
 * only way to let another person read anything is `inviteMember`, which makes
 * them a member of the whole context: they can connect an AI client to it, and
 * that client sees every note the owner has marked `team`. Nobody sharing a
 * meeting summary means to hand over their filing cabinet.
 *
 * So a share is deliberately **not** a membership, and this module writes
 * nothing to `workspaceMembers`. It is a standing grant, addressed to a person,
 * over one path, that the owner can revoke.
 *
 * ## A share narrows; it can never widen
 *
 * Two rules carry that, and only the first one lives here:
 *
 *  - The path must be a real note and not plumbing. `privacy.md` is the access
 *    map — handing it over enumerates every private folder by name — and
 *    everything under a dot-folder is `.history/`, which holds every revision of
 *    every note the owner has ever written, private ones included.
 *  - **The note must still be `team`-visible on every read.** That is not
 *    checked here, and its absence is deliberate rather than an omission: a
 *    creation-time check reads a bucket, and its answer goes stale the moment
 *    the owner changes their mind in `privacy.md`. The read path re-derives it
 *    from the live manifest every time, which is the only place the answer can
 *    be true. A courtesy check at creation may be added for the owner's benefit
 *    — it must never become the thing the read path relies on.
 *
 * ## A share box is not an existence oracle
 *
 * The whole of `functions/invitations.ts`' module comment applies unchanged.
 * The attacker is the *sharer*: anybody with an account has a share box, so a
 * share addressed to `@nobody` must be indistinguishable from one addressed to
 * a real person. The recipient is therefore stored as the string that was
 * typed and resolved only when somebody presents the token.
 *
 * ## The one thing that differs from an invitation, and why it is safe
 *
 * `inviteMember` returns `null` so there is no field for a difference to hide
 * in. `createShare` returns the token, because the deliverable is a link the
 * owner pastes into a chat, and a flow that made them go and find it elsewhere
 * is a flow nobody uses.
 *
 * That is safe because the token is minted from `crypto.getRandomValues`
 * **before anything is looked up**, so it is drawn from the same distribution
 * whether the recipient exists or not. What the invitation rule forbids is a
 * return value derived from the recipient. This one is derived from a CSPRNG.
 * `__tests__/shares.test.ts` compares two whole share responses — one to a real
 * handle, one to a handle nobody has claimed — with the tokens removed, so the
 * moment any other field starts varying, that test fails.
 *
 * ## Where this lives
 *
 * This was `functions/shares.ts`' module comment. That file keeps every
 * registered share function; this module holds the mints behind
 * `createShare`, `createTeamShare` and the gateway's `gatewayMintTeam`,
 * which is where "the module comment" referred to below is argued, and
 * registers nothing itself.
 */

import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { MutationCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { recordAudit } from "../audit";
import { findName } from "../nameClaims";
import { randomOpaqueToken } from "../gatewayAuth";
import {
  formatInvitee,
  inviteeRejectionError,
  parseInvitee,
} from "../invitees";
import { normalizePreviewTitle, titleFromPath } from "../shareTitle";
import { scheduleCardRender } from "../../shareCard";
import { requireWorkspaceRole } from "../workspaceAuth";
import { MAX_ACTIVE_SHARES } from "./standing";
import {
  checkSharePath,
  checkTeamSharePath,
  findShareFor,
  pathRejection,
} from "./paths";

export const createShareArgs = {
  workspaceId: v.id("workspaces"),
  path: v.string(),
  /** A `@name` or an email address, exactly as `inviteMember` takes it. */
  recipient: v.string(),
  /** Defaults to `true`. See the schema for what this discloses. */
  titleInPreview: v.optional(v.boolean()),
  /**
   * The title the link unfurls with. Defaults to the note's filename, made
   * readable. Never read from the note's contents — see `lib/shareTitle.ts`.
   */
  previewTitle: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
};

export const createShareReturns = v.object({ token: v.string() });

/**
 * Share one note with one person. Owner-only.
 *
 * Owner-only rather than editor-and-up for the reason `inviteMember` is:
 * writing notes and deciding who reads them are different powers, and an
 * editor was given the first. It matches `resetPrivacyManifest`'s clearance and
 * the ingestion allow-list's, both of which are also "who can see this" rather
 * than "what does this say".
 *
 * Returns the token, which is the link. See the module comment for why that is
 * not the oracle `inviteMember` avoids.
 */
export async function createShareHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof createShareArgs>,
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

  const pathCheck = checkSharePath(args.path);
  if (!pathCheck.ok) throw pathRejection(pathCheck);

  const parsed = parseInvitee(args.recipient);
  if (!parsed.ok) throw inviteeRejectionError(parsed.reason);

  const now = Date.now();
  // `??` rather than a plain default: an owner who typed a title that
  // normalises to nothing gets the filename, not an empty card.
  const chosenTitle =
    args.previewTitle === undefined
      ? titleFromPath(pathCheck.path)
      : (normalizePreviewTitle(args.previewTitle) ?? titleFromPath(pathCheck.path));

  const existing = await findShareFor(
    ctx,
    args.workspaceId,
    pathCheck.path,
    parsed.invitee,
  );

  if (existing !== null && existing.status === "active") {
    // The same grant, not a second one — and it keeps its token, because the
    // owner has already sent that link to the person it addresses. Re-sharing
    // must not quietly break a link somebody is holding.
    await ctx.db.patch(existing._id, {
      titleInPreview: args.titleInPreview ?? existing.titleInPreview,
      previewTitle: chosenTitle ?? existing.previewTitle,
      // `??`, not a plain assignment. Re-sharing without naming an expiry
      // must not silently turn a share the owner time-boxed into a permanent
      // one — the direction an omitted argument fails has to be "less
      // access", and re-sharing is the same grant, not a renewal of it.
      expiresAt: args.expiresAt ?? existing.expiresAt,
    });
    // The title may have changed, so the card may be stale. Scheduled, never
    // awaited: a render that is slow or fails must not make sharing slow or
    // fail. See `scheduleCardRender`.
    await scheduleCardRender(ctx, existing._id);
    return { token: existing.token };
  }

  await assertShareCapacity(ctx, args.workspaceId);

  // Minted before anything about the recipient is looked up. See the module
  // comment: this is what makes returning it safe.
  const token = randomOpaqueToken();

  // Which claim this share is being written against, if any. One indexed
  // lookup that happens whether or not the handle is taken, and whose answer
  // never leaves this function — it is not returned, and `shareSummary` does
  // not carry it. Recording *when* the handle was taken is not resolving it
  // to a person, which is the line `inviteMember` draws and this keeps.
  const heldSince =
    parsed.invitee.kind === "name"
      ? (await findName(ctx, parsed.invitee.value))?.claimedAt
      : undefined;

  let shareId: Id<"noteShares">;
  if (existing !== null) {
    // Revoked, and now re-shared. A **new** token, so the link that was
    // revoked stays dead — otherwise "revoke" would have meant "pause".
    shareId = existing._id;
    await ctx.db.patch(existing._id, {
      status: "active",
      token,
      titleInPreview: args.titleInPreview ?? true,
      previewTitle: chosenTitle ?? undefined,
      expiresAt: args.expiresAt,
      createdBy: userId,
      createdAt: now,
      // Re-pinned with the token and the date, because this is a new grant
      // in every other respect. Carrying the old pin forward would address a
      // fresh share to a claim that may no longer exist.
      recipientHeldSince: heldSince,
      revokedAt: undefined,
    });
  } else {
    shareId = await ctx.db.insert("noteShares", {
      workspaceId: args.workspaceId,
      entryPath: pathCheck.path,
      recipientKind: parsed.invitee.kind,
      recipient: parsed.invitee.value,
      recipientHeldSince: heldSince,
      createdBy: userId,
      token,
      status: "active",
      titleInPreview: args.titleInPreview ?? true,
      previewTitle: chosenTitle ?? undefined,
      expiresAt: args.expiresAt,
      createdAt: now,
    });
  }

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "share.created",
    paths: [pathCheck.path],
    // The identifier the owner typed, never a resolved user id — recording
    // one would be resolving the recipient at write time by another route.
    details: { recipient: formatInvitee(parsed.invitee) },
  });

  await scheduleCardRender(ctx, shareId);
  return { token };
}

export const createTeamShareArgs = {
  workspaceId: v.id("workspaces"),
  path: v.string(),
  titleInPreview: v.optional(v.boolean()),
};

export const createTeamShareReturns = v.object({ token: v.string() });

/**
 * A link to this note for the people who already have access.
 *
 * Separate from `createShare` rather than a flag on it, because the two answer
 * different questions and only one of them has an oracle to worry about.
 * `createShare` is addressed to a *string somebody typed*, and its whole shape
 * — resolve late, return nothing derived from the recipient, refuse only about
 * the string — exists so an invite box cannot enumerate the platform's names.
 * This takes no recipient at all, so none of that applies and folding the two
 * together would put a branch through the middle of that reasoning.
 *
 * **It grants nothing.** Reading is authorised by membership on every request,
 * so removing somebody from the context takes the link with them. What the
 * token buys is that the URL is unguessable — which is what makes it safe for
 * the link's card to carry the note's title, where `/console/@slug?note=…`
 * addresses the same note and must not, because anyone who knows the handle can
 * type that one and probe for which notes exist.
 *
 * Idempotent: one team link per note. Asking twice hands back the same URL,
 * because the owner has probably already pasted it somewhere.
 */
export async function createTeamShareHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof createTeamShareArgs>,
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");
  return await mintTeamShare(ctx, { ...args, actorUserId: userId });
}

/**
 * The body of `createTeamShare`, with the acting identity passed in.
 *
 * Extracted so the gateway can mint the same row for an agent that asked for a
 * link. **The split is auth from work, and nothing else moved**: the public
 * mutation above resolves a browser session, the gateway's route resolves an
 * access token to a grant and a role, and both arrive here having proved
 * `owner` in this workspace. A second copy of the minting — supersession,
 * capacity, the audit line, the card render — is the thing that would drift,
 * so there is one.
 *
 * It takes `actorUserId` and never reads a session, which is what makes it
 * safe to call from both: an identity that is passed in is one the caller had
 * to establish, rather than one this function could be talked into.
 */
export async function mintTeamShare(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    titleInPreview?: boolean;
    actorUserId: Id<"users">;
  },
): Promise<{ token: string }> {
  {
    const userId = args.actorUserId;
    const pathCheck = checkTeamSharePath(args.path);
    if (!pathCheck.ok) throw pathRejection(pathCheck);

    const now = Date.now();
    // `titleFromPath` strips a `.md` that a folder does not have, and titles it
    // by its own last segment either way — `ai-brain-coworker-pilot` becomes
    // "Ai brain coworker pilot", which is what the folder is called.
    const chosenTitle = titleFromPath(pathCheck.path);

    const existing = await ctx.db
      .query("noteShares")
      .withIndex("by_workspace_entry_recipient", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("entryPath", pathCheck.path)
          .eq("recipientKind", "members")
          .eq("recipient", ""),
      )
      .unique();

    if (existing !== null && existing.status === "active") {
      await ctx.db.patch(existing._id, {
        titleInPreview: args.titleInPreview ?? existing.titleInPreview,
        previewTitle: chosenTitle ?? existing.previewTitle,
      });
      await scheduleCardRender(ctx, existing._id);
      return { token: existing.token };
    }

    await assertShareCapacity(ctx, args.workspaceId);
    const token = randomOpaqueToken();

    let shareId: Id<"noteShares">;
    if (existing !== null) {
      // Revoked and re-made. A new token, so a link already taken back stays
      // dead — the same rule `createShare` follows.
      shareId = existing._id;
      await ctx.db.patch(existing._id, {
        status: "active",
        token,
        titleInPreview: args.titleInPreview ?? true,
        previewTitle: chosenTitle ?? undefined,
        createdBy: userId,
        createdAt: now,
        revokedAt: undefined,
      });
    } else {
      shareId = await ctx.db.insert("noteShares", {
        workspaceId: args.workspaceId,
        entryPath: pathCheck.path,
        // Nobody to name. See the schema: one field carries the audience, so
        // there is no second field to disagree with it.
        recipientKind: "members",
        recipient: "",
        createdBy: userId,
        token,
        status: "active",
        titleInPreview: args.titleInPreview ?? true,
        previewTitle: chosenTitle ?? undefined,
        createdAt: now,
      });
    }

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "share.team.created",
      paths: [pathCheck.path],
      details: { audience: "members" },
    });

    await scheduleCardRender(ctx, shareId);
    return { token };
  }
}

/**
 * Refuse a share that would take the context past its outstanding cap.
 *
 * Checked on both paths that produce a live row — the insert, and the patch
 * that turns a revoked row active again — and skipped only where `createShare`
 * has already returned, which is the supersede of a row that is *currently*
 * active. So re-sharing a note is refused for capacity exactly when it would
 * add to the live count.
 *
 * An earlier version of this comment said re-sharing "is never refused for
 * capacity", which was false in the case this cap is most likely to be met in:
 * at the cap with one revoked row, re-sharing that note throws. It reads as a
 * promise to the caller and was not one.
 */
export async function assertShareCapacity(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  const active = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_status", (q) =>
      q.eq("workspaceId", workspaceId).eq("status", "active"),
    )
    // The `+ 1` is not needed by the comparison below — `>=` decides at
    // `MAX_ACTIVE_SHARES`, so a row beyond it cannot change the answer, and
    // sabotaging it away alone fails nothing. It stays because it keeps the
    // guard independent of the operator: paired with a strict `>`,
    // `.take(MAX_ACTIVE_SHARES)` can never exceed the cap and the check stops
    // being a check at all. That pair is caught by the test below — measured,
    // not assumed, after an earlier version of this comment called it silent.
    .take(MAX_ACTIVE_SHARES + 1);
  // `>=`, matching `createWorkspace`'s own limit check. It was `>`, which let a
  // context reach MAX_ACTIVE_SHARES + 1 — one more than the refusal it throws
  // promises, and nothing tested either number.
  if (active.length >= MAX_ACTIVE_SHARES) {
    throw new ConvexError({
      code: "TOO_MANY_SHARES",
      message: `A context may have ${MAX_ACTIVE_SHARES} shares outstanding. Revoke one first.`,
    });
  }
}
