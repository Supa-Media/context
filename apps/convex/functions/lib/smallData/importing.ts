/**
 * The one-time import of a workspace's small data from its bucket: the
 * forwarding ledger, the icons file and the emoji the image store holds,
 * merged into what Convex already has. Run by the sync (`sync.ts`) once per
 * workspace, and again after its storage moved to another bucket.
 *
 * **Never over a newer value.** Everything Convex holds was decided after
 * this deployment started holding it, so it wins:
 *
 *  - the ledger is the file's entries with Convex's own replayed after them,
 *    oldest first, through the same engine, so a move recorded here collapses
 *    a chain the file began, and a later move of the same path wins;
 *  - an icon the file names is taken only for a path Convex has no row for,
 *    a removal included (a `null` row), after being carried through the moves
 *    Convex recorded, which the file never saw;
 *  - an emoji is taken only for a name Convex has no row for.
 *
 * Idempotent: a workspace already imported is left alone, so a second run of
 * the same sync changes nothing.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { addForwarding } from "../../../../mcp/src/forwarding.js";
import { iconsAfterMove } from "@context/shared/src/folderIcons.cjs";
import { type ForwardingEntry, ledgerOf, ledgerRows, writeLedger } from "./forwarding";
import { iconRows } from "./icons";
import { ensureSmallDataState } from "./state";

export interface FoundSmallData {
  forwarding: ForwardingEntry[];
  icons: Array<{ path: string; icon: string }>;
  emoji: Array<{ name: string; leaf: string }>;
}

export async function importSmallData(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  found: FoundSmallData,
  now: number,
): Promise<{ imported: boolean }> {
  const state = await ensureSmallDataState(ctx, workspaceId);
  if (state.importedAt !== undefined) return { imported: false };

  // The ledger: the file's, then every move recorded here since, in order.
  const rows = await ledgerRows(ctx.db, workspaceId);
  const held = ledgerOf(rows).entries;
  let ledger: { version: 1; entries: ForwardingEntry[] } = { version: 1, entries: [...found.forwarding] };
  for (const entry of held) {
    ledger = addForwarding(ledger, [{ from: entry.from, to: entry.to, kind: entry.kind }], { now: entry.at }) as typeof ledger;
  }
  await writeLedger(ctx, workspaceId, rows, ledger.entries);

  // The icons: the file's, carried through the moves only Convex saw, where Convex has no row.
  let fileIcons: Record<string, string> = Object.fromEntries(found.icons.map(({ path, icon }) => [path, icon]));
  for (const entry of held) fileIcons = iconsAfterMove(fileIcons, entry.from, entry.to) ?? fileIcons;
  const icons = await iconRows(ctx.db, workspaceId);
  const known = new Set(icons.map((row) => row.path));
  for (const [path, icon] of Object.entries(fileIcons)) {
    if (!known.has(path)) await ctx.db.insert("folderIcons", { workspaceId, path, icon });
  }
  // Removals made before the import have done their work.
  for (const row of icons) if (row.icon === null) await ctx.db.delete(row._id);

  // The emoji: every name the bucket holds that Convex does not.
  for (const { name, leaf } of found.emoji) {
    const row = await ctx.db
      .query("customEmoji")
      .withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId).eq("name", name))
      .unique();
    if (row === null) await ctx.db.insert("customEmoji", { workspaceId, name, leaf });
  }

  // A file is owed a write only where Convex held something the file did not.
  await ctx.db.patch(state._id, {
    importedAt: now,
    ...(held.length > 0 ? { forwardingVersion: state.forwardingVersion + 1 } : {}),
    ...(icons.length > 0 ? { iconsVersion: state.iconsVersion + 1 } : {}),
  });
  return { imported: true };
}
