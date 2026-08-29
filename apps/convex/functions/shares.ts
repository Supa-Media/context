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
import { requireAuthId } from "@supa-media/convex/auth";
import { mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { normalizePath } from "./lib/fileOps";
import { randomOpaqueToken } from "./lib/gatewayAuth";
import { identifiersForUser, resolveAddressedUser } from "./lib/identities";
import {
  formatInvitee,
  inviteeRejectionError,
  parseInvitee,
  type Invitee,
} from "./lib/invitees";
import { isPlumbing } from "./lib/privacy";
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
    if (share === null || !isLive(share, now)) return null;

    const addressed = await resolveAddressedUser(ctx, {
      kind: share.recipientKind,
      value: share.recipient,
    });
    if (addressed === null || addressed !== userId) return null;

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
      // The authority, not the gathering above.
      const addressed = await resolveAddressedUser(ctx, {
        kind: row.recipientKind,
        value: row.recipient,
      });
      if (addressed !== userId) continue;

      const workspace = await ctx.db.get(row.workspaceId);
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
