/**
 * The gateway's link routes that spend an access token: mint a link for an
 * agent, list the live ones, and take one back.
 *
 * Split out of `functions/shares.ts`, which keeps `gatewayCreateLink`,
 * `gatewayListLinks` and `gatewayRevokeLink` registered under the same names,
 * kinds and validators and wires these handlers to them; this module
 * registers none. Each one spends the token on `ownerClearanceForGateway`
 * before it reads or writes anything, exactly as it did in the registration.
 */

import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import { internal } from "../../../_generated/api";
import type {
  ActionCtx,
  MutationCtx,
  QueryCtx,
} from "../../../_generated/server";
import { recordAudit } from "../audit";
import { DEFAULT_COLLECT_CAP } from "../collectLimits";
import { MAX_SHARES_RETURNED, isLive } from "./standing";
import { describeAudience } from "./manage";
import {
  gatewayLinkSummary,
  shareUrlsFor,
  workspaceHandle,
  type GatewayLink,
} from "./gatewayLinks";
import type { gatewayCreateLinkArgs } from "./validators";

export const gatewayListLinksArgs = {
  hashedAccessToken: v.string(),
  expectedWorkspaceId: v.string(),
};

export const gatewayListLinksReturns = v.union(
  v.null(),
  v.array(gatewayLinkSummary),
);

export const gatewayRevokeLinkArgs = {
  hashedAccessToken: v.string(),
  expectedWorkspaceId: v.string(),
  shareId: v.string(),
};

export const gatewayRevokeLinkReturns = v.boolean();

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
export async function gatewayCreateLinkHandler(
  ctx: ActionCtx,
  args: ObjectType<typeof gatewayCreateLinkArgs>,
): Promise<
  { link: GatewayLink; shortRefused: string | null } | { refused: string } | null
> {
  const cleared = await ctx.runQuery(
    internal.functions.controlPlane.ownerClearanceForGateway,
    {
      hashedAccessToken: args.hashedAccessToken,
      expectedWorkspaceId: args.expectedWorkspaceId,
    },
  );
  if (cleared === null) return null;

  /*
    AFTER THE CLEARANCE, A REFUSAL IS AN ANSWER — NEVER A THROW.

    Everything below refuses by throwing a `ConvexError` the console turns into
    a sentence: a note the team cannot read, an encrypted note, a folder asked
    to collect, a context at its share cap. Thrown out of this action, each one
    escaped the HTTP route as a bare 500, and the gateway can only report a 500
    as "control plane unavailable" — which is what an owner asking for an
    intake form link was shown, four times, for a note that only needed
    publishing to the workspace (2026-09-24).

    Giving the reason here is not the oracle the bare `null` above prevents.
    That `null` is for a caller who is NOT cleared; this caller has just proved
    they own the context, can read every note in it, and would be shown the
    same sentence by the console's own button. Anything that is not a
    `ConvexError` — an unreachable bucket, a bug — still throws, because an
    outage reported as "publish your note first" sends an owner to fix a
    manifest that is fine.
  */
  try {
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
  } catch (error) {
    const refused = refusalSentence(error);
    if (refused === null) throw error;
    return { refused };
  }

  return await ctx.runMutation(internal.functions.shares.gatewayNameAndDescribe, {
    workspaceId: cleared.workspaceId,
    actorUserId: cleared.actorUserId,
    path: args.path,
    audience: args.audience,
    ...(args.short === undefined ? {} : { short: args.short }),
  });
}

/**
 * The owner-facing sentence a mint refusal carries, or `null` for anything
 * that is not a refusal. Only a `ConvexError` whose payload has a string
 * `message` counts — that is the shape every mint refusal in this folder
 * throws, and the one the console already shows its owner verbatim.
 */
function refusalSentence(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const message = (error.data as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message !== "" ? message : null;
}

/** Every live link in this context, for an agent that asked. INTERNAL. */
export async function gatewayListLinksHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof gatewayListLinksArgs>,
): Promise<GatewayLink[] | null> {
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
}

/**
 * Take a link back on an agent's say-so. INTERNAL.
 *
 * Addressed by `shareId`, which is what `gatewayListLinks` hands out — never
 * by token, because an agent holding a token it was given by a person is not
 * the same as an agent whose own grant covers the context, and only the second
 * gets to revoke. The row's workspace is compared against the cleared one, so
 * an id from another context is one refusal and not an oracle.
 */
export async function gatewayRevokeLinkHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof gatewayRevokeLinkArgs>,
): Promise<boolean> {
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
}
