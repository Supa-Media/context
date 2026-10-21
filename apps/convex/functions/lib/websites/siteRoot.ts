/**
 * The website's folder wherever it is nested (owner, 2026-10-21;
 * `docs/decisions/websites.md`, "The website folder can be nested").
 *
 * The site keeps naming its pages under `website/` — the route index, the
 * published copies, every check and every visitor read — so moving or
 * renaming the folder never changes a page's address or takes it off the
 * site. Only the reads that judge who may see a note translate that name to
 * the folder doing the website's job now (`siteRoot`), and answer under the
 * name they were asked by. Judging at the real folder is what reading it by
 * its real name would give, so this never widens what anyone sees; judging at
 * the default name, which no row holds once the folder has moved, would read
 * every page as private and empty the site.
 */

import { DEFAULT_WEBSITE_ROOT } from "@context/shared";
import type { Id } from "../../../_generated/dataModel";
import type { DatabaseReader } from "../../../_generated/server";

/** Whether `path` is written under the website's default name. */
export function namesWebsite(path: string): boolean {
  return path === DEFAULT_WEBSITE_ROOT || path.startsWith(`${DEFAULT_WEBSITE_ROOT}/`);
}

/**
 * The folder doing the website's job in this workspace now: the live folder
 * row whose job is `website` (written before its first move,
 * `claimJobBeforeMove`), unless a root folder really called `website` exists,
 * which keeps that name, as `jobPath` has it. Two indexed reads at most.
 * Unfiltered: callers judge who may see it.
 */
export async function siteRoot(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<string> {
  const held = (
    await db
      .query("nodes")
      .withIndex("by_workspace_role", (q) => q.eq("workspaceId", workspaceId).eq("role", "website"))
      .take(4)
  ).find((row) => row.kind === "folder" && row.goneAt === undefined);
  if (held === undefined || held.path === DEFAULT_WEBSITE_ROOT) return DEFAULT_WEBSITE_ROOT;
  const named = await db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", DEFAULT_WEBSITE_ROOT))
    .unique();
  if (named !== null && named.goneAt === undefined && named.kind === "folder") return DEFAULT_WEBSITE_ROOT;
  return held.path;
}

/** `website/about.md` where the folder is now: `Work/site/about.md`. Other paths are returned as they are. */
export function realSitePath(root: string, path: string): string {
  if (root === DEFAULT_WEBSITE_ROOT || !namesWebsite(path)) return path;
  return `${root}${path.slice(DEFAULT_WEBSITE_ROOT.length)}`;
}

/** The other way: `Work/site/about.md` named as the site names it, or null for a path outside the folder. */
export function siteNameOf(root: string, path: string): string | null {
  if (path === root) return DEFAULT_WEBSITE_ROOT;
  if (path.startsWith(`${root}/`)) return `${DEFAULT_WEBSITE_ROOT}${path.slice(root.length)}`;
  return null;
}
