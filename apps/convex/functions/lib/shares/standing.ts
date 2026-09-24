/**
 * Whether a share grants anything, and the caps on how many there may be.
 *
 * Split out of `functions/shares.ts`, which keeps every registered function;
 * this module registers none. `shareStillStands` is the one predicate every
 * channel that answers a share's caller goes through — see its own comment.
 */

import { ConvexError } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { findName } from "../nameClaims";
import { resolveAddressedUser } from "../identities";
import { getMembership } from "../workspaceAuth";

/**
 * Caps on how many rows one response carries, and on how many shares one
 * context may have outstanding.
 *
 * Same reasoning as `MAX_INVITATIONS_RETURNED`: an unbounded `.collect()` is a
 * read whose cost is set by whoever can insert rows.
 *
 * **The active cap does not bound the table, and this comment used to say it
 * did.** Supersession means at most one row per `(workspace, note, recipient)`,
 * so clicking Share twice makes one row — but the tuple space itself is
 * unbounded: share note A, revoke, share note B, revoke, forever. Only *active*
 * rows are capped, and revoked ones accumulate for the life of a context. The
 * teardown in `account.ts` sweeps both statuses and says the same thing about
 * its own cost.
 */
export const MAX_SHARES_RETURNED = 200;
export const MAX_ACTIVE_SHARES = 100;

/**
 * One error for "no such share", "not yours", and "already revoked".
 *
 * `workspaceNotFound()`'s discipline, for `revokeShare`'s benefit: a share id
 * is an opaque handle, so an error that distinguished "real but somebody
 * else's" from "never existed" would confirm a guessed id, and one that
 * distinguished "already revoked" from "unknown" would let anybody who kept a
 * link find out whether the owner had noticed.
 */
export function shareNotFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "SHARE_NOT_FOUND", message: "Share not found" });
}

/** Whether a share grants anything right now. */
export function isLive(share: Doc<"noteShares">, now: number): boolean {
  return (
    share.status === "active" &&
    (share.expiresAt === undefined || share.expiresAt > now)
  );
}

/**
 * Whether this share still stands, for this caller, right now.
 *
 * **The one predicate, read by all three channels that answer a caller.**
 * `resolveShare` answers a link somebody was sent; `listSharedWithMe` is the
 * recipient's own inbox and is the channel that needs no link at all;
 * `authorizeShareRead` is what stands between a token and the note's bytes.
 * Three copies of this reasoning would be three places for it to drift, and it
 * already had: the inbox handed somebody a token the link would have refused,
 * and the read path — added later, in `#104` — kept a shorter copy than either.
 *
 * **`previewTitleForToken` is a fourth reader of these rows and deliberately
 * does not come through here**, which is worth writing down rather than
 * leaving for the next person to rediscover as a bug. It is unauthenticated,
 * so there is no caller for this function to check anything against; it
 * returns only the owner-chosen title, which whoever holds the link already
 * has by design; and it checks `isLive`, which the teardown sets — so the
 * states this predicate exists to catch are unreachable there through any
 * public path. A reviewer cleared it on exactly that reasoning and the
 * reasoning was recorded nowhere, which is how an exemption becomes a hole.
 *
 * Returns the workspace when the share stands, `null` otherwise. `null` is the
 * only failure value: every reason a share does not stand must be
 * indistinguishable from every other, and from a token that never existed.
 *
 * ## Why redemption re-checks at all, when the teardown sweeps
 *
 * `deleteWorkspaceCascade` now takes this table with it, and a freed identifier
 * revokes the shares addressed to it. Neither is what this function is for.
 * The rule this codebase already follows is **sweep at teardown AND re-check at
 * redemption**: the cascade is allowed to omit `oauthAuthorizations` only
 * because `createGrant` re-checks membership when a code is redeemed, and that
 * second check is the reason the omission is inert rather than a hole. A table
 * added to the schema and not to the teardown is a mistake somebody will make
 * again — it is how this one was found — so the capability must not depend on
 * the sweep having been remembered.
 *
 * **How much of that is true here, exactly.** The context and sharer checks
 * below hold for every share. The identifier check does not: it can only fire
 * on a row carrying a pin, and a share written to a handle nobody held yet
 * carries none by design — so do rows written before the field existed. For
 * those the sweep is the only control, which is why its completeness is
 * test-held rather than assumed. Saying "belt and braces" about a population
 * wearing one belt is the kind of claim this file is otherwise careful not to
 * make.
 *
 * ## The handle has to be the same handle
 *
 * A share is addressed to a **string**, and resolved only here. That is
 * deliberate, for `inviteMember`'s anti-enumeration reason, and it is what lets
 * a handle change hands while a standing capability waits: `@lk` deletes their
 * account, somebody else claims `lk`, and every share addressed to `@lk`
 * resolves to a stranger.
 *
 * So a name-addressed share is pinned to `recipientHeldSince` — the claim it
 * was written against, or nothing if the handle was free. The schema carries
 * the reasoning, including why the obvious cheaper version ("the claim must
 * predate the share") breaks sharing with somebody who has not signed up yet.
 *
 * `claimedAt` is not a unique key, and `claim._creationTime` would be. The
 * reason for using it anyway is that **there is no better pin available**, not
 * that the alternatives are dangerous — an earlier version of this comment
 * argued the latter and overstated it, since a snapshot restore preserves
 * `_creationTime` and only a table-copy migration regenerates it. The real
 * shortlist is three long: `_creationTime` and `claim._id` carry that same
 * narrow migration exposure, and `claimedBy` would pin to a *person*, which
 * means resolving the recipient at write time — precisely what `inviteMember`
 * refuses to do, and the reason this field stores a moment rather than an
 * identity.
 *
 * So the residue is stated rather than argued away: two claims of the same
 * handle inside one millisecond compare equal and the second inherits. It
 * needs a deletion and a re-claim in two transactions a millisecond apart, and
 * an attacker controls neither the victim's deletion nor its timing. It is
 * also, unusually for this file, a **fail-open** residue, which is why it is
 * written down here rather than left to be rediscovered.
 *
 * There is no equivalent for an email-addressed share: `emailVerificationTime`
 * is re-stamped on every verifying sign-in, so it pins nothing. The teardown
 * sweep covers the case that actually occurs here — an account deleted, its
 * address free, a stranger verifying it — and what remains open is a mailbox
 * changing hands outside Context entirely, which no check inside this function
 * can see. That is a live design question about how long a share to an address
 * should stand, and it is a *gap*, not a decision: `shares.test.ts` pins both
 * the sweep and the residue rather than leaving this paragraph as the only
 * record.
 */
