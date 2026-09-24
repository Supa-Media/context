/**
 * Note shares — handing one document to one person who is not a member.
 *
 * The design, and the reasons a share narrows and can never widen, are the
 * module comment of `./lib/shares/mint.ts`, beside `createShare`.
 *
 * Every share function is still registered here, under the same name, kind
 * and validators, because a function's API path derives from this file. Bodies
 * that call no other function in the deployment live in `./lib/shares/`,
 * carrying the comment that sat on their registration. Every body that does
 * (`ctx.runQuery`, `ctx.runAction`, `ctx.runMutation`) stays here in full:
 * `__tests__/structure.test.ts` builds its credential-reachability graph from
 * the text of each registered function, and a call moved out of it is a call
 * that graph no longer sees.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { api, internal } from "../_generated/api";
import { DEFAULT_COLLECT_CAP } from "./lib/collectLimits";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { isEncryptedNote } from "./lib/noteEncryption";
import { MAX_SHARES_RETURNED, isLive } from "./lib/shares/standing";
import {
  checkFolderSharePath,
  checkSharePath,
  pathRejection,
} from "./lib/shares/paths";
import {
  notAuthenticated,
  notLinkableEncrypted,
  notTeamVisible,
  notTeamVisibleFolder,
  shareUnavailable,
} from "./lib/shares/errors";
import { mintTeamShare } from "./lib/shares/mint";
import { describeAudience } from "./lib/shares/manage";
import {
  gatewayLinkSummary,
  workspaceHandle,
  shareUrlsFor,
  type GatewayLink,
} from "./lib/shares/gatewayLinks";
import * as mint from "./lib/shares/mint";
import * as linkRow from "./lib/shares/linkRow";
import * as manage from "./lib/shares/manage";
import * as shortLinks from "./lib/shares/shortLinks";
import * as gatewayLinks from "./lib/shares/gatewayLinks";
import * as recipients from "./lib/shares/recipients";
import * as previews from "./lib/shares/previews";
import * as readPath from "./lib/shares/readPath";
import * as validators from "./lib/shares/validators";

export { MAX_ACTIVE_SHARES } from "./lib/shares/standing";

export const createShare = mutation({
  args: mint.createShareArgs,
  returns: mint.createShareReturns,
  handler: mint.createShareHandler,
});

export const createTeamShare = mutation({
  args: mint.createTeamShareArgs,
  returns: mint.createTeamShareReturns,
  handler: mint.createTeamShareHandler,
});

/**
 * Mint an unlisted link over one note. Owner-only.
 *
 * ## Why this is an action where its two siblings are mutations
 *
 * `createShare` and `createTeamShare` do not check that the note is
 * `team`-visible, deliberately: a creation-time check reads a bucket and its
 * answer goes stale the moment the owner edits `privacy.md`, so the read path
 * re-derives it every time and that is where the security lives. Nothing about
 * that changes here — `shareStillStands` and `readThroughShare` are what
 * enforce it, and `shareAnyone.test.ts` proves a note made private after
 * minting is absent through the link.
 *
 * What changes is what a *stale* answer costs the owner. A personal share over
 * a note that is not team-visible fails in front of one named person who can
 * say so. An unlisted link is pasted into a channel, and a link that silently
 * resolves to "not available" for everybody who opens it is indistinguishable,
 * from the owner's side, from having published something. So this one refuses
 * at creation as a courtesy to the person pressing the button — and the module
 * comment's rule holds exactly as written: it must never become the thing the
 * read path relies on. Sabotage this check and the read tests still pass.
 *
 * It reuses `runFileOperation`, which is the single credential barrier
 * `readThroughShare` already goes through. A second barrier for "the share
 * mint needs its own" is precisely how an enumeration becomes an amnesty, and
 * `CREDENTIAL_BARRIERS` holds one member for that reason.
 */
export const createLinkShare = action({
  args: validators.createLinkShareArgs,
  returns: validators.createLinkShareReturns,
  handler: async (ctx, args): Promise<{ token: string; title: string | null }> => {
    // An action has no `db`, so `requireAuthId` is unavailable here; the
    // clearance below is what refuses, and it refuses an absent caller for the
    // same reason it refuses an editor.
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) throw notAuthenticated();
    // Owner clearance before a single byte of the customer's bucket is spent:
    // an editor must not be able to make us issue a LIST or a GET, and the
    // refusal they get must not depend on what the note turned out to be.
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId: userId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    return await mintUnlistedLink(ctx, { ...args, actorUserId: userId });
  },
});

