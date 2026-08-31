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
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import { action, internalQuery, mutation, query } from "../_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { normalizePath } from "./lib/fileOps";
import { linkedNotePaths } from "./lib/noteLinks";
import { findName } from "./lib/nameClaims";
import { isProductMandatedPath } from "./lib/scaffold";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { identifiersForUser, resolveAddressedUser } from "./lib/identities";
import {
  formatInvitee,
  inviteeRejectionError,
  parseInvitee,
  type Invitee,
} from "./lib/invitees";
import { isPlumbing } from "./lib/privacy";
import { normalizePreviewTitle, titleFromPath } from "./lib/shareTitle";
import { scheduleCardRender } from "./shareCard";
import { getMembership, requireWorkspaceRole } from "./lib/workspaceAuth";

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
const MAX_SHARES_RETURNED = 200;
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
function shareNotFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "SHARE_NOT_FOUND", message: "Share not found" });
}

/** Whether a share grants anything right now. */
function isLive(share: Doc<"noteShares">, now: number): boolean {
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
async function shareStillStands(
  ctx: QueryCtx,
  share: Doc<"noteShares">,
  userId: Id<"users">,
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

/**
 * The path a share may point at, or a refusal.
 *
 * Three separate judgments, and the order is what makes the refusals honest:
 * a path that does not normalize is malformed (`PATH_INVALID`), and a path that
 * normalizes fine but names something no share may ever cover is a different
 * answer (`PATH_NOT_SHAREABLE`). Collapsing them would tell somebody who typed
 * `privacy.md` that their path was malformed, which it is not.
 *
 * The `.md` requirement is a v1 boundary rather than a security property: the
 * viewer renders Markdown, and a share pointing at a PDF would be a download
 * link with no page to show. Attachments referenced *from* a shared note are a
 * separate problem the read path will have to answer.
 */
type PathCheck =
  | { ok: true; path: string }
  | { ok: false; code: "PATH_INVALID" | "PATH_NOT_SHAREABLE"; message: string };

function checkSharePath(input: string): PathCheck {
  const path = normalizePath(input);
  if (path === null) {
    return { ok: false, code: "PATH_INVALID", message: "That path is not valid." };
  }
  if (isPlumbing(path)) {
    return {
      ok: false,
      code: "PATH_NOT_SHAREABLE",
      message:
        "That file is part of how this context works, not a note. It cannot be shared.",
    };
  }
  if (!path.toLowerCase().endsWith(".md")) {
    return {
      ok: false,
      code: "PATH_NOT_SHAREABLE",
      message: "Only a note can be shared.",
    };
  }
  return { ok: true, path };
}

/**
 * The path a **team link** may point at: anything that is not plumbing.
 *
 * The motivating case is a folder — a team link grants nothing, it is an
 * address whose reader is authorised by membership, so "a link to this folder"
 * is a sentence that means something where "share this folder with one
 * outsider" is not: that would have to decide what a folder share reaches, and
 * it is a scope nobody asked for. Personal shares stay note-only, and
 * `checkSharePath` above is what keeps them there.
 *
 * **But the rule is not "a note or a folder", and an earlier version of this
 * comment said it was** — "wider than `checkSharePath` by exactly one thing: a
 * folder". It is wider by everything that is not `.md`: an image, a PDF, a
 * spreadsheet, an extensionless file. That is deliberate and it is safe for the
 * same reason the folder case is — a member can already read those at their
 * tier and the link confers nothing — but it is a different sentence, and
 * "exactly one thing" would have sent somebody tightening this to a rule that
 * silently breaks links to attachments. There is no way to tell a folder from
 * an extensionless file by path alone anyway, so "note or folder" was never
 * implementable here.
 *
 * Plumbing is refused for both. `.history/` is every revision of every note and
 * `privacy.md` is the access map; neither is a thing to hand anybody a link to,
 * whatever their membership.
 */
function checkTeamSharePath(input: string): PathCheck {
  const path = normalizePath(input);
  if (path === null) {
    return { ok: false, code: "PATH_INVALID", message: "That path is not valid." };
  }
  if (isPlumbing(path)) {
    return {
      ok: false,
      code: "PATH_NOT_SHAREABLE",
      message:
        "That file is part of how this context works, not a note. It cannot be shared.",
    };
  }
  return { ok: true, path };
}

function pathRejection(
  check: Extract<PathCheck, { ok: false }>,
): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: check.code, message: check.message });
}

