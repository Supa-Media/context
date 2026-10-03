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
 * Which pages there are comes from the site's own route index: what was last
 * published, less anything restricted since. One query, not a listing of the
 * whole bucket on every visit, which made the answer too slow for the page to
 * wait for. The words are what was published: the live file when it has not
 * changed since, its release copy when it has. The live files are still read
 * at `PUBLICATION_CLEARANCE`, so a note `privacy.md` holds back, a draft, a
 * members-only page or an encrypted note is absent whatever the index says.
 * The router keeps this answer by `siteRevision`, so these reads happen once
 * per Publish rather than once per visit. Nothing is read unless the site is
 * turned on.
 */

import {
  DEFAULT_WEBSITE_ROOT,
  isWebsiteRootKey,
  parseWebsitePage,
  websiteFolderReference,
  websitePageTitle,
} from "@context/shared";
import { api, internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { findName } from "../nameClaims";
import { isEncryptedNote } from "../noteEncryption";
import { websiteTextRestricts } from "./changes";
import { readBatches } from "./lists";
import { PUBLICATION_CLEARANCE } from "./publication";
import { normalizedHandle } from "./resolver";
import { readPublishedEmoji } from "./emoji";
import { readPublishedImages } from "./images";
import { withFolderList, type FolderPage } from "./folders";

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
  /** The workspace emoji those pages use, `name → data: URL` (see `./emoji`). */
  emoji: Record<string, string>;
  /** The pasted pictures those pages embed, `leaf → data: URL` (see `./images`). */
  images: Record<string, string>;
}

/** A page the site published, as the route index holds it. */
export interface PublishedPage {
  objectKey: string;
  /** Where the site serves it; for a note a `folder:` line published, not its key. */
  routePath: string;
  description: string | null;
  sourceEtag: string;
  releaseId?: string;
  releasePageId?: string;
}

/** The homepage's workspace and the pages its site published, when `handle` is it and its site is on. */
export async function homeSiteWorkspaceHandler(
  ctx: QueryCtx,
  args: { handle: string },
): Promise<{ workspaceId: Id<"workspaces">; siteName: string; pages: PublishedPage[] } | null> {
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
  const rows = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .take(MAX_SNAPSHOT_PAGES * 2);
  const seen = new Set<string>();
  const pages: PublishedPage[] = [];
  for (const row of rows) {
    if (row.status !== "live" || row.audience !== "public" || row.routePath === null) continue;
    // The homepage is drawn in the console's own frame, so a layout, a
    // stylesheet or an all-HTML page is not one of its pages.
    if (row.code !== undefined) continue;
    // The site's own files, and the notes the folders its pages name published.
    if (!/\.md$/i.test(row.objectKey)) continue;
    if (seen.has(row.objectKey)) continue;
    seen.add(row.objectKey);
    pages.push({
      objectKey: row.objectKey,
      routePath: row.routePath,
      description: row.description,
      sourceEtag: row.sourceEtag,
      ...(row.releaseId === undefined ? {} : { releaseId: row.releaseId }),
      ...(row.releasePageId === undefined ? {} : { releasePageId: row.releasePageId }),
    });
  }
  return { workspaceId: workspace._id, siteName: workspace.displayName, pages };
}

/** A folder's `index.md` sorts ahead of the notes beside it, so it leads its folder. */
function folderFirst(path: string): string {
  return path.replace(/(^|\/)index\.md$/i, "$1");
}

/** The notes a folder page published, as the site lists them under it. */
function folderPagesIn(
  pages: ReadonlyArray<{ routePath: string; title: string; description: string | null; referenced: boolean }>,
  routePath: string,
): FolderPage[] {
  const prefix = routePath === "/" ? "/" : `${routePath}/`;
  return pages
    .filter((page) => page.referenced && page.routePath.startsWith(prefix))
    .map(({ routePath: route, title, description }) => ({ routePath: route, title, description }))
    .sort((left, right) => left.routePath.localeCompare(right.routePath));
}