/**
 * The body of `createLinkShare`, with the acting identity passed in.
 *
 * `mintTeamShare`'s split, applied to the other mint: the public action above
 * resolves a browser session and clears `owner`, the gateway's route resolves
 * an access token to a grant that already had to be an owner's, and both
 * arrive here having proved the same thing. What is below — the courtesy
 * visibility check, the encryption refusal, the folder probe, the one
 * credential barrier — is written once.
 *
 * `actorUserId` is passed in rather than read, which is what makes it safe to
 * share: an identity a function is *given* is one its caller had to establish.
 */
async function mintUnlistedLink(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    kind?: "note" | "folder";
    titleInPreview?: boolean;
    mode?: "read" | "collect";
    collectCap?: number;
    actorUserId: Id<"users">;
  },
): Promise<{ token: string; title: string | null }> {
  {
    const userId = args.actorUserId;

    /*
      AN UNSTATED KIND IS RESOLVED FROM THE LIVE ROW, NOT DEFAULTED TO `note`.

      Two console callers re-mint a link without thinking about what it points
      at: pressing Copy link, and toggling whether the card shows the name.
      Both call this with a path and nothing else. Defaulting them to `note`
      made a folder link answer "Only a note can be shared" — and, one refactor
      further in, would have re-stamped a live folder share to `note` while
      keeping its token, which breaks every link already sent and reports
      nothing.

      So "supersede this share" preserves what the share points at. It cannot
      *create* a folder share by accident: a path with no live row still
      resolves to `note`, and `checkSharePath` still refuses a folder. Minting
      one over a folder for the first time still means saying so.
    */
    const kind =
      args.kind ??
      (await ctx.runQuery(internal.functions.shares.linkShareKind, {
        workspaceId: args.workspaceId,
        path: args.path,
      }));

    /*
      A COLLECT LINK IS OVER A NOTE, AND THE OWNER IS TOLD AT THE MINT.

      `collect.ts` refuses a folder row anyway — that is the enforcement, and
      it stays there because it is what an already-written row is judged by.
      This is the second half of the same rule said at the moment an owner
      asks for it, so the answer is "a folder cannot collect" rather than a
      link that looks minted and refuses every stranger who opens it.

      The `kind` read above is what makes this correct on a re-mint: a press of
      Copy link on a live folder link passes no mode at all and is untouched.
    */
    if (kind === "folder" && args.mode === "collect") {
      throw new ConvexError({
        code: "COLLECT_NEEDS_A_NOTE",
        message: "A link that collects answers points at one note, not a folder.",
      });
    }

    if (kind === "folder") return await mintFolderLink(ctx, args, userId);

    const pathCheck = checkSharePath(args.path);
    if (!pathCheck.ok) throw pathRejection(pathCheck);

    // The courtesy check. `team` scope, not the owner's own `private` — the
    // question is what the link's readers will be able to see, and they read at
    // `team` like every other share.
    try {
      const visible = await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: "team",
        operation: { kind: "read", path: pathCheck.path },
      });
      if (visible.kind !== "file") throw notTeamVisible();
      /*
        AN UNLISTED LINK IS NOT MINTED OVER AN ENCRYPTED NOTE.

        `docs/decisions/encryption.md`, "Sharing": both features are
        defensible and their composition is not. An unlisted link is the one
        audience in this product with no name and no session, and an encrypted
        note is one the owner was told is stored unreadable. The owner's model
        of "encrypted" and their model of "anyone with this link" cannot both
        be true of one note, and the product does not get to pick which one
        they meant.

        Refused here for the same reason the visibility check above is here: a
        link that silently resolves to "not available" for everyone who opens
        it is indistinguishable, from the owner's side, from having published
        something. And exactly as with that check, this is a courtesy and never
        the thing the read path relies on — `readThroughShare` refuses again,
        live, because a note encrypted *after* a link was minted is the case a
        creation-time check cannot see.

        On the marker, not on a successful parse: a note whose envelope is
        malformed is one nobody can read either, and it is the case where
        publishing a link over it helps least.
      */
      if (isEncryptedNote(visible.text)) throw notLinkableEncrypted();
    } catch (error) {
      // A note the manifest hides and a note that is not there answer
      // identically at `team` scope, by design — that indistinguishability is
      // what stops a team-scoped reader enumerating private paths, and it is
      // not something to unpick for the owner's convenience. So one refusal
      // covers both, worded to cover both. Anything else — a bucket that is
      // unreachable, a binding that is gone — is passed through, because
      // telling an owner their note is private during an outage would send
      // them to fix a manifest that is fine.
      const code =
        error instanceof ConvexError
          ? (error.data as { code?: string } | undefined)?.code
          : undefined;
      if (code === "FILE_NOT_FOUND" || code === "PATH_INVALID") throw notTeamVisible();
      throw error;
    }

    return await ctx.runMutation(internal.functions.shares.mintLinkShare, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      path: pathCheck.path,
      // Stated rather than defaulted: `mintLinkShare` requires it, so this
      // branch says the thing it has just proved with a read.
      entryKind: "note",
      ...(args.titleInPreview === undefined
        ? {}
        : { titleInPreview: args.titleInPreview }),
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      ...(args.collectCap === undefined ? {} : { collectCap: args.collectCap }),
    });
  }
}