/**
 * The one row a share to this recipient over this note would occupy, if any.
 *
 * `.unique()` is safe for `findInvitationFor`'s reason: every write goes
 * through this lookup first and Convex mutations are serializable, so a second
 * insert for the same tuple reads the same index range and the loser re-runs.
 */
async function findShareFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  entryPath: string,
  recipient: Invitee,
): Promise<Doc<"noteShares"> | null> {
  return await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_entry_recipient", (q) =>
      q
        .eq("workspaceId", workspaceId)
        .eq("entryPath", entryPath)
        .eq("recipientKind", recipient.kind)
        .eq("recipient", recipient.value),
    )
    .unique();
}


/**
 * How a share's audience is shown to its owner.
 *
 * A person is named; a team share names the rule instead, because there is
 * nobody to name — and "Anyone with access" is the sentence that tells the
 * owner what removing somebody does to it.
 */
function describeAudience(kind: string, recipient: string): string {
  if (kind === "members") return "Anyone with access";
  return formatInvitee({ kind: kind as Invitee["kind"], value: recipient });
}

const shareSummary = v.object({
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
  entryPath: v.string(),
  titleInPreview: v.boolean(),
  previewTitle: v.optional(v.string()),
  createdBy: v.id("users"),
  createdAt: v.number(),
  expiresAt: v.optional(v.number()),
});

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
export const createShare = mutation({
  args: {
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
  },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
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
  },
});

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
export const createTeamShare = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    titleInPreview: v.optional(v.boolean()),
  },
  returns: v.object({ token: v.string() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

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
  },
});

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
async function assertShareCapacity(
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
export const listShares = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(shareSummary),
  handler: async (ctx, args) => {
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
        entryPath: row.entryPath,
        titleInPreview: row.titleInPreview,
        previewTitle: row.previewTitle,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      }));
  },
});

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
export const revokeShare = mutation({
  args: { shareId: v.id("noteShares") },
  returns: v.null(),
  handler: async (ctx, args) => {
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
  },
});

/**
 * Resolve a presented token to the share it addresses to *this* caller.
 *
 * Every refusal is the same `null`, so "never issued", "revoked", "expired" and
 * "addressed to somebody else" are one answer. Revocation in particular must be
 * unobservable: somebody who kept a link and finds out it is now specifically
 * *revoked* has learned that the owner acted, which is not theirs to know.
 *
 * `null` rather than a throw because this is the viewer page's first read and
 * an absence is the ordinary case there — a spent link is not an error, it is a
 * page that says the share is unavailable.
 *
 * Note the order: status and expiry are checked before the identity is
 * resolved, so the lookup that reads other tables never runs for a token that
 * was already dead. Same trade `resolveInvitationForCaller` documents — the
 * timing difference is only reachable by somebody already holding a real token.
 */
export const resolveShare = query({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      shareId: v.id("noteShares"),
      workspaceId: v.id("workspaces"),
      entryPath: v.string(),
      sharedBy: v.id("users"),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const now = Date.now();

    const share = await ctx.db
      .query("noteShares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (share === null) return null;
    if ((await shareStillStands(ctx, share, userId, now)) === null) return null;

    return {
      shareId: share._id,
      workspaceId: share.workspaceId,
      entryPath: share.entryPath,
      sharedBy: share.createdBy,
      createdAt: share.createdAt,
    };
  },
});

/**
 * Everything shared with me. The recipient's own channel.
 *
 * `listMyInvitations`' shape and its discipline: identifiers are *gathered*
 * with `identifiersForUser` so the reads can be narrowed by index, and every
 * row is then put back through `resolveAddressedUser`, which is the authority.
 * A row the gathering found but the authority disowns is dropped.
 *
 * This exists for the same reason the invitation list does: a link is not a
 * guaranteed delivery channel. Somebody who lost the email, or who was
 * addressed by `@name` and never got one, must still be able to find what was
 * shared with them.
 */
