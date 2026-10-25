/**
 * The links of a folder moved on built paths (`builtMove.ts`; `paths-on-read.md`, "A folder move is one
 * row change"). The move lists none of its files: it queues one `linkRepairs` entry naming the moved row
 * and where it was, and each pass that reaches the entry turns the next page of the files now beneath that
 * row into an ordinary entry of pairs, old name to new, for the rewrite (`lib/nodes/linkRepair.ts`).
 *
 * The row is followed by id, so a folder moved again before its links were followed is read where it is
 * now: its old links go straight to the newest name. The link facts (`nodeLinks.source`) of each page's
 * files follow in the same transaction, since they name a note by its path.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { underHiddenRoot } from "../fileOps/store";
import { isPlumbing } from "../privacy";
import { nodePaths } from "./paths";

/** Rows one page reads beneath the moved folder, and so at most the pairs it makes. */
export const FOLDER_LINK_PAGE = 200;
/** Pages one claim reads past when they hold no file. */
const FOLDER_LINK_PAGES = 10;

/** Queue the links of the folder `root` moved from `from`, and start a pass. */
export async function queueFolderLinks(ctx: MutationCtx, workspaceId: Id<"workspaces">, root: Id<"nodes">, from: string, now: number): Promise<void> {
  await ctx.db.insert("linkRepairs", { workspaceId, pairs: [], folder: { rootId: root, from }, attempts: 0, createdAt: now });
  await ctx.scheduler.runAfter(0, internal.functions.linkRepairs.repairWorkspace, { workspaceId });
}

/**
 * Turn the next page of a folder entry into an entry of pairs, and answer it; `null` when the page held no
 * file. The folder entry is removed once its last page is made, or when its row is gone, in the trash (a
 * trash leaves links where they were, for Restore), or back where it was.
 */
export async function expandFolder(
  ctx: MutationCtx,
  entry: Doc<"linkRepairs">,
  now: number,
  pages = FOLDER_LINK_PAGES,
): Promise<Doc<"linkRepairs"> | null> {
  const folder = entry.folder;
  if (folder === undefined) return null;
  const paths = await nodePaths(ctx.db, entry.workspaceId);
  const root = await ctx.db.get(folder.rootId);
  const at = root === null || root.goneAt !== undefined || root.workspaceId !== entry.workspaceId ? null : await paths.pathOf(root);
  if (at === null || at === folder.from || underHiddenRoot(at)) {
    await ctx.db.delete(entry._id);
    return null;
  }
  // `after` is kept beneath the folder, so a folder moved again between pages resumes where it stopped. The
  // rows read are bounded, folders included, so a page of folders alone ends this one with nothing to pair.
  const pairs: { from: string; to: string }[] = [];
  let read = 0;
  let last: string | undefined;
  const whole = await paths.walk(at, folder.after === undefined ? undefined : `${at}/${folder.after}`, (row) => {
    read += 1;
    last = row.path;
    const below = row.path.slice(at.length);
    if (row.kind === "file" && row.goneAt === undefined && !isPlumbing(row.path)) pairs.push({ from: `${folder.from}${below}`, to: row.path });
    return read < FOLDER_LINK_PAGE;
  });
  for (const pair of pairs) await followLinkFacts(ctx, entry.workspaceId, pair);
  if (whole || last === undefined) await ctx.db.delete(entry._id);
  else await ctx.db.patch(entry._id, { folder: { ...folder, after: last.slice(at.length + 1) } });
  if (pairs.length === 0) {
    // Nothing to rewrite in this page: the pass goes on to the next one rather than stopping on it, a few
    // pages to a transaction; the cron (`repairDue`) picks up a folder entry a pass left behind.
    const left = await ctx.db.get(entry._id);
    return left === null || pages <= 1 ? null : await expandFolder(ctx, left, now, pages - 1);
  }
  const id = await ctx.db.insert("linkRepairs", { workspaceId: entry.workspaceId, pairs, attempts: 0, createdAt: now });
  return await ctx.db.get(id);
}

/** A note's link facts follow it to its new name; facts already written there (a save since the move) are the newer. */
async function followLinkFacts(ctx: MutationCtx, workspaceId: Id<"workspaces">, pair: { from: string; to: string }): Promise<void> {
  const old = await ctx.db
    .query("nodeLinks")
    .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId).eq("source", pair.from))
    .collect();
  if (old.length === 0) return;
  const newer = await ctx.db
    .query("nodeLinks")
    .withIndex("by_workspace_source", (q) => q.eq("workspaceId", workspaceId).eq("source", pair.to))
    .first();
  for (const link of old) {
    if (newer !== null) await ctx.db.delete(link._id);
    else await ctx.db.patch(link._id, { source: pair.to });
  }
}
