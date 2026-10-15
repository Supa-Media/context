/**
 * Folder and note icons held in Convex (`folderIcons`): the rows as a map,
 * and changes made by the shared engine (`folderIcons.cjs`'s
 * `iconsAfterMove`, `iconsAfterDelete`), so a move carries an icon the same
 * way wherever it is decided.
 *
 * A removal made before the workspace's file was imported leaves a `null`
 * row, so the import does not bring the icon back (`importIcons`).
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../../../_generated/server";
import { type FolderIcons, iconsAfterDelete, iconsAfterMove } from "@context/shared/src/folderIcons.cjs";
import { markChanged, smallDataImported } from "./state";

/** Rows one read takes: past the file's own cap (`MAX_ICONS`), with removals. */
const ICON_READ_BOUND = 4_000;

export async function iconRows(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"folderIcons">[]> {
  return await db
    .query("folderIcons")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
    .take(ICON_READ_BOUND);
}

/** The icons the rows say, removals left out. */
export function iconsOf(rows: readonly Doc<"folderIcons">[]): FolderIcons {
  const icons: FolderIcons = {};
  for (const row of rows) if (row.icon !== null) icons[row.path] = row.icon;
  return icons;
}

/**
 * Make the rows say `next`. Before the import a path that loses its icon
 * keeps a `null` row; after it, the row goes. Returns whether anything changed.
 */
export async function writeIcons(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  rows: readonly Doc<"folderIcons">[],
  next: FolderIcons,
): Promise<boolean> {
  const imported = await smallDataImported(ctx.db, workspaceId);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  let changed = false;
  for (const [path, icon] of Object.entries(next)) {
    const row = byPath.get(path);
    byPath.delete(path);
    if (row === undefined) await ctx.db.insert("folderIcons", { workspaceId, path, icon });
    else if (row.icon !== icon) await ctx.db.patch(row._id, { icon });
    else continue;
    changed = true;
  }
  for (const row of byPath.values()) {
    if (row.icon === null) {
      if (imported) await ctx.db.delete(row._id);
      continue;
    }
    if (imported) await ctx.db.delete(row._id);
    else await ctx.db.patch(row._id, { icon: null });
    changed = true;
  }
  return changed;
}

async function change(ctx: MutationCtx, workspaceId: Id<"workspaces">, next: (icons: FolderIcons) => FolderIcons | null): Promise<void> {
  const rows = await iconRows(ctx.db, workspaceId);
  const after = next(iconsOf(rows));
  if (after === null) return;
  if (await writeIcons(ctx, workspaceId, rows, after)) await markChanged(ctx, workspaceId, "icons");
}

/** One icon set, or removed with `null`. */
export async function setIconRow(ctx: MutationCtx, workspaceId: Id<"workspaces">, path: string, icon: string | null): Promise<void> {
  await change(ctx, workspaceId, (icons) => {
    if (icon === null ? !(path in icons) : icons[path] === icon) {
      return null;
    }
    const next = { ...icons };
    if (icon === null) delete next[path];
    else next[path] = icon;
    return next;
  });
  // A removal before the import is kept as a `null` row even when no icon is held yet.
  if (icon === null && !(await smallDataImported(ctx.db, workspaceId))) {
    const row = await ctx.db
      .query("folderIcons")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    if (row === null) await ctx.db.insert("folderIcons", { workspaceId, path, icon: null });
  }
}

/** Icons carried along with moves, each applied to what the one before left. */
export async function remapIconRows(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  moves: ReadonlyArray<{ from: string; to: string }>,
): Promise<void> {
  await change(ctx, workspaceId, (icons) => {
    let next = icons;
    let moved = false;
    for (const { from, to } of moves) {
      const after = iconsAfterMove(next, from, to);
      if (after !== null) {
        next = after;
        moved = true;
      }
    }
    return moved ? next : null;
  });
}

/** The icons of a path deleted for good, and of everything beneath it. */
export async function dropIconRows(ctx: MutationCtx, workspaceId: Id<"workspaces">, path: string): Promise<void> {
  await change(ctx, workspaceId, (icons) => iconsAfterDelete(icons, path));
}