export const linkShareKind = internalQuery({
  args: linkRow.linkShareKindArgs,
  returns: linkRow.linkShareKindReturns,
  handler: linkRow.linkShareKindHandler,
});

/**
 * Mint a link over a folder, and prove the folder is one first.
 *
 * ## Why the probe is a LIST and not a read
 *
 * The note path's courtesy check reads the note: a link that silently resolves
 * to "not available" for everybody who opens it is indistinguishable, from the
 * owner's side, from having published something. A folder has the same failure
 * and one more — the path may not be a folder at all — so the probe is the
 * listing the reader will actually get, at the scope they will actually get it
 * at.
 *
 * `team` scope, not the owner's `private`: the question is what the link's
 * readers will see. A folder that lists **nothing** at `team` is refused, which
 * covers a private folder, a folder whose every note is held back, a path that
 * is really a note, and a path that is not there — all the ways an owner would
 * otherwise paste a link into a channel and publish an empty room. They are one
 * refusal because at `team` scope they are genuinely indistinguishable, which is
 * the same indistinguishability that stops a member enumerating private paths
 * and is not something to unpick for the owner's convenience.
 *
 * And as with every other check here, it is a **courtesy**: the read path
 * re-derives everything from the live `privacy.md` on every request, because a
 * folder made private after the link was pasted is exactly the case a
 * mint-time check cannot see.
 */
async function mintFolderLink(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; path: string; titleInPreview?: boolean },
  userId: Id<"users">,
): Promise<{ token: string; title: string | null }> {
  const pathCheck = checkFolderSharePath(args.path);
  if (!pathCheck.ok) throw pathRejection(pathCheck);

  try {
    const listing = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: "team",
      operation: { kind: "list", path: pathCheck.path },
    });
    if (listing.kind !== "listing" || listing.entries.length === 0) {
      throw notTeamVisibleFolder();
    }
  } catch (error) {
    // A folder the manifest hides, a folder that is not there, and a note
    // wearing a folder's argument answer identically at `team` scope. Anything
    // else — an unreachable bucket, a binding that is gone — is passed through,
    // because reporting an outage as "not shared" would have an owner
    // republishing a folder that was never the problem.
    if (error instanceof ConvexError) throw error;
    throw error;
  }

  return await ctx.runMutation(internal.functions.shares.mintLinkShare, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    path: pathCheck.path,
    entryKind: "folder",
    ...(args.titleInPreview === undefined
      ? {}
      : { titleInPreview: args.titleInPreview }),
  });
}

export const mintLinkShare = internalMutation({
  args: linkRow.mintLinkShareArgs,
  returns: linkRow.mintLinkShareReturns,
  handler: linkRow.mintLinkShareHandler,
});

export const listShares = query({
  args: manage.listSharesArgs,
  returns: manage.listSharesReturns,
  handler: manage.listSharesHandler,
});

export const revokeShare = mutation({
  args: manage.revokeShareArgs,
  returns: manage.revokeShareReturns,
  handler: manage.revokeShareHandler,
});

/* -------------------------------------------------------------------------- */
/* Short links: the same share row, reached by a name somebody can say         */
/* -------------------------------------------------------------------------- */

export const setShareSlug = mutation({
  args: manage.setShareSlugArgs,
  returns: manage.setShareSlugReturns,
  handler: manage.setShareSlugHandler,
});

export const setShareCollecting = mutation({
  args: manage.setShareCollectingArgs,
  returns: manage.setShareCollectingReturns,
  handler: manage.setShareCollectingHandler,
});

export const shortLinkToken = internalQuery({
  args: shortLinks.shortLinkTokenArgs,
  returns: shortLinks.shortLinkTokenReturns,
  handler: shortLinks.shortLinkTokenHandler,
});

/**
 * Read what a short link points at: `readSharedNote`, addressed by name.
 *
 * It resolves the slug and then calls that action, rather than reimplementing
 * it. Every rule about what a share reaches, who may read it, how a folder
 * lists and how a link out of the entry note is bounded lives there, and a
 * second copy reachable by a *guessable* address is precisely the copy that
 * would drift in the wrong direction.
 *
 * A slug that resolves to nothing refuses exactly as an unknown token does, so
 * "never claimed", "released" and "revoked" are one answer.
 */
