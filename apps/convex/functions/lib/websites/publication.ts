/**
 * What a website may publish, decided by `privacy.md` and nothing else.
 *
 * A website is the owner's folder link over `website/`: it publishes what that
 * folder already publishes to the workspace, and never more. So every read
 * that could put page bytes, a title or a list row in front of a visitor
 * happens at the clearance a link resolves at — `team` scope with no granted
 * names. A note `privacy.md` holds as private, one held back by name, and one
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
 * records that in `privacy.md` as a `team` folder rule — unless the manifest
 * already has a rule for the folder, which is the owner's and stands. A
 * `website/` the owner keeps private serves nothing.
 */
/**
 * The same default in rows mode (`nodesAccess.ensureFolderDefault`): the row takes `team` only when it has no
 * base of its own. The change and its activity line are the file path's, answered in the same shape.
 */
async function publishRowsDefault(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId?: Id<"users">; actorName?: string | null },
): Promise<{ kind: "visibility"; path: string; visibility: "private" | "team" } | { kind: "none" }> {
  // Only a person's gesture can be an owner's change to a row; a repair with no person behind it changes nothing.
  if (args.actorUserId === undefined) return { kind: "none" };
  const answer = await ctx.runMutation(internal.functions.nodesAccess.ensureFolderDefault, {
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    path: DEFAULT_WEBSITE_ROOT,
  });
  if (!answer.ok) return { kind: "none" };
  const visibility = answer.visibility as "private" | "team";
  if (answer.changed) {
    await recordRowsVisibilityLine(ctx, {
      workspaceId: args.workspaceId,
      action: "visibility.folder",
      path: DEFAULT_WEBSITE_ROOT,
      to: visibility,
      teamVisible: visibility === "team",
      ...(args.actorName === undefined ? {} : { actorName: args.actorName }),
    });
  }
  return { kind: "visibility", path: DEFAULT_WEBSITE_ROOT, visibility };
}

export async function ensureWebsitePublicationRule(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId?: Id<"users">;
    actorName?: string | null;
  },
): Promise<void> {
  // In rows mode the rows are the truth and `privacy.md` is not written: the default goes on the folder's row.
  const rows = await ctx.runQuery(internal.functions.nodesAccess.rowsMode, {});
  const result = rows
    ? await publishRowsDefault(ctx, args)
    : await ctx.runAction(
    internal.functions.files.runFileOperation,
    {
      workspaceId: args.workspaceId,
      scope: "private",
      grantedNames: [],
      ...(args.actorName === undefined ? {} : { actorName: args.actorName }),
      operation: {
        kind: "setFolderVisibility",
        path: DEFAULT_WEBSITE_ROOT,
        visibility: "team",
        onlyIfUnset: true,
      },
    },
  );
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
