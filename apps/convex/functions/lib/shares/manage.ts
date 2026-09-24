/**
 * The owner's view of their shares: listing them, taking one back, naming one,
 * and switching a link's answer-taking on or off.
 *
 * Split out of `functions/shares.ts`, which keeps every registered function
 * and wires these handlers to them; this module registers none.
 */

import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { recordAudit } from "../audit";
import { shortLinkSlugRejection } from "../shareSlug";
import { formatInvitee, type Invitee } from "../invitees";
import { scheduleCardRender } from "../../shareCard";
import { getMembership, requireWorkspaceRole } from "../workspaceAuth";
import { MAX_SHARES_RETURNED, isLive, shareNotFound } from "./standing";

/**
 * How a share's audience is shown to its owner.
 *
 * A person is named; a team share names the rule instead, because there is
 * nobody to name — and "Anyone with access" is the sentence that tells the
 * owner what removing somebody does to it.
 */
export function describeAudience(kind: string, recipient: string): string {
  if (kind === "members") return "Anyone with access";
  // Named the way the owner has to weigh it. "Public" would be shorter and
  // would describe a listing; this link is not listed anywhere and is not
  // indexed — what it actually is, and the whole of what it is, is that
  // holding the URL is enough.
  if (kind === "anyone") return "Anyone with the link";
  return formatInvitee({ kind: kind as Invitee["kind"], value: recipient });
}

export const shareSummary = v.object({
  shareId: v.id("noteShares"),
  /**
   * The link, returned to the owner who minted it.
   *
   * Not a disclosure: `listShares` is owner-only, and the owner is who
   * `createShare` handed this to in the first place. Without it the console
   * could offer "Copy link" only in the seconds after a share was created, and
   * somebody who closed the dialog would have to revoke and re-share — which
   * breaks the link they had already sent.
   */
  token: v.string(),
  /** Decorated for display: `@lk`, or a bare address. */
  recipient: v.string(),
  /**
   * Which kind of audience `recipient` is describing.
   *
   * A projection of `recipientKind`, never a second stored field — the schema
   * keeps one field for the audience precisely so its two halves cannot
   * disagree. The console needs the discriminator rather than the sentence,
   * because "Anyone with the link" has to be drawn differently from a person:
   * it is the one row whose reader never signs in, and a share list that made
   * it look like the others would be the list failing to say the one thing
   * about it that matters.
   */
  audience: v.union(
    v.literal("name"),
    v.literal("email"),
    v.literal("members"),
    v.literal("anyone"),
  ),
  entryPath: v.string(),
  titleInPreview: v.boolean(),
  previewTitle: v.optional(v.string()),
  /**
   * The short link's name, or absent for a share that has only its token.
   *
   * Owner-only like `token` beside it, and for the same reason: this is the
   * other half of the link the owner already holds. The console needs it to
   * draw what was claimed, and to stop a second row claiming it.
   */
  slug: v.optional(v.string()),
  /**
   * Whether this link **takes answers** to a form on what it points at.
   *
   * Reported to the owner because it is the one thing about a link they have
   * to be able to see: every other share row hands out a read, and this one
   * hands out a write from people with no account. A share list that drew a
   * collect link exactly like a read link would be the console being quiet
   * about the only case where non-negotiable #5's exception has teeth.
   */
  collecting: v.boolean(),
  createdBy: v.id("users"),
  createdAt: v.number(),
  expiresAt: v.optional(v.number()),
});

export const listSharesArgs = { workspaceId: v.id("workspaces") };

export const listSharesReturns = v.array(shareSummary);

/**
 * Every live share on this context. Owner-only.
 *
 * Owner-only for the reason the note census is: a member who could enumerate
 * shares would learn which notes their colleagues are sending outside, which is
 * the owner's disclosure record rather than the context's contents.
 *
 * Expired rows are filtered rather than swept. A share with no expiry is the
 * default, so there is no backlog to sweep, and a listing that showed a dead
 * grant as live would be worse than one that runs a comparison.
 *
 * **This deliberately does not go through `shareStillStands`, and the omission
 * is not the drift that function's own doc describes.** That predicate answers
 * "may this caller redeem this share"; the caller here is the owner, who is
 * redeeming nothing. Running it would hide a share addressed to a handle nobody
 * has claimed yet — a supported flow — from the only person who can revoke it,
 * and worse, hiding it *because* the handle is unclaimed would turn an owner's
 * own share list into an existence oracle for the recipient. Recorded here
 * because the next reader will otherwise see a missing call and take it for the
 * bug that `authorizeShareRead` actually had.
 */