export const listSharedWithMe = query({
  args: {},
  returns: v.array(
    v.object({
      token: v.string(),
      workspaceId: v.id("workspaces"),
      slug: v.string(),
      displayName: v.string(),
      entryPath: v.string(),
      sharedBy: v.id("users"),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const now = Date.now();

    const identifiers = await identifiersForUser(ctx, userId);

    const rows: Doc<"noteShares">[] = [];
    /*
      Team shares are deliberately absent from this list. It answers "what was
      sent to *me*", and a team share was sent to nobody — it is a link into a
      context the reader can already open, so listing it would put every note
      anybody ever linked into a personal inbox.
    */
    for (const identifier of identifiers) {
      const found = await ctx.db
        .query("noteShares")
        .withIndex("by_recipient", (q) =>
          q
            .eq("recipientKind", identifier.kind)
            .eq("recipient", identifier.value)
            .eq("status", "active"),
        )
        .take(MAX_SHARES_RETURNED);
      rows.push(...found.filter((row) => isLive(row, now)));
    }

    const summaries = [];
    for (const row of rows) {
      // The authority, not the gathering above — and the same predicate the
      // link path answers, so this inbox can never be the softer of the two.
      const workspace = await shareStillStands(ctx, row, userId, now);
      if (workspace === null) continue;
      summaries.push({
        token: row.token,
        workspaceId: workspace._id,
        slug: workspace.slug,
        displayName: workspace.displayName,
        entryPath: row.entryPath,
        sharedBy: row.createdBy,
        createdAt: row.createdAt,
      });
    }
    return summaries;
  },
});

/* -------------------------------------------------------------------------- */
/*                              the read path                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a share reaches: the note it names, plus the notes that note links to.
 *
 * One hop, not a graph walk, and that boundary is a decision rather than a
 * first draft. The handoff proposed following links from "already authorized"
 * notes with a depth cap, which sounds equivalent and is not: at depth two, a
 * note the owner linked to becomes a *source* of authorization, so anybody with
 * `editor` on this context can extend somebody else's share by adding a link to
 * a note that was never part of it. Depth one keeps the whole grant a function
 * of one note the owner chose and read.
 *
 * It is also the only version that can be stated to a person in one sentence —
 * "they can read this note and the notes it links to" — and a sharing rule
 * nobody can predict is a sharing rule nobody can use safely.
 *
 * If a packet ever needs to be deeper than this, the answer is the explicit
 * allowlist the handoff names as the fallback, not a bigger number here.
 */
const SHARE_TRAVERSAL_DEPTH = 1;

/**
 * One answer for every way a share read can fail to be authorized.
 *
 * Revoked, expired, never issued, addressed to somebody else, entry note
 * deleted, entry note no longer `team`-visible, target not linked from the
 * entry note — all of it is one sentence. Somebody holding a link who could
 * tell "the owner revoked this" from "the owner made it private" from "the note
 * moved" has learned three different things about a context they are not in.
 *
 * Deliberately NOT used for infrastructure failure. A bucket that is
 * unreachable is not an authorization answer, and reporting it as one would
 * tell a viewer their access was withdrawn when it was not — see
 * `readSharedNote`.
 */
function shareUnavailable(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "SHARE_UNAVAILABLE",
    message: "This shared note is not available.",
  });
}

/**
 * Resolve a token to the grant it represents, for the read path.
 *
 * INTERNAL. `actorUserId` is supplied by the calling public action, which read
 * it from the session — the same arrangement `authorizeFileAccess` uses, and
 * safe for the same reason: an internal function is unreachable from any
 * client, so there is nobody who could pass a forged one.
 *
 * Returns `null` rather than throwing so the caller raises one uniform error
 * for this and for every later refusal; two error shapes on one path is how a
 * distinction gets reintroduced by accident.
 */
