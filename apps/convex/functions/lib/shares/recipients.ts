/**
 * A share from its recipient's side: resolving a link, the inbox of what was
 * shared with me, and the grant the read path redeems a token for.
 *
 * All three answer through `shareStillStands`, and must keep doing so — see
 * its comment in `./standing.ts`. Split out of `functions/shares.ts`, which
 * keeps every registered function and wires these handlers to them; this
 * module registers none.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { QueryCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { identifiersForUser } from "../identities";
import { getMembership, roleAtLeast } from "../workspaceAuth";
import { MAX_SHARES_RETURNED, isLive, shareStillStands } from "./standing";

export const resolveShareArgs = { token: v.string() };

export const resolveShareReturns = v.union(
  v.null(),
  v.object({
    shareId: v.id("noteShares"),
    workspaceId: v.id("workspaces"),
    entryPath: v.string(),
    sharedBy: v.id("users"),
    createdAt: v.number(),
  }),
);

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
export async function resolveShareHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof resolveShareArgs>,
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  const now = Date.now();

  const share = await ctx.db
    .query("noteShares")
    .withIndex("by_token", (q) => q.eq("token", args.token))
    .unique();
  if (share === null) return null;
  if ((await shareStillStands(ctx, share, userId, now)) === null) return null;

  // **An unlisted link was sent to nobody, so there is nobody this answers
  // for.** `shareStillStands` says the link is live and, for an `anyone` row,
  // says it for every caller — which is right for the *read* and wrong here.
  // Every other kind required identity or membership before it, so a signed-in
  // stranger holding a token got `null`; without this they would get the
  // workspace id, the sharer and the mint time, which correlates two unrelated
  // unlisted links to one context and one sharer without opening either note.
  //
  // The reader loses nothing: `readSharedNote` still hands them the note, and
  // `entryPath` with it. This withholds the handle, not the thing the link is
  // for.
  if (share.recipientKind === "anyone") {
    const membership = await getMembership(ctx, share.workspaceId, userId);
    if (membership === null) return null;
  }

  return {
    shareId: share._id,
    workspaceId: share.workspaceId,
    entryPath: share.entryPath,
    sharedBy: share.createdBy,
    createdAt: share.createdAt,
  };
}

export const listSharedWithMeArgs = {};

export const listSharedWithMeReturns = v.array(
  v.object({
    token: v.string(),
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    displayName: v.string(),
    entryPath: v.string(),
    sharedBy: v.id("users"),
    createdAt: v.number(),
  }),
);

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
export async function listSharedWithMeHandler(
  ctx: QueryCtx,
) {
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
}

export const authorizeShareReadArgs = {
  /**
   * The signed-in caller, or `null` for a caller with no session at all.
   *
   * `null` is not a weaker argument that the caller may supply to skip a
   * check — it is the *narrowest* one. With no caller, `shareStillStands`
   * can only answer for an `anyone` share; every other kind resolves an
   * identity or a membership and so returns `null` here. That is what makes
   * one uniform refusal safe on the anonymous path: an invented token, a
   * personal token, a members-only token and a revoked unlisted token all
   * come back the same way.
   */
  actorUserId: v.union(v.id("users"), v.null()),
  token: v.string(),
};

export const authorizeShareReadReturns = v.union(
  v.null(),
  v.object({
    shareId: v.id("noteShares"),
    workspaceId: v.id("workspaces"),
    entryPath: v.string(),
    /**
     * Whether `entryPath` is one note or a folder whose subtree this reaches.
     *
     * Defaulted to `note` where the row has no field, which is every row
     * written before folder links: a share's reach must never depend on a
     * backfill having run, and the direction this must fail is "an old row
     * reaches one note", never "an old row reaches a subtree".
     */
    entryKind: v.union(v.literal("note"), v.literal("folder")),
    /**
     * Whether this link is taking answers to a form on what it points at.
     *
     * Reported rather than inferred downstream: the viewer draws a form on
     * the strength of it, and the read path *narrows* on it — see the
     * traversal bound, which a collect link does not get.
     */
    collecting: v.boolean(),
    /**
     * Whether this share needs no session at all.
     *
     * Reported rather than inferred downstream, because the viewer has a
     * decision that genuinely depends on it: a reader whose session drops
     * while a note is on screen must stop being shown it, and a reader who
     * never had one must not. Deriving that from "is there a session now"
     * gets one of the two wrong whichever way it is written.
     */
    openToAnyone: v.boolean(),
    /**
     * The context's slug, for a caller who may **edit** this note there.
     *
     * `null` for everybody else, and that is the whole disclosure argument:
     * a share page is read-only by construction, and the only person it can
     * offer a way out of that to is somebody whose own membership already
     * lets them edit. Telling them the slug of a context they are a member
     * of tells them nothing — they can list it. Telling anybody else would
     * name a context to a stranger holding a link, which is what the card's
     * whole frozen-preview rule exists to prevent.
     *
     * Resolved live rather than stored: membership changes, and a route
     * offered on the strength of a role somebody used to have is a button
     * that leads to a refusal.
     */
    editableInContext: v.union(v.string(), v.null()),
  }),
);

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
export async function authorizeShareReadHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof authorizeShareReadArgs>,
) {
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

  // Their own membership, and only ever their own. `member` is deliberately
  // not enough: the console is read-only for that role too, so a route
  // offered to them would lead to the same page they are already on.
  let editableInContext: string | null = null;
  if (args.actorUserId !== null) {
    const membership = await getMembership(ctx, share.workspaceId, args.actorUserId);
    if (membership !== null && roleAtLeast(membership.role, "editor")) {
      const workspace = await ctx.db.get(share.workspaceId);
      editableInContext = workspace?.slug ?? null;
    }
  }

  return {
    shareId: share._id,
    workspaceId: share.workspaceId,
    entryPath: share.entryPath,
    // Absent means a note. Defaulted here, at the one place every reader
    // goes through, rather than at each call site — a call site that forgot
    // would widen an old row from one note to a subtree.
    entryKind: share.entryKind ?? "note",
    // Absent means `read`, which is every row written before collect mode.
    collecting: share.mode === "collect",
    openToAnyone: share.recipientKind === "anyone",
    editableInContext,
  };
}