export async function listSharesHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof listSharesArgs>,
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

  const now = Date.now();
  const rows = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_status", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("status", "active"),
    )
    .take(MAX_SHARES_RETURNED);

  return rows
    .filter((row) => isLive(row, now))
    .map((row) => ({
      shareId: row._id,
      token: row.token,
      recipient: describeAudience(row.recipientKind, row.recipient),
      audience: row.recipientKind,
      entryPath: row.entryPath,
      titleInPreview: row.titleInPreview,
      previewTitle: row.previewTitle,
      slug: row.slug,
      // Absent means `read`, which is every row written before collect mode.
      collecting: row.mode === "collect",
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
}

export const revokeShareArgs = { shareId: v.id("noteShares") };

export const revokeShareReturns = v.null();

/**
 * Take a share back. Owner-only, immediate, and final for that token.
 *
 * The order of the three checks is the authorization story. The row is read
 * first because the id is the only handle there is, but a caller who is not a
 * member of its context is told the share does not exist rather than that they
 * lack a role — they must not learn that the id is real. A *member* gets
 * `INSUFFICIENT_ROLE`, which discloses nothing they did not already know: they
 * can see the context exists, so the only new fact is that this action needs
 * `owner`, and that is the only thing they can act on.
 */
export async function revokeShareHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof revokeShareArgs>,
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;

  const share = await ctx.db.get(args.shareId);
  if (share === null || share.status !== "active") throw shareNotFound();

  const membership = await getMembership(ctx, share.workspaceId, userId);
  if (membership === null) throw shareNotFound();

  await requireWorkspaceRole(ctx, share.workspaceId, userId, "owner");

  await ctx.db.patch(share._id, { status: "revoked", revokedAt: Date.now() });

  await recordAudit(ctx, {
    workspaceId: share.workspaceId,
    actorUserId: userId,
    action: "share.revoked",
    paths: [share.entryPath],
    details: {
      recipient: describeAudience(share.recipientKind, share.recipient),
    },
  });

  return null;
}

export const setShareSlugArgs = {
  shareId: v.id("noteShares"),
  /** The name to claim, or `null` to give it back. */
  slug: v.union(v.string(), v.null()),
};

export const setShareSlugReturns = v.null();

/**
 * Claim or release the name in `context.lc/@seyi/intake`. Owner-only.
 *
 * ## What this does and does not change
 *
 * It adds a second **locator** for a share that already exists. The row is
 * unchanged, its token still works, revoking it still kills both addresses at
 * once, and the read path below resolves a slug to this row and then runs the
 * same `authorizeShareRead` every other reader runs. Nothing here widens what
 * the share reaches or who may read it.
 *
 * What it does change is who can *arrive*. A token is 32 random bytes handed
 * to somebody; a slug can also be typed by a stranger who guessed it. For an
 * `anyone` row, arriving is the whole of the authorization — so claiming a
 * slug on one is publishing that note to whoever guesses the word. That is the
 * product the owner asked for, it is said in the console before the button,
 * and it is why this is its own deliberate step rather than something
 * `createLinkShare` does on the way past.
 *
 * ## Uniqueness is a read, because Convex has no unique index
 *
 * One live row per `(workspaceId, slug)`, checked through `by_workspace_slug`
 * before the patch. Two owners of one context racing for the same word can
 * both pass that read — the loser overwrites, and the link the winner already
 * pasted stops resolving to their note and starts resolving to somebody
 * else's. So the read is narrowed to *live* rows and the patch refuses when it
 * finds one that is not this share: the race window is one transaction, which
 * Convex serialises, so the check and the write are in the same mutation and
 * there is no window at all. This comment exists because "check then write" in
 * two mutations is the shape that would look equivalent and would not be.
 *
 * A revoked row's slug is free, deliberately. The alternative is a name an
 * owner has permanently spent on their own context.
 */
export async function setShareSlugHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof setShareSlugArgs>,
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;

  // `revokeShare`'s ordering, and for its reason: a caller who is not a
  // member of this share's context is told the share does not exist rather
  // than that they lack a role.
  const share = await ctx.db.get(args.shareId);
  if (share === null || share.status !== "active") throw shareNotFound();
  const membership = await getMembership(ctx, share.workspaceId, userId);
  if (membership === null) throw shareNotFound();
  await requireWorkspaceRole(ctx, share.workspaceId, userId, "owner");

  if (args.slug === null) {
    if (share.slug !== undefined) {
      await ctx.db.patch(share._id, { slug: undefined });
      // The handle has to come back off the picture. See the claim branch.
      await scheduleCardRender(ctx, share._id);
      await recordAudit(ctx, {
        workspaceId: share.workspaceId,
        actorUserId: userId,
        action: "share.slug.released",
        paths: [share.entryPath],
        details: { slug: share.slug },
      });
    }
    return null;
  }

  const slug = args.slug.trim().toLowerCase();
  const rejection = shortLinkSlugRejection(slug);
  if (rejection !== null) {
    throw new ConvexError({ code: "SLUG_REJECTED", message: rejection });
  }

  const now = Date.now();
  const holder = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_slug", (q) =>
      q.eq("workspaceId", share.workspaceId).eq("slug", slug),
    )
    .collect();
  const taken = holder.find(
    (row) => row._id !== share._id && row.status === "active" && isLive(row, now),
  );
  if (taken !== undefined) {
    throw new ConvexError({
      code: "SLUG_TAKEN",
      message: "That name already points at another link in this context.",
    });
  }

  await ctx.db.patch(share._id, { slug });
  /*
    THE CARD IS REDRAWN, BECAUSE WHAT IT MAY SAY JUST CHANGED.

    A card leads with the workspace handle only where the link's own address
    already carries it — which is to say, only where this row has a slug. So
    claiming one is the moment a card may gain the handle, and releasing one
    is the moment it must lose it again.

    The leaf is computed from the token, the title and the children, none of
    which moved here, so this overwrites the same object rather than
    orphaning the old one. Scheduled and never awaited: a render that fails
    leaves the previous card standing, which is the same degrade every other
    caller of this helper accepts.
  */
  await scheduleCardRender(ctx, share._id);
  await recordAudit(ctx, {
    workspaceId: share.workspaceId,
    actorUserId: userId,
    action: "share.slug.claimed",
    paths: [share.entryPath],
    details: { slug, audience: share.recipientKind },
  });
  return null;
}