export const authorizeShareRead = internalQuery({
  args: { actorUserId: v.id("users"), token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      shareId: v.id("noteShares"),
      workspaceId: v.id("workspaces"),
      entryPath: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const share = await ctx.db
      .query("noteShares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (share === null) return null;
    // The same predicate the link and the inbox answer. This is the third place
    // that decides who may redeem a share, and the only one that returns note
    // **content**, so it must never be the softest of the three — which it was.
    // The freed-handle and destroyed-context checks went into the other two and
    // this kept an older, shorter copy; `CLAUDE.md` names the shape for the
    // gateway ("authority is decided once, never per protocol era"), and a
    // control plane drifts the same way. Measured before this line existed: a
    // share whose workspace document is gone, and one whose sharer is no longer
    // the owner, both returned the note's text.
    if ((await shareStillStands(ctx, share, args.actorUserId, now)) === null) return null;

    return {
      shareId: share._id,
      workspaceId: share.workspaceId,
      entryPath: share.entryPath,
    };
  },
});

/**
 * Read a note through a share.
 *
 * The whole authorization argument, in the order it happens:
 *
 *  1. **The caller is signed in.** A share URL is a locator, never a
 *     credential; there is no unauthenticated path to note content anywhere in
 *     this product and this must not become the first one.
 *  2. **The token resolves to a live grant addressed to this caller.**
 *  3. **The read runs at `team` scope.** Not the caller's role — they have no
 *     role here, they are not a member — but the fixed tier a share can ever
 *     reach. `readFile` then puts the path through the live `privacy.md`, so a
 *     note that was `team` when the share was created and is private now reads
 *     as absent. That is why nothing is stored about visibility at creation
 *     time: this is the only place the answer can be current.
 *  4. **A target that is not the entry note must be linked from it**, and the
 *     link is extracted server-side from the entry note's own text. The client
 *     saying "the entry note links to this" authorizes nothing.
 *
 * Step 4 reads the entry note first, which also re-checks step 3 on it: a share
 * whose entry note has been made private grants nothing, including the notes it
 * used to link to.
 *
 * ## Two failure shapes, on purpose
 *
 * Every authorization refusal is one `SHARE_UNAVAILABLE`. A storage failure is
 * not flattened into it: a viewer told "not available" during a bucket outage
 * would reasonably conclude their access was withdrawn, go and ask the owner,
 * and be told it was not. `STORAGE_*` says try again, and says nothing about
 * the note — the bucket's own error text is never forwarded (`toConvexError`).
 */
export const readSharedNote = action({
  args: {
    token: v.string(),
    /** Omit for the entry note. Anything else must be linked from it. */
    path: v.optional(v.string()),
  },
  returns: v.object({
    path: v.string(),
    text: v.string(),
    /** The entry note this share is rooted at, so the viewer can offer a way back. */
    entryPath: v.string(),
    /** Paths the viewer may follow from here — the entry note's links, resolved. */
    links: v.array(v.string()),
  }),
  // Annotated rather than inferred: this action calls another function in the
  // same deployment, which is the inference cycle `runFileOperation` has.
  // Without it the whole generated `api` degrades to `any` and every other
  // test file starts reporting implicit-any on unrelated callbacks.
  handler: async (
    ctx,
    args,
  ): Promise<{
    path: string;
    text: string;
    entryPath: string;
    links: string[];
  }> => {
    const actorUserId = await shareCallerId(ctx);

    const grant = await ctx.runQuery(internal.functions.shares.authorizeShareRead, {
      actorUserId,
      token: args.token,
    });
    if (grant === null) throw shareUnavailable();

    const requested =
      args.path === undefined ? grant.entryPath : normalizePath(args.path);
    if (requested === null) throw shareUnavailable();

    // The entry note is read on every request. It is what step 3 is checked
    // against, and — for a linked target — it is the only thing that authorizes
    // the hop. Reading it twice when it is itself the target is one extra bucket
    // GET on the cheapest possible read, and the alternative is a branch that
    // decides when authorization can be skipped.
    const entry = await readThroughShare(ctx, grant.workspaceId, grant.entryPath);
    const links = linkedNotePaths(entry.text, grant.entryPath);

    if (requested !== grant.entryPath) {
      // `SHARE_TRAVERSAL_DEPTH` is 1: the entry note's own links and nothing
      // further. See the constant.
      if (!links.includes(requested)) throw shareUnavailable();
      const target = await readThroughShare(ctx, grant.workspaceId, requested);
      return {
        path: requested,
        text: target.text,
        entryPath: grant.entryPath,
        links,
      };
    }

    return {
      path: grant.entryPath,
      text: entry.text,
      entryPath: grant.entryPath,
      links,
    };
  },
});

/**
 * The signed-in caller, refused the way a share refuses.
 *
 * `NOT_AUTHENTICATED` rather than `SHARE_UNAVAILABLE`, because "sign in" is
 * something the person can act on and it discloses nothing: they are being told
 * about their own session, not about the share. The viewer page sends them to
 * sign-in and back.
 */
async function shareCallerId(ctx: ActionCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}

/**
 * One note, at `team` scope, through the existing credential barrier.
 *
 * `runFileOperation` is the one function in this codebase that opens a bucket
 * credential, and this deliberately reuses it rather than adding a second: the
 * barrier set in `__tests__/structure.test.ts` is pinned to one member, and
 * "the share read path needs its own" would be exactly the reasoning that
 * turns an enumeration into an amnesty.
 *
 * A missing or invisible note becomes `SHARE_UNAVAILABLE`; anything else — a
 * bucket that is unreachable, a binding that is gone — is passed through. See
 * `readSharedNote` for why those two are not one answer.
 */
async function readThroughShare(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  path: string,
): Promise<{ text: string }> {
  try {
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "team",
      operation: { kind: "read", path },
    });
    if (result.kind !== "file") throw shareUnavailable();
    return { text: result.text };
  } catch (error) {
    const code =
      error instanceof ConvexError
        ? (error.data as { code?: string } | undefined)?.code
        : undefined;
    if (code === "FILE_NOT_FOUND" || code === "PATH_INVALID") throw shareUnavailable();
    throw error;
  }
}

