/**
 * The homepage's site in one answer: every note in its `website/` folder that
 * the site publishes, words and all, with the folders they sit in.
 *
 * The homepage is `@context-lc`'s `website/` folder drawn as a workspace, and
 * its sidebar is that folder, exactly: a note there is a page there, whether
 * or not it carries a title or a `nav:` number. The router asks for this once,
 * beside the page's HTML, and hands it to the app in that HTML, so the first
 * paint is the live site and nothing replaces it.
 *
 * **It answers for the homepage's workspace and no other.** Listing a whole
 * folder, unlisted pages included, is the homepage owner's choice for their own
 * homepage; for any other handle it would make every site's pages without a
 * menu entry enumerable, so every other handle is the null answer.
 *
 * What it reads is what the site may publish: the folder listed and read at
 * `PUBLICATION_CLEARANCE`, so a note `privacy.md` holds back is absent from the
 * listing itself. Drafts, members-only pages and encrypted notes are dropped
 * as they are on the site, and nothing is read unless the site is turned on.
 */

import { DEFAULT_WEBSITE_ROOT, parseWebsitePage } from "@context/shared";
import { api, internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { findName } from "../nameClaims";
import { isEncryptedNote } from "../noteEncryption";
import { readBatches } from "./lists";
import { PUBLICATION_CLEARANCE } from "./publication";
import { normalizedHandle } from "./resolver";

/** Whose `website/` folder is the homepage. A self-host names its own. */
export function homeSiteHandle(): string {
  return process.env.HOME_SITE_HANDLE ?? "context-lc";
}

/** Beyond this a folder is not a homepage, and one answer should not read it all. */
export const MAX_SNAPSHOT_PAGES = 200;

export interface WebsiteSnapshotPage {
  /** The file under `website/`, folders and all: `Legal/privacy.md`. */
  path: string;
  routePath: string;
  title: string;
  markdown: string;
}

export interface WebsiteSnapshot {
  siteName: string;
  /** `siteRevision` when this was read, so a client can tell it is current. */
  revision: string | null;
  /** `nav:` order first, then by path; the home page wherever that puts it. */
  pages: WebsiteSnapshotPage[];
}

/** The homepage's workspace, when `handle` is it and its site is on. */
export async function homeSiteWorkspaceHandler(
  ctx: QueryCtx,
  args: { handle: string },
): Promise<{ workspaceId: Id<"workspaces">; siteName: string } | null> {
  const handle = normalizedHandle(args.handle);
  if (handle === null || handle !== normalizedHandle(homeSiteHandle())) return null;
  const claim = await findName(ctx, handle);
  if (claim?.workspaceId === undefined) return null;
  const workspace = await ctx.db.get(claim.workspaceId);
  if (workspace === null) return null;
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .unique();
  if (state?.state !== "enabled") return null;
  return { workspaceId: workspace._id, siteName: workspace.displayName };
}

/** `index.md` is its folder's address, as it is on the site. */
export function routePathFor(path: string): string {
  const segments = path.replace(/\.md$/i, "").split("/");
  if (segments.at(-1)?.toLowerCase() === "index") segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** The title a page is listed by: its own, else its first heading, else its name. */
export function pageTitle(path: string, title: string | null, body: string): string {
  if (title !== null && title !== "") return title;
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim();
  if (heading) return heading;
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
}

export async function websiteSnapshot(
  ctx: ActionCtx,
  args: { handle: string },
): Promise<WebsiteSnapshot | null> {
  const home = await ctx.runQuery(internal.functions.websites.homeSiteWorkspace, {
    handle: args.handle,
  });
  if (home === null) return null;
  // Read before the pages, so an edit landing mid-read leaves this older than
  // the site and the client asks again, never the other way round.
  const revision = await ctx.runQuery(api.functions.websites.siteRevision, { handle: args.handle });

  const prefix = `${DEFAULT_WEBSITE_ROOT}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const manifest = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: home.workspaceId,
      ...PUBLICATION_CLEARANCE,
      operation: { kind: "manifest", ...(cursor === undefined ? {} : { cursor }) },
    });
    if (manifest.kind !== "manifest") return null;
    for (const entry of manifest.entries) {
      if (entry.path.startsWith(prefix) && /\.md$/i.test(entry.path)) keys.push(entry.path);
    }
    if (manifest.truncated) return null;
    const next = manifest.cursor ?? undefined;
    if (next === undefined || next === cursor) break;
    cursor = next;
  }

  const notes = await readBatches(
    ctx,
    home.workspaceId,
    PUBLICATION_CLEARANCE.scope,
    keys.sort().slice(0, MAX_SNAPSHOT_PAGES),
  );
  const listed: Array<WebsiteSnapshotPage & { nav: number | null }> = [];
  for (const [key, note] of notes) {
    if (isEncryptedNote(note.text)) continue;
    const parsed = parseWebsitePage(note.text);
    // Invalid frontmatter could be a draft or members-only line the parser
    // refused; it is held back rather than guessed at.
    if (parsed.draft || parsed.audience !== "public") continue;
    if (parsed.problems.some((problem) => problem.code === "invalid_metadata")) continue;
    const path = key.slice(prefix.length);
    listed.push({
      path,
      routePath: routePathFor(path),
      title: pageTitle(path, parsed.title, parsed.body),
      markdown: parsed.body,
      nav: parsed.nav,
    });
  }
  listed.sort(
    (left, right) =>
      (left.nav ?? Number.MAX_SAFE_INTEGER) - (right.nav ?? Number.MAX_SAFE_INTEGER) ||
      left.path.localeCompare(right.path),
  );
  return {
    siteName: home.siteName,
    revision,
    pages: listed.map(({ path, routePath, title, markdown }) => ({ path, routePath, title, markdown })),
  };
}
