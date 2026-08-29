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
import { getMembership, requireWorkspaceRole } from "./lib/workspaceAuth";

/**
 * Caps on how many rows one response carries, and on how many shares one
 * context may have outstanding.
 *
 * Same reasoning as `MAX_INVITATIONS_RETURNED`: an unbounded `.collect()` is a
 * read whose cost is set by whoever can insert rows. The active cap also bounds
 * the table, because supersession means at most one row exists per
 * `(workspace, note, recipient)` however many times the owner clicks Share.
 */
const MAX_SHARES_RETURNED = 200;
const MAX_ACTIVE_SHARES = 100;

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
 * **The one predicate, read by both channels.** `resolveShare` answers a link
 * somebody was sent; `listSharedWithMe` is the recipient's own inbox and is the
 * channel that needs no link at all. Two copies of this reasoning would be two
 * places for it to drift, and the direction that drift fails is "the inbox
 * hands somebody a token the link would have refused" — which is exactly how
 * the freed-name case was found.
 *
 * Returns the workspace when the share stands, `null` otherwise. `null` is the
 * only failure value: every reason a share does not stand must be
 * indistinguishable from every other, and from a token that never existed.
 *
 * ## Why redemption re-checks at all, when the teardown sweeps
 *
 * `deleteWorkspaceCascade` now takes this table with it, and a freed name
 * revokes the shares addressed to it. Neither is what this function is for.
 * The rule this codebase already follows is **sweep at teardown AND re-check at
 * redemption**: the cascade is allowed to omit `oauthAuthorizations` only
 * because `createGrant` re-checks membership when a code is redeemed, and that
 * second check is the reason the omission is inert rather than a hole. A table
 * added to the schema and not to the teardown is a mistake somebody will make
 * again — it is how this one was found — so the capability must not depend on
 * the sweep having been remembered.
 *
 * ## The claim has to predate the share
 *
 * A share is addressed to a **string**, and resolved only here. That is
 * deliberate, for `inviteMember`'s anti-enumeration reason, and it is what lets
 * a handle change hands while a standing capability waits: `@lk` deletes their
 * account, somebody else claims `lk`, and every share addressed to `@lk`
 * resolves to a stranger.
 *
 * So a name-addressed share additionally requires that the current claim on
 * that handle is **older than the share**. The same shape of argument the
 * Cloudflare provisioning path uses for a bucket it may reuse: a claim made
 * after the share was created cannot be the claim the sharer was addressing.
 * `claimedAt` is written once by `claimName` and never moved — there is no
 * rename path — so this is a fact about the claim, not a guess.
 *
 * There is no equivalent for an email-addressed share, and that is stated
 * rather than quietly skipped: a mailbox can also change hands, and nothing
 * here can see when it did. That is a live design question about how long a
 * share addressed to an address should stand, not something to settle inside a
 * predicate.
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

  if (share.recipientKind === "name") {
    const claim = await findName(ctx, share.recipient);
    // Strictly after, so a tie stands. `>=` was tried first, on the usual
    // reasoning that an ambiguous case should fail closed, and it refused two
    // legitimate shares in this repo's own fixtures — a claim and a share
    // landing in the same millisecond is routine when nothing is waiting on a
    // person. It is also unreachable as an attack: the case this closes is a
    // handle **re-claimed after** the share was written, which is at minimum an
    // account deletion apart, so a tie can only be a claim that was already
    // there.
    if (claim === null || claim.claimedAt > share.createdAt) return null;
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
      return { token: existing.token };
    }

    await assertShareCapacity(ctx, args.workspaceId);

    // Minted before anything about the recipient is looked up. See the module
    // comment: this is what makes returning it safe.
    const token = randomOpaqueToken();

    if (existing !== null) {
      // Revoked, and now re-shared. A **new** token, so the link that was
      // revoked stays dead — otherwise "revoke" would have meant "pause".
      await ctx.db.patch(existing._id, {
        status: "active",
        token,
        titleInPreview: args.titleInPreview ?? true,
        previewTitle: chosenTitle ?? undefined,
        expiresAt: args.expiresAt,
        createdBy: userId,
        createdAt: now,
        revokedAt: undefined,
      });
    } else {
      await ctx.db.insert("noteShares", {
        workspaceId: args.workspaceId,
        entryPath: pathCheck.path,
        recipientKind: parsed.invitee.kind,
        recipient: parsed.invitee.value,
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

    return { token };
  },
});

/**
 * Refuse a share that would take the context past its outstanding cap.
 *
 * Checked only on the path that creates a row, so re-sharing an existing note
 * with an existing recipient is never refused for capacity — it does not add
 * one.
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
    .take(MAX_ACTIVE_SHARES + 1);
  if (active.length > MAX_ACTIVE_SHARES) {
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
        recipient: formatInvitee({ kind: row.recipientKind, value: row.recipient }),
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
        recipient: formatInvitee({
          kind: share.recipientKind,
          value: share.recipient,
        }),
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
    if (share === null || !isLive(share, now)) return null;

    const addressed = await resolveAddressedUser(ctx, {
      kind: share.recipientKind,
      value: share.recipient,
    });
    if (addressed === null || addressed !== args.actorUserId) return null;

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
 * (`titleInPreview`).
 *
 * ## What holds the line
 *
 *  - **The title is never note content.** It is owner-chosen or derived from
 *    the filename, so an unfurl never reads the customer's bucket. See
 *    `lib/shareTitle.ts`.
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