/**
 * The title and card for a **readable** team link, for the edge router. NO
 * SESSION.
 *
 * `/console/@seyi?note=1-projects/plan.md` is the link an owner copies, because
 * a URL pasted into a document should say what it points at — a 64-character
 * token tells a reader nothing. That readability is the whole reason this
 * exists rather than the token lookup beside it.
 *
 * ## The oracle this opens, and what bounds it
 *
 * A console URL is **guessable**: anyone who knows the handle can type one. So
 * answering "what is this note called" to an unauthenticated crawler does let
 * somebody probe paths and learn which exist.
 *
 * What bounds it is that this answers **only for notes the owner has
 * explicitly team-linked** — pressing Copy link is what writes the row. A note
 * nobody has linked is byte-identical to a note that does not exist, so the
 * probe reveals the set the owner already chose to publish a card for, and
 * nothing about the rest of the context. The owner accepted that trade
 * deliberately, with the alternative (an unguessable token) in front of them,
 * because an unreadable link is one nobody clicks.
 *
 * Everything else the token lookup refuses, this refuses too: no owner, no
 * context name, no path, no dates, no counts, no listing. One field.
 *
 * `cardToken` is the team share's token, and it is safe to hand over here
 * **because a team share's token grants nothing** — reading is authorised by
 * membership on every request. It is a locator for the card image and not a
 * capability. This must never return a *personal* share's token, which is a
 * locator whose holder the owner chose; the query below only ever looks at
 * `members` rows.
 */
