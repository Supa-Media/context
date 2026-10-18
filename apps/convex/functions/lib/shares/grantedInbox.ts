/**
 * The grants in Shared with me: what an outsider holds, as list items.
 *
 * `listSharedWithMe` (`./recipients.ts`) answers with share items and, here,
 * grant items beside them. The grants are decided by `outsiderGrantsFor`
 * (`../grants/outsider.ts`), so a grant appears in this list exactly when
 * `readGrantedNote` would open it. This file only shapes them: the workspace's
 * name and kind, the note's title, and who wrote the row where it says.
 *
 * A grant the caller can also reach by a share is left out here, so one note
 * is one row, and the share wins (`itemKey`).
 */

import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { outsiderGrantsFor } from "../grants/outsider";
import { handleForUser } from "../identities";
import { sharerName, titleFromProps } from "./inboxTitle";

export const grantedItemValidator = v.object({
  kind: v.literal("grant"),
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  displayName: v.string(),
  workspaceKind: v.union(v.literal("personal"), v.literal("shared")),
  /** The row's stable id, which `readGrantedNote` and `listGrantedFolder` take as `noteId`. */
  noteId: v.string(),
  /** The granted row's path, the locator the list shows and a folder's children are named by. */
  entryPath: v.string(),
  itemKind: v.union(v.literal("file"), v.literal("folder")),
  /** The account that wrote the grant, where the row records one; `null` otherwise. */
  sharedBy: v.union(v.id("users"), v.null()),
  sharedByHandle: v.union(v.string(), v.null()),
  sharedByName: v.union(v.string(), v.null()),
  /** The note's front-matter title or first heading, else its file name without `.md`. Never empty. */
  title: v.string(),
  /** When the grant was written. Sorts the list the way a share's mint time does. */
  createdAt: v.number(),
});

export type GrantedItem = Infer<typeof grantedItemValidator>;

/** The key one note is listed under, whichever way it reached the reader: a share and a grant on it are one row. */
export function itemKey(workspaceId: Id<"workspaces">, path: string): string {
  return `${workspaceId}\u0000${path}`;
}

/** A path's last segment, without `.md`: what a note is called when it has no title. */
export function fallbackTitle(path: string, kind: "file" | "folder"): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return kind === "file" ? name.replace(/\.md$/i, "") : name;
}

/**
 * The caller's grants, shaped as list items, minus any note already listed as a share.
 *
 * `shared` holds `itemKey`s of the share items the list already has. Newest first is left to the caller.
 */
export async function grantedItemsFor(
  ctx: QueryCtx,
  userId: Id<"users">,
  shared: ReadonlySet<string>,
): Promise<GrantedItem[]> {
  const grants = await outsiderGrantsFor(ctx, userId);
  const workspaces = new Map<Id<"workspaces">, { slug: string; displayName: string; kind: "personal" | "shared" } | null>();
  const sharers = new Map<Id<"users">, { handle: string | null; name: string | null }>();
  const items: GrantedItem[] = [];

  for (const grant of grants) {
    if (shared.has(itemKey(grant.workspaceId, grant.path))) continue;

    if (!workspaces.has(grant.workspaceId)) {
      const workspace = await ctx.db.get(grant.workspaceId);
      workspaces.set(
        grant.workspaceId,
        workspace === null ? null : { slug: workspace.slug, displayName: workspace.displayName, kind: workspace.kind },
      );
    }
    const workspace = workspaces.get(grant.workspaceId);
    // A grant in a workspace that has gone is not listed; `outsiderGrantsFor` already refused that case.
    if (workspace === null || workspace === undefined) continue;

    let sharer: { handle: string | null; name: string | null } | null = null;
    if (grant.grantedBy !== null) {
      if (!sharers.has(grant.grantedBy)) {
        sharers.set(grant.grantedBy, {
          handle: await handleForUser(ctx, grant.grantedBy),
          name: await sharerName(ctx, grant.grantedBy),
        });
      }
      sharer = sharers.get(grant.grantedBy) ?? null;
    }

    items.push({
      kind: "grant",
      workspaceId: grant.workspaceId,
      slug: workspace.slug,
      displayName: workspace.displayName,
      workspaceKind: workspace.kind,
      noteId: grant.noteId,
      entryPath: grant.path,
      itemKind: grant.kind,
      sharedBy: grant.grantedBy,
      sharedByHandle: sharer?.handle ?? null,
      sharedByName: sharer?.name ?? null,
      title: titleFromProps(grant.props) ?? fallbackTitle(grant.path, grant.kind),
      createdAt: grant.at,
    });
  }
  return items;
}
