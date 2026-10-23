/**
 * What a website may publish, decided by the tree's access rows and nothing else.
 *
 * A website is the owner's folder link over `website/`: it publishes what that
 * folder already publishes to the workspace, and never more. So every read
 * that could put page bytes, a title or a list row in front of a visitor
 * happens at the clearance a link resolves at — `team` scope with no granted
 * names. A note the rows hold as private, one held back by name, and one
 * pointed at a group are absent at that clearance, so they are absent from the
 * site whatever their frontmatter says. `audience: members` only ever narrows
 * what this clearance already allows.
 *
 * Every workspace member reads at `team` or wider, so a page visible here is
 * visible to every member, which is why the members gate can stay a
 * membership check. See `docs/decisions/websites.md`.
 */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { recordRowsVisibilityLine } from "../filesFns/visibility";

/** The only clearance a website page, menu entry or list row is read at. */
export const PUBLICATION_SCOPE = "team" as const;
export const PUBLICATION_CLEARANCE: {
  scope: typeof PUBLICATION_SCOPE;
  grantedNames: string[];
} = { scope: PUBLICATION_SCOPE, grantedNames: [] };

/**
 * Turning a website on is the owner's gesture that publishes `website/`, so it
 * records that on the folder's row as `team` — unless the row already has a base
 * of its own, which is the owner's and stands. A `website/` the owner keeps
 * private serves nothing.
 *
 * The default is `nodesAccess.ensureFolderDefault`: the row takes `team` only when it has no base of its own.
 */
async function publishRowsDefault(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId?: Id<"users">; actorName?: string | null },
): Promise<{ kind: "visibility"; path: string; visibility: "private" | "team" } | { kind: "none" }> {
  // Only a person's gesture can be an owner's change to a row. A repair acts for the owner who turned the site on;
  // with no such owner it throws, so the repair is not marked done and a later pass tries again.
  const actorUserId =
    args.actorUserId ?? (await ctx.runQuery(internal.functions.websites.publicationRepairActor, { workspaceId: args.workspaceId }));
  if (actorUserId === null) throw new Error("PUBLICATION_REPAIR_NO_OWNER");
  // The row is the website's folder wherever it is nested now (`./siteRoot.ts`).
  const root = await ctx.runQuery(internal.functions.websites.siteRootNow, { workspaceId: args.workspaceId });
  const answer = await ctx.runMutation(internal.functions.nodesAccess.ensureFolderDefault, {
    workspaceId: args.workspaceId,
    actorUserId,
    path: root,
  });
  if (!answer.ok) return { kind: "none" };
  const visibility = answer.visibility as "private" | "team";
  if (answer.changed) {
    await recordRowsVisibilityLine(ctx, {
      workspaceId: args.workspaceId,
      action: "visibility.folder",
      path: root,
      to: visibility,
      teamVisible: visibility === "team",
      ...(args.actorName === undefined ? {} : { actorName: args.actorName }),
    });
  }
  return { kind: "visibility", path: root, visibility };
}

export async function ensureWebsitePublicationRule(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId?: Id<"users">;
    actorName?: string | null;
  },
): Promise<void> {
  // The rows are the access map: the default goes on the folder's row (`publishRowsDefault`).
  const result = await publishRowsDefault(ctx, args);
  if (result.kind !== "visibility") return;
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    ...(args.actorUserId === undefined
      ? {}
      : { actorUserId: args.actorUserId }),
    action: "visibility.folder",
    paths: [result.path],
    details: {
      visibility: result.visibility,
      source:
        args.actorUserId === undefined
          ? "website-publication-repair"
          : "website-enabled",
    },
  });
}