export const previewForNote = query({
  args: { slug: v.string(), path: v.string() },
  returns: v.object({
    title: v.union(v.string(), v.null()),
    cardToken: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const nothing = { title: null, cardToken: null };

    const name = await findName(ctx, args.slug.replace(/^@/, "").toLowerCase());
    if (name?.workspaceId === undefined) return nothing;

    // **The rule is guessability, and it is not "files yes, folders no".**
    //
    // This query is unauthenticated. What licenses it answering at all is the
    // rule in CLAUDE.md that a card may carry a title where the address is not
    // guessable — `/s/<64 hex>` is 32 random bytes the owner handed to one
    // person, so "the requester may not have been meant to have this URL" does
    // not hold. A team link is `/@name/path`, which IS guessable, and the
    // decision survived that only because the probe space was names the owner
    // chose.
    //
    // Folders were refused wholesale for a real reason: `applyStructure` writes
    // `0-inbox`, `1-projects`, `2-areas`, `3-resources` and `4-archive` into
    // every brain this product creates, so five guesses per handle were enough
    // to learn which of them their owner had team-linked, and to be handed its
    // title and a live token, unauthenticated.
    //
    // But that is an argument about **those five names**, not about folders.
    // `1-projects/public-worship-chapter-transition-and-people-system` is no
    // more guessable than a note filename, and refusing it cost a card for
    // nothing — which is the whole reason an owner links a folder at all. So
    // the five names moved into `isProductMandatedPath`, beside the six
    // filenames that were already there for exactly the same reason, and the
    // category rule is gone.
    //
    // Stated precisely, because an earlier version of this comment overstated
    // the leak: a live `noteShares` row is still required below, so this was
    // never a bare handle-existence oracle. What it published was which of a
    // brain's scaffolded paths its owner had team-linked.
    const path = normalizePath(args.path);
    if (path === null || isPlumbing(path)) return nothing;

    // **One list, and it is the whole rule now.**
    //
    // `isProductMandatedPath` names every path this product writes, which is
    // more than what a fresh brain arrives with: the five PARA folders,
    // `index.md`, `privacy.md`, a `README.md` in each folder and `todo.md` at
    // the root — plus the folders the gateway creates LATER, where
    // `save_context` files a session and where a capture lands under its
    // sender's slug. Those are guessable without
    // knowing anything about the owner, so they get the frozen card whether
    // they are a file or a folder.
    //
    // Anything else is a name the owner chose, which is the premise the whole
    // preview rests on — and it is as true of `1-projects/chapter-transition`
    // as it is of `1-projects/chapter-transition/overview.md`.
    if (isProductMandatedPath(path)) return nothing;

    const share = await ctx.db
      .query("noteShares")
      .withIndex("by_workspace_entry_recipient", (q) =>
        q
          .eq("workspaceId", name.workspaceId!)
          .eq("entryPath", path)
          .eq("recipientKind", "members")
          .eq("recipient", ""),
      )
      .unique();

    // Not linked, revoked, expired, or its title switched off — one answer, so
    // a crawler cannot tell "the owner took this back" from "never linked".
    if (share === null || !isLive(share, Date.now())) return nothing;
    if (!share.titleInPreview) return nothing;
    if (share.previewTitle === undefined) return nothing;

    return { title: share.previewTitle, cardToken: share.token };
  },
});

/**
 * The title a share's link unfurls with, for the edge router. NO SESSION.
 *
 * This is the only function in this product that returns anything derived from
 * a workspace to an unauthenticated caller, so the reasoning is written down
 * rather than assumed.
 *
 * ## Why it may exist at all
 *
 * `infra/router/src/preview.ts` freezes every name-bearing path to one card,
 * because `/@seyi` is **guessable** and a nicer preview would be an existence
 * oracle for usernames. A share URL is not guessable: it carries 32 bytes from
 * `crypto.getRandomValues` that the owner deliberately handed to somebody. The
 * rule the frozen card protects is intact; this is a different input.
 *
 * The trade was made explicitly by the product owner and is worth restating
 * because it is a real cost: **anybody holding the URL learns the title without
 * signing in** — everyone in the Slack channel it was pasted into, everyone on
 * the email thread, and the corporate link scanner that follows it. That is the
 * price of a link people will actually click, and it is per-share revocable
 * (`titleInPreview`) — for *future* crawls. A card that has already
 * been unfurled cannot be retracted: Discord and WhatsApp copy the image to
 * their own CDNs, and iMessage bakes it into the sent message. Treat anything
 * that reaches a card as permanently public.
 *
 * ## What holds the line
 *
 *  - **The title is never note content.** It is owner-chosen or derived from
 *    the filename, so an unfurl never reads the customer's bucket. See
 *    `lib/shareTitle.ts`. It is also **stored at share time**, so revoking and
 *    expiring freeze the card and making the note private does not: the read
 *    path re-checks the live manifest on every request, this does not, and it
 *    has nothing to re-check against. Revocation is the control here.
 *  - **One shape, always.** Unknown token, revoked share, expired share,
 *    `titleInPreview` off, a share whose title normalised to nothing — every
 *    one of them is `{ title: null }`. A crawler cannot tell revoked from
 *    never-issued, which is what stops an unfurl from reporting that an owner
 *    has acted.
 *  - **Nothing else is returned.** Not the workspace, the slug, the owner, the
 *    path, the recipient, or the dates. Adding a field here publishes it to the
 *    internet.
 *
 * ## What does not hold the line, and is not claimed to
 *
 * Timing. One indexed lookup happens either way, so the difference is small,
 * but this is not constant-time and should not be described as such. It is
 * acceptable for the reason `resolveInvitationForCaller` gives about its own
 * asymmetry: reaching a live row at all requires already holding a real token,
 * and somebody who holds one learns nothing from how long the answer took.
 */
export const previewTitleForToken = query({
  args: { token: v.string() },
  returns: v.object({ title: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("noteShares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (share === null) return { title: null };
    if (!isLive(share, Date.now())) return { title: null };
    if (!share.titleInPreview) return { title: null };

    return { title: share.previewTitle ?? null };
  },
});