export const readShortLink = action({
  args: validators.readShortLinkArgs,
  returns: validators.readShortLinkReturns,
  handler: async (
    ctx,
    args,
  ): Promise<{
    path: string;
    text: string | null;
    kind: "note" | "folder";
    entries: { path: string; name: string; kind: "file" | "folder" }[];
    entryPath: string;
    links: string[];
    openToAnyone: boolean;
    collecting: boolean;
    editableInContext: string | null;
  }> => {
    const token = await ctx.runQuery(internal.functions.shares.shortLinkToken, {
      handle: args.handle,
      slug: args.slug,
    });
    if (token === null) throw shareUnavailable();

    return await ctx.runAction(api.functions.shares.readSharedNote, {
      token,
      ...(args.path === undefined ? {} : { path: args.path }),
    });
  },
});

export const previewForShortLink = query({
  args: shortLinks.previewForShortLinkArgs,
  returns: shortLinks.previewForShortLinkReturns,
  handler: shortLinks.previewForShortLinkHandler,
});

/* -------------------------------------------------------------------------- */
/* The gateway's half: an agent asking for a link, and getting the URL        */
/* -------------------------------------------------------------------------- */

/**
 * Mint a link for an agent, and hand back the URL. INTERNAL.
 *
 * Everything about *what a share is* happens in `mintTeamShare` and
 * `mintUnlistedLink`, which the console's own buttons call. This adds three
 * things and no fourth:
 *
 *  - the gateway's owner clearance, which is where the access token is spent;
 *  - the optional short name, claimed through the same `setShareSlug` rules
 *    the console claims one through — including the refusal on a name this
 *    product writes;
 *  - the URL, built from `@context/shared` so nothing downstream guesses.
 *
 * **The short name is claimed after the row exists, and a refusal does not
 * un-mint it.** The link is real and usable at its token either way, so the
 * honest answer is the link plus the reason the name was refused — rather than
 * throwing away a working share because a word was taken.
 */
export const gatewayCreateLink = internalAction({
  args: validators.gatewayCreateLinkArgs,
  returns: validators.gatewayCreateLinkReturns,
  handler: async (
    ctx,
    args,
  ): Promise<{ link: GatewayLink; shortRefused: string | null } | null> => {
    const cleared = await ctx.runQuery(
      internal.functions.controlPlane.ownerClearanceForGateway,
      {
        hashedAccessToken: args.hashedAccessToken,
        expectedWorkspaceId: args.expectedWorkspaceId,
      },
    );
    if (cleared === null) return null;

    if (args.audience === "anyone") {
      await ctx.runAction(internal.functions.shares.gatewayMintUnlisted, {
        workspaceId: cleared.workspaceId,
        actorUserId: cleared.actorUserId,
        path: args.path,
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.titleInPreview === undefined
          ? {}
          : { titleInPreview: args.titleInPreview }),
        ...(args.mode === undefined ? {} : { mode: args.mode }),
        ...(args.collectCap === undefined ? {} : { collectCap: args.collectCap }),
      });
    } else {
      await ctx.runMutation(internal.functions.shares.gatewayMintTeam, {
        workspaceId: cleared.workspaceId,
        actorUserId: cleared.actorUserId,
        path: args.path,
        ...(args.titleInPreview === undefined
          ? {}
          : { titleInPreview: args.titleInPreview }),
      });
    }

    return await ctx.runMutation(internal.functions.shares.gatewayNameAndDescribe, {
      workspaceId: cleared.workspaceId,
      actorUserId: cleared.actorUserId,
      path: args.path,
      audience: args.audience,
      ...(args.short === undefined ? {} : { short: args.short }),
    });
  },
});

/** `mintUnlistedLink` for a cleared gateway caller. INTERNAL. */
export const gatewayMintUnlisted = internalAction({
  args: validators.gatewayMintUnlistedArgs,
  returns: validators.gatewayMintUnlistedReturns,
  handler: async (ctx, args): Promise<{ token: string; title: string | null }> =>
    await mintUnlistedLink(ctx, args),
});

/** `mintTeamShare` for a cleared gateway caller. INTERNAL. */
export const gatewayMintTeam = internalMutation({
  args: validators.gatewayMintTeamArgs,
  returns: validators.gatewayMintTeamReturns,
  handler: async (ctx, args) => await mintTeamShare(ctx, args),
});