/** `index.md` is its folder's address, as it is on the site. */
export function routePathFor(path: string): string {
  const segments = path.replace(/\.md$/i, "").split("/");
  if (segments.at(-1)?.toLowerCase() === "index") segments.pop();
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

/** The title a page is listed by: its own, else its first heading, else its name. */
export function pageTitle(path: string, title: string | null, body: string): string {
  return websitePageTitle(path, title, body);
}

/** The published copies of `pages`, by file; a copy that is gone is absent. */
async function releasedTexts(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  pages: PublishedPage[],
): Promise<Map<string, string>> {
  const wanted = pages.flatMap((page) =>
    page.releaseId === undefined || page.releasePageId === undefined
      ? []
      : [{ releaseId: page.releaseId, pageId: page.releasePageId, path: page.objectKey }],
  );
  const texts = new Map<string, string>();
  for (let offset = 0; offset < wanted.length; offset += RELEASE_BATCH) {
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      grantedNames: [],
      operation: { kind: "readWebsiteRelease", pages: wanted.slice(offset, offset + RELEASE_BATCH) },
    });
    if (result.kind !== "websiteReleasePages") continue;
    for (const page of result.results) {
      if (page.outcome === "read") texts.set(page.path, page.text);
    }
  }
  return texts;
}

const RELEASE_BATCH = 50;

export async function websiteSnapshot(
  ctx: ActionCtx,
  args: { handle: string },
): Promise<WebsiteSnapshot | null> {
  const home = await ctx.runQuery(internal.functions.websites.homeSiteWorkspace, {
    handle: args.handle,
  });
  if (home === null) return null;
  // Read before the pages, so a publish landing mid-read leaves this older
  // than the site and the client asks again, never the other way round.
  const revision = await ctx.runQuery(api.functions.websites.siteRevision, { handle: args.handle });

  const prefix = `${DEFAULT_WEBSITE_ROOT}/`;
  const published = [...home.pages]
    .sort((left, right) => left.objectKey.localeCompare(right.objectKey))
    .slice(0, MAX_SNAPSHOT_PAGES);
  // The live files are read only to learn whether they still publish their
  // pages; what goes out is what was published.
  const live = await readBatches(
    ctx,
    home.workspaceId,
    PUBLICATION_CLEARANCE.scope,
    published.map((page) => page.objectKey),
  );
  const still = published.filter((page) => {
    const note = live.get(page.objectKey);
    if (note === undefined || isEncryptedNote(note.text) || websiteTextRestricts(note.text)) {
      return false;
    }
    const parsed = parseWebsitePage(note.text);
    return !parsed.draft && parsed.audience === "public";
  });
  const changed = still.filter((page) => live.get(page.objectKey)!.etag !== page.sourceEtag);
  const copies = await releasedTexts(ctx, home.workspaceId, changed);

  const listed: Array<
    WebsiteSnapshotPage & { nav: number | null; description: string | null; folder: boolean; referenced: boolean }
  > = [];
  for (const page of still) {
    const note = live.get(page.objectKey)!;
    const text = note.etag === page.sourceEtag ? note.text : copies.get(page.objectKey);
    if (text === undefined || isEncryptedNote(text)) continue;
    const parsed = parseWebsitePage(text);
    // Invalid frontmatter could be a draft or members-only line the parser
    // refused; it is held back rather than guessed at.
    if (parsed.draft || parsed.audience !== "public") continue;
    if (parsed.problems.some((problem) => problem.code === "invalid_metadata")) continue;
    const own = isWebsiteRootKey(page.objectKey);
    const file = own ? page.objectKey.slice(prefix.length) : `${page.routePath.slice(1)}.md`;
    const routePath = own ? routePathFor(file) : page.routePath;
    const folder = own && websiteFolderReference(text) !== null;
    listed.push({
      // A page that names a folder opens that folder in the sidebar, so the
      // notes it published sit under it: `features.md` is `features/index.md`.
      path: folder && routePath !== "/" ? `${routePath.slice(1)}/index.md` : file,
      routePath,
      title: pageTitle(file, parsed.title, parsed.body),
      markdown: parsed.body,
      nav: parsed.nav,
      description: page.description,
      folder,
      referenced: !own,
    });
  }
  listed.sort(
    (left, right) =>
      (left.nav ?? Number.MAX_SAFE_INTEGER) - (right.nav ?? Number.MAX_SAFE_INTEGER) ||
      folderFirst(left.path).localeCompare(folderFirst(right.path)),
  );
  const pages = listed.map(({ path, routePath, title, markdown, folder }) => ({
    path,
    routePath,
    title,
    markdown: folder ? withFolderList(markdown, folderPagesIn(listed, routePath)) : markdown,
  }));
  const markdowns = pages.map((page) => page.markdown);
  const [emoji, images] = await Promise.all([
    readPublishedEmoji(ctx, home.workspaceId, markdowns).catch(() => ({})),
    readPublishedImages(ctx, home.workspaceId, markdowns).catch(() => ({})),
  ]);
  return { siteName: home.siteName, revision, pages, emoji, images };
}