export async function shareStillStands(
  ctx: QueryCtx,
  share: Doc<"noteShares">,
  userId: Id<"users"> | null,
  now: number,
): Promise<Doc<"workspaces"> | null> {
  if (!isLive(share, now)) return null;

  // The context it points into. A destroyed workspace takes its shares with it
  // at teardown; this is what makes a row that outlived it inert anyway.
  //
  // **This line is not a guard, and saying so is the point.** Removing it
  // changes no behaviour and fails no test: the function returns the workspace,
  // so falling through to `return workspace` answers `null` by a longer route.
  // It is here because everything below reads better with a workspace in hand.
  // A sabotage of it passes the whole suite, and listing it in the table below
  // as a checked guard would be exactly the kind of claim the register's rows
  // about invented comments are for.
  const workspace = await ctx.db.get(share.workspaceId);
  if (workspace === null) return null;

  // And the authority behind it. `createShare` is owner-only and ownership is
  // not transferable, so the person who minted this must still be the owner —
  // a share is one person's decision to disclose one note, and it does not
  // outlive their standing to make it.
  const sharer = await getMembership(ctx, share.workspaceId, share.createdBy);
  if (sharer === null || sharer.role !== "owner") return null;

  /**
   * An unlisted link is authorised by possession, and by nothing else.
   *
   * This is the only branch that answers without a caller, and it is placed
   * here — after liveness, after the context, after the sharer's standing —
   * rather than first, so that everything an unlisted link shares with every
   * other share is still checked. Revoking it, deleting the context, or the
   * sharer ceasing to be the owner each take it down, exactly as they take
   * down a personal share.
   *
   * What it does NOT decide is what the reader may see. That stays the live
   * `privacy.md` at `team` scope in `readThroughShare`, which is why nothing
   * about visibility is stored on the row: a note made private after the link
   * was pasted is absent through it, and the only place that answer can be
   * current is the read itself.
   */
  if (share.recipientKind === "anyone") return workspace;

  if (share.recipientKind === "name" && share.recipientHeldSince !== undefined) {
    const claim = await findName(ctx, share.recipient);
    // `claim?.` rather than an early null check, which would look like a guard
    // and not be one: an unclaimed handle is already refused below, because
    // `resolveAddressedUser` resolves it to nobody. Written this way the line
    // does exactly one job — compare the pin — and a missing claim fails it for
    // the same reason a wrong one does.
    //
    // Pinned to the claim the share was addressed to, when there was one. An
    // absent pin means nobody held the handle at share time, so the first
    // person to claim it is who the sharer meant — see the schema.
    //
    // This began as `claim.claimedAt > share.createdAt`, i.e. "a claim made
    // after the share cannot be the claim the sharer addressed". That is false
    // for the one case it most needed to be true for, and a review caught it:
    // a share written to a handle nobody holds yet is a supported flow, and
    // that comparison made it permanently unredeemable the moment the intended
    // recipient signed up — silently, on both sides, with re-sharing unable to
    // repair it because the active-row branch freezes `createdAt`.
    if (claim?.claimedAt !== share.recipientHeldSince) return null;
  }

  /**
   * A team share is authorised by membership, not by identity.
   *
   * The token is what makes the *link* unguessable; it is not what grants
   * access, and that distinction is the whole design. Somebody removed from
   * this context loses the note while holding the same URL, which is what
   * "anyone with access" has to mean — and it is why this checks membership
   * live on every read rather than recording who was a member when the link
   * was made.
   *
   * `getMembership` and not `requireWorkspaceAccess`: a non-member must fall
   * through to the caller's single `null`, not raise `WORKSPACE_NOT_FOUND`,
   * because every refusal on this path is one answer.
   */
  /**
   * Every kind below this line resolves a caller, so there has to be one.
   *
   * The `anyone` branch above is the *only* answer a null caller can get, and
   * this is what makes that true rather than incidental: without it, `null`
   * would fall into `getMembership` and `resolveAddressedUser` as a value to
   * compare against, and both of those answer "no" today by luck rather than
   * by rule. A future helper that treated an absent caller as a wildcard would
   * turn every share in the table into an unlisted one.
   */
  if (userId === null) return null;

  if (share.recipientKind === "members") {
    const membership = await getMembership(ctx, share.workspaceId, userId);
    return membership === null ? null : workspace;
  }

  // Last, and the authority on who an identifier belongs to.
  const addressed = await resolveAddressedUser(ctx, {
    kind: share.recipientKind,
    value: share.recipient,
  });
  if (addressed === null || addressed !== userId) return null;

  return workspace;
}
