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
 */

import type { WebsitePublishResult } from "@context/shared";
import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "../filesFns/access";
import { PUBLICATION_CLEARANCE } from "./publication";
import { commitPublicationSnapshot } from "./releases";
import { scanWebsiteRoutes } from "./routes";

/** A save that lands mid-publish takes the fence; the press tries again. */
const ATTEMPTS = 3;

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
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const generation = await ctx.runMutation(
      internal.functions.websites.beginRouteReconciliation,
      { workspaceId: args.workspaceId, enabledOnly: true },
    );
    if (generation === null) {
      throw new ConvexError({
        code: "WEBSITE_DISABLED",
        message: "Turn the website on to publish it.",
      });
    }
    const snapshot = await scanWebsiteRoutes(
      ctx,
      args.workspaceId,
      PUBLICATION_CLEARANCE,
      { publication: true },
    );
    const problems = snapshot.statuses.flatMap((status) =>
      status.status === "problem"
        ? [
            {
              path: status.objectKey,
              message: status.problems[0]?.message ?? "This page cannot be published.",
            },
          ]
        : [],
    );
    const published = await commitPublicationSnapshot(
      ctx,
      args.workspaceId,
      generation,
      snapshot,
      true,
      true,
    );
    if (published) {
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: args.workspaceId,
        actorUserId,
        action: "website.published",
        details: { pages: snapshot.statuses.filter((s) => s.status === "live").length },
      });
      return { published: true, problems: [] };
    }
    if (problems.length > 0) return { published: false, problems };
  }
  return { published: false, problems: [] };
}