export const gatewayNameAndDescribe = internalMutation({
  args: gatewayLinks.gatewayNameAndDescribeArgs,
  returns: gatewayLinks.gatewayNameAndDescribeReturns,
  handler: gatewayLinks.gatewayNameAndDescribeHandler,
});

/** Every live link in this context, for an agent that asked. INTERNAL. */
export const gatewayListLinks = internalQuery({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.union(v.null(), v.array(gatewayLinkSummary)),
  handler: async (ctx, args): Promise<GatewayLink[] | null> => {
    const cleared = await ctx.runQuery(
      internal.functions.controlPlane.ownerClearanceForGateway,
      {
        hashedAccessToken: args.hashedAccessToken,
        expectedWorkspaceId: args.expectedWorkspaceId,
      },
    );
    if (cleared === null) return null;

    const now = Date.now();
    const rows = await ctx.db
      .query("noteShares")
      .withIndex("by_workspace_status", (q) =>
        q.eq("workspaceId", cleared.workspaceId).eq("status", "active"),
      )
      .take(MAX_SHARES_RETURNED);
    const handle = await workspaceHandle(ctx, cleared.workspaceId);

    return rows
      .filter((row) => isLive(row, now))
      .map((row) => {
        const urls = shareUrlsFor(row, handle);
        return {
          shareId: row._id,
          url: urls.url,
          shortUrl: urls.shortUrl,
          path: urls.path,
          audience: row.recipientKind,
          entryPath: row.entryPath,
          slug: row.slug ?? null,
          collecting: row.mode === "collect",
          collected: row.mode === "collect" ? (row.collectCount ?? 0) : null,
          collectCap:
            row.mode === "collect" ? (row.collectCap ?? DEFAULT_COLLECT_CAP) : null,
          createdAt: row.createdAt,
        };
      });
  },
});

/**
 * Take a link back on an agent's say-so. INTERNAL.
 *
 * Addressed by `shareId`, which is what `gatewayListLinks` hands out — never
 * by token, because an agent holding a token it was given by a person is not
 * the same as an agent whose own grant covers the context, and only the second
 * gets to revoke. The row's workspace is compared against the cleared one, so
 * an id from another context is one refusal and not an oracle.
 */
export const gatewayRevokeLink = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    shareId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const cleared = await ctx.runQuery(
      internal.functions.controlPlane.ownerClearanceForGateway,
      {
        hashedAccessToken: args.hashedAccessToken,
        expectedWorkspaceId: args.expectedWorkspaceId,
      },
    );
    if (cleared === null) return false;

    const shareId = ctx.db.normalizeId("noteShares", args.shareId);
    if (shareId === null) return false;
    const row = await ctx.db.get(shareId);
    if (row === null || row.status !== "active") return false;
    // The cleared workspace, never the row's: an id from another context must
    // answer exactly as an invented one does.
    if (row.workspaceId !== cleared.workspaceId) return false;

    await ctx.db.patch(row._id, { status: "revoked", revokedAt: Date.now() });
    await recordAudit(ctx, {
      workspaceId: cleared.workspaceId,
      actorUserId: cleared.actorUserId,
      action: "share.revoked",
      paths: [row.entryPath],
      details: {
        recipient: describeAudience(row.recipientKind, row.recipient),
        via: "gateway",
      },
    });
    return true;
  },
});

export const resolveShare = query({
  args: recipients.resolveShareArgs,
  returns: recipients.resolveShareReturns,
  handler: recipients.resolveShareHandler,
});

export const listSharedWithMe = query({
  args: recipients.listSharedWithMeArgs,
  returns: recipients.listSharedWithMeReturns,
  handler: recipients.listSharedWithMeHandler,
});

/* -------------------------------------------------------------------------- */
/*                              the read path                                 */
/* -------------------------------------------------------------------------- */

export const authorizeShareRead = internalQuery({
  args: recipients.authorizeShareReadArgs,
  returns: recipients.authorizeShareReadReturns,
  handler: recipients.authorizeShareReadHandler,
});

/** Read a note through a share: see `readSharedNoteHandler` in `./lib/shares/readPath.ts`. */
export const readSharedNote = action({
  args: validators.readSharedNoteArgs,
  returns: validators.readSharedNoteReturns,
  handler: readPath.readSharedNoteHandler,
});

export const previewForNote = query({
  args: previews.previewForNoteArgs,
  returns: previews.previewForNoteReturns,
  handler: previews.previewForNoteHandler,
});

export const previewTitleForToken = query({
  args: previews.previewTitleForTokenArgs,
  returns: previews.previewTitleForTokenReturns,
  handler: previews.previewTitleForTokenHandler,
});
