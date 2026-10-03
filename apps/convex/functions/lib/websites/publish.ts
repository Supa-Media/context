/**
 * Publish: the one way an edit under `website/` reaches visitors.
 *
 * _Decided by the owner, 2026-09-26_ (see `docs/decisions/websites.md`).
 * Saving a note in `website/` changes the note and nothing a visitor sees;
 * pressing Publish reads the folder at the publication clearance and, when
 * every page in it is sound, makes it the site's new release. Restrictions do
 * not wait for it: every scan applies them (`commitPublicationSnapshot`).
 *
 * Owners and editors may publish. Editors could already change the site by
 * saving before this existed, so the button gives them nothing they lacked;
 * turning the site on or off stays the owner's.
 *
 * An agent on an owner's or editor's connection publishes through the same
 * `publishWebsiteAs` (`agentSite.ts`, the owner's decision of 2026-10-03).
 */

import type { WebsitePublishResult } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "../filesFns/access";
import { publishWebsiteAs } from "./agentSite";

export async function publishWebsiteHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<WebsitePublishResult> {
  const actorUserId = await callerId(ctx);
  await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "editor",
  });
  const { published, problems } = await publishWebsiteAs(ctx, { workspaceId: args.workspaceId, actorUserId });
  return { published, problems };
}
