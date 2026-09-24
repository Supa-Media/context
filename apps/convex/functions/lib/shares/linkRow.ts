/**
 * The row an unlisted link is: what kind of thing it points at, and writing it.
 *
 * Split out of `functions/shares.ts`, which keeps every registered function —
 * including `createLinkShare`, whose checks run before `mintLinkShare` is
 * reached — and wires these handlers to them; this module registers none.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { recordAudit } from "../audit";
import { normalizePath } from "../fileOps";
import { collectCapFrom } from "../collectLimits";
import { randomOpaqueToken } from "../gatewayAuth";
import { titleFromPath } from "../shareTitle";
import { scheduleCardRender } from "../../shareCard";
import { isLive } from "./standing";
import { assertShareCapacity } from "./mint";

export const linkShareKindArgs = { workspaceId: v.id("workspaces"), path: v.string() };

export const linkShareKindReturns = v.union(v.literal("note"), v.literal("folder"));

/**
 * What an existing unlisted link over this path points at, or `note`.
 *
 * INTERNAL. Only `createLinkShare` calls it, and only when its caller did not
 * say — see the comment there for why "supersede this share" has to preserve
 * the kind rather than default it.
 *
 * `note` for a path with no live row is the safe answer in both directions: it
 * cannot create a folder share by accident, and it is what every row written
 * before folder links existed is.
 */
export async function linkShareKindHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof linkShareKindArgs>,
) {
  const path = normalizePath(args.path);
  if (path === null) return "note";
  const existing = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_entry_recipient", (q) =>
      q
        .eq("workspaceId", args.workspaceId)
        .eq("entryPath", path)
        .eq("recipientKind", "anyone")
        .eq("recipient", ""),
    )
    .unique();
  if (existing === null || !isLive(existing, Date.now())) return "note";
  return existing.entryKind ?? "note";
}

export const mintLinkShareArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  path: v.string(),
  /**
   * What `path` is. **Required**, and that is the guard rather than a
   * formality: this mutation supersedes an active row *in place and keeps
   * its token*, and it re-stamps the row's fields from its arguments. A
   * defaulted `entryKind` meant any re-mint that did not name the kind
   * turned a live folder share into a note share without changing its token
   * — every link already sent stopped reaching the subtree, and nothing
   * anywhere reported it. Required, so a caller that does not say does not
   * compile.
   */
  entryKind: v.union(v.literal("note"), v.literal("folder")),
  titleInPreview: v.optional(v.boolean()),
  /**
   * `collect` makes this a link that takes answers to a form on the note,
   * from people with no account. Absent means `read`.
   *
   * Only ever set on a **note** — `collect.ts` refuses a folder row anyway,
   * and refusing at the mint too means an owner is told when they ask rather
   * than when the first stranger tries.
   */
  mode: v.optional(v.union(v.literal("read"), v.literal("collect"))),
  /** See `createLinkShare`. Normalized here, so every caller gets one rule. */
  collectCap: v.optional(v.number()),
};

export const mintLinkShareReturns = v.object({
  token: v.string(),
  title: v.union(v.string(), v.null()),
});

/**
 * The row an unlisted link is, written after the checks above have passed.
 *
 * INTERNAL, and `actorUserId` is supplied by the action that read it from the
 * session — `authorizeFileAccess`' arrangement, safe for its reason: an
 * internal function is unreachable from any client, so there is nobody to pass
 * a forged one.
 *
 * Supersession, re-minting and capacity follow `createTeamShare` exactly,
 * including the rule that matters most: a link that was revoked and then made
 * again gets a **new** token, so a URL somebody already forwarded stays dead.
 * "Revoke" must never mean "pause", and for the one share whose readers are
 * anonymous it must mean it least of all.
 */
export async function mintLinkShareHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof mintLinkShareArgs>,
) {
  const now = Date.now();
  const chosenTitle = titleFromPath(args.path);

  /*
    Normalized once, here, and `null` for anything unusable.

    Not an error: an owner or an agent that passed something odd gets a
    working link on the default ceiling rather than no link — and `null`
    never means "unlimited", which is the reading that would turn a typo
    into an open door. See `lib/collectLimits.ts`.
  */
  const cap = collectCapFrom(args.collectCap);

  /** The title as the row will carry it, which is what the URL may use. */
  const shown = (titleInPreview: boolean, title: string | undefined) =>
    titleInPreview ? (title ?? null) : null;

  const existing = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_entry_recipient", (q) =>
      q
        .eq("workspaceId", args.workspaceId)
        .eq("entryPath", args.path)
        .eq("recipientKind", "anyone")
        .eq("recipient", ""),
    )
    .unique();

  if (existing !== null && existing.status === "active") {
    await ctx.db.patch(existing._id, {
      titleInPreview: args.titleInPreview ?? existing.titleInPreview,
      previewTitle: chosenTitle ?? existing.previewTitle,
      /*
        THE MODE IS APPLIED HERE TOO, AND THE FIRST VERSION OF THIS FORGOT.

        This is the branch a *live* link takes when it is re-minted, which is
        how an owner turns an existing read link into a collect one — and
        with only the two title fields patched, that press did nothing and
        said it had worked.

        Unstated preserves, for `linkShareKind`'s reason: pressing Copy link
        or toggling the card's name re-mints without naming a mode, and
        defaulting those to `read` would quietly stop a published form taking
        answers.
      */
      mode: args.mode ?? existing.mode,
      // Same rule: unstated preserves. A Copy link press that reset a busy
      // form's ceiling to the default would stop it early and say nothing.
      collectCap: cap ?? existing.collectCap,
    });
    await scheduleCardRender(ctx, existing._id);
    return {
      token: existing.token,
      title: shown(
        args.titleInPreview ?? existing.titleInPreview,
        chosenTitle ?? existing.previewTitle,
      ),
    };
  }

  await assertShareCapacity(ctx, args.workspaceId);
  const token = randomOpaqueToken();

  let shareId: Id<"noteShares">;
  if (existing !== null) {
    shareId = existing._id;
    await ctx.db.patch(existing._id, {
      status: "active",
      token,
      titleInPreview: args.titleInPreview ?? true,
      previewTitle: chosenTitle ?? undefined,
      // Superseding preserves the mode when the caller did not say, for the
      // reason `linkShareKind` preserves the kind: pressing Copy link on a
      // collect link must not quietly turn it back into a read link.
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      ...(cap === null ? {} : { collectCap: cap }),
      createdBy: args.actorUserId,
      createdAt: now,
      revokedAt: undefined,
    });
  } else {
    shareId = await ctx.db.insert("noteShares", {
      workspaceId: args.workspaceId,
      entryPath: args.path,
      entryKind: args.entryKind,
      // Nobody to name, and nobody to sign in. One field carries the
      // audience — see the schema.
      recipientKind: "anyone",
      recipient: "",
      createdBy: args.actorUserId,
      token,
      status: "active",
      titleInPreview: args.titleInPreview ?? true,
      previewTitle: chosenTitle ?? undefined,
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      ...(cap === null ? {} : { collectCap: cap }),
      createdAt: now,
    });
  }

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: "share.link.created",
    paths: [args.path],
    details: {
      audience: "anyone",
      entryKind: args.entryKind,
      ...(args.mode === undefined ? {} : { mode: args.mode }),
    },
  });

  await scheduleCardRender(ctx, shareId);
  return {
    token,
    title: shown(args.titleInPreview ?? true, chosenTitle ?? undefined),
  };
}
