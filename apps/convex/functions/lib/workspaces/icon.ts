/**
 * The handlers for `workspaces.setWorkspaceIcon`, `recordWorkspaceIconPhoto`
 * and `workspaceIconLeaf`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row,
 * and see each export's own doc comment there for its rules — especially
 * `workspaceIconLeaf`'s, which is the whole security argument for icon photos.
 */

import { ConvexError } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { isSingleEmoji } from "@context/shared";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { reachesPinnedContext } from "../pinnedContext";
import { requireWorkspaceAccess, requireWorkspaceRole, workspaceNotFound } from "../workspaceAuth";

export async function setWorkspaceIconHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; emoji: string | null },
): Promise<null> {
  const actorId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

  const workspace = await ctx.db.get(args.workspaceId);
  /*
    The helper rather than a literal, so "not a member" and "does not exist"
    stay byte-identical — `workspaceAuth.test.ts` fails if this string is
    built anywhere else in `functions/`.
  */
  if (workspace === null) throw workspaceNotFound();

  if (args.emoji === null) {
    /*
      THE BUCKET OBJECT IS DELIBERATELY LEFT WHERE IT IS.

      Deleting the photo on clear looks tidy and is wrong twice. The store is
      content-addressed, so those bytes may equally be another workspace's
      icon in the same bucket or the target of a paste in a note, and a delete
      here would break both. And it is the customer's bucket: an object we put
      there is theirs to keep or remove.
    */
    await ctx.db.patch(args.workspaceId, { icon: undefined, updatedAt: Date.now() });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: actorId,
      action: "workspace.icon_cleared",
      details: { was: workspace.icon?.kind ?? "none" },
    });
    return null;
  }

  /*
    THE VALIDATOR IS SHARED, AND IT IS STRUCTURAL.

    Not a length check. This value is drawn in an 18pt square on the screen of
    every member of the workspace, so what has to be refused is not "too long"
    but "not one glyph": a right-to-left override, a stack of combining marks
    that draws over the row above, or plain text. `isSingleEmoji` answers that
    shape question, and the console pre-flights the same function so the
    picker can never offer what this refuses.
  */
  if (!isSingleEmoji(args.emoji)) {
    throw new ConvexError({
      code: "WORKSPACE_ICON_INVALID",
      message: "A workspace icon is a single emoji.",
    });
  }

  await ctx.db.patch(args.workspaceId, {
    icon: { kind: "emoji", emoji: args.emoji },
    updatedAt: Date.now(),
  });
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: actorId,
    action: "workspace.icon_set",
    /*
      The emoji is in the audit detail; a photo's leaf is too. Neither is note
      content and neither is a secret — the leaf is a content hash of a
      picture the workspace already shows everybody — and an audit line
      reading "an icon was set" answers none of the questions an audit trail
      is read for.
    */
    details: { icon: "emoji", emoji: args.emoji },
  });
  return null;
}

export async function recordWorkspaceIconPhotoHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId: Id<"users">; leaf: string },
): Promise<null> {
  await requireWorkspaceRole(ctx, args.workspaceId, args.actorUserId, "owner");
  await ctx.db.patch(args.workspaceId, {
    icon: { kind: "photo", leaf: args.leaf },
    updatedAt: Date.now(),
  });
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    action: "workspace.icon_set",
    details: { icon: "photo", leaf: args.leaf },
  });
  return null;
}

export async function workspaceIconLeafHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId: Id<"users"> },
): Promise<string | null> {
  /*
    THE PIN IS REACH WITHOUT A MEMBERSHIP ROW, AND THIS HAS TO KNOW THAT.

    `requireWorkspaceAccess` answers from `workspaceMembers`, and nobody is a
    member of `@context-lc` — so asking it alone would refuse the one
    workspace that is in *every* account's rail, after `authorizeFileAccess`
    (which does know about the pin) had already admitted the caller. The two
    gates would disagree on exactly one row in the product.

    Tried before the membership read rather than after a caught failure, for
    the reason `authorizeFileAccess` gives: the refusal is byte-identical for
    "not a member" and "no such workspace", so catching it would mean guessing
    which one this was. Asking the narrower question first needs no guess.
  */
  if (await reachesPinnedContext(ctx, args.workspaceId, args.actorUserId)) {
    const pinned = await ctx.db.get(args.workspaceId);
    return pinned?.icon?.kind === "photo" ? pinned.icon.leaf : null;
  }
  const { workspace } = await requireWorkspaceAccess(
    ctx,
    args.workspaceId,
    args.actorUserId,
  );
  return workspace.icon?.kind === "photo" ? workspace.icon.leaf : null;
}