export const setShareCollectingArgs = { shareId: v.id("noteShares"), collecting: v.boolean() };

export const setShareCollectingReturns = v.null();

/**
 * Turn a link's answer-taking on or off, without re-minting it.
 *
 * ## Why this is its own mutation rather than `createLinkShare` with a mode
 *
 * `createLinkShare` supersedes: it can mint, and on a live row it patches. An
 * owner flipping a switch is neither minting nor superseding — and routing a
 * toggle through a *creation* path is how a press of "off" ends up handing
 * somebody a new token for a link they had already sent.
 *
 * ## Only an `anyone` link over a note
 *
 * The same two rules `collect.ts` enforces on an already-written row and
 * `mintUnlistedLink` enforces at the mint, said a third time at the third
 * door — because a rule enforced in two of the three places a row can be
 * written is a rule with one way around it. A members link has readers with
 * accounts; a folder link reaches a subtree.
 *
 * The refusal order is `revokeShare`'s: a caller who is not a member of this
 * share's context is told the share does not exist rather than that they lack
 * a role.
 */
export async function setShareCollectingHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof setShareCollectingArgs>,
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;

  const share = await ctx.db.get(args.shareId);
  if (share === null || share.status !== "active") throw shareNotFound();
  const membership = await getMembership(ctx, share.workspaceId, userId);
  if (membership === null) throw shareNotFound();
  await requireWorkspaceRole(ctx, share.workspaceId, userId, "owner");

  if (args.collecting) {
    if (share.recipientKind !== "anyone") {
      throw new ConvexError({
        code: "COLLECT_NEEDS_A_LINK",
        message: "Only a link anyone can open takes answers; a workspace link already has readers with accounts.",
      });
    }
    if ((share.entryKind ?? "note") !== "note") {
      throw new ConvexError({
        code: "COLLECT_NEEDS_A_NOTE",
        message: "A link that collects answers points at one note, not a folder.",
      });
    }
  }

  // A card's chip and its subtitle both come off `mode`, so the switch has
  // to redraw: a link that started taking answers while its picture still
  // said "sign in to read it" would be the card contradicting the page.
  const mode = args.collecting ? "collect" : "read";
  if ((share.mode ?? "read") === mode) return null;
  await ctx.db.patch(share._id, { mode });
  await scheduleCardRender(ctx, share._id);
  await recordAudit(ctx, {
    workspaceId: share.workspaceId,
    actorUserId: userId,
    // Turning answer-taking on is a publication decision, so it gets its own
    // line in the trail rather than riding on `share.link.created`.
    action: args.collecting ? "share.collect.opened" : "share.collect.closed",
    paths: [share.entryPath],
    details: { audience: share.recipientKind },
  });
  return null;
}
