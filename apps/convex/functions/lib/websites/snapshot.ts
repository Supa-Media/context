/**
 * A whole small site in one answer: every page its menu lists, words and all,
 * as an anonymous visitor is shown them.
 *
 * The homepage is `@context-lc`'s `website/` folder drawn as a workspace, and
 * its sidebar is the folder. Asking for the menu first and then each page as
 * it is opened made the tree arrive before its pages, and the built-in copy
 * drawn while waiting was replaced a moment later: the flicker the owner
 * asked to be rid of. The router asks for this once, beside the page's HTML,
 * and hands it to the app in that HTML, so the first paint is the live site.
 *
 * Every page goes through the page resolver as an anonymous viewer, so every
 * rule a visitor is held to (the site is on, `privacy.md` publishes the page
 * at `PUBLICATION_CLEARANCE`, it is live, not members-only, not encrypted)
 * holds here with no second copy. The menu is the resolver's too: public live
 * pages with a `nav:` number, in that order. A page it does not list is not
 * listed here, so nothing unlisted becomes discoverable through this.
 */

import { api } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { resolveWebsitePageAs } from "./resolver";

/** Beyond this a site is not a homepage, and one answer should not read it all. */
export const MAX_SNAPSHOT_PAGES = 40;

export interface WebsiteSnapshotPage {
  routePath: string;
  title: string;
  markdown: string;
}

export interface WebsiteSnapshot {
  siteName: string;
  /** `siteRevision` when this was read, so a client can tell it is current. */
  revision: string | null;
  /** The home page first, then the menu in its order. */
  pages: WebsiteSnapshotPage[];
}

export async function websiteSnapshot(
  ctx: ActionCtx,
  args: { handle: string },
): Promise<WebsiteSnapshot | null> {
  // Read before the pages, so an edit landing mid-read leaves this older than
  // the site and the client asks again, never the other way round.
  const revision = await ctx.runQuery(api.functions.websites.siteRevision, { handle: args.handle });
  const home = await resolveWebsitePageAs(ctx, { handle: args.handle, routePath: "/" }, null);
  if (home.kind !== "page" || home.audience !== "public") return null;

  const listed = home.navigation
    .filter((item) => item.routePath !== "/")
    .slice(0, MAX_SNAPSHOT_PAGES - 1);
  const resolved = await Promise.all(
    listed.map((item) =>
      resolveWebsitePageAs(ctx, { handle: args.handle, routePath: item.routePath }, null).catch(
        () => null,
      ),
    ),
  );
  const pages: WebsiteSnapshotPage[] = [
    { routePath: "/", title: home.title, markdown: home.markdown },
  ];
  resolved.forEach((page, index) => {
    // A page that stopped resolving between the menu and its read (restricted,
    // turned members-only, deleted) is simply absent, as it is on the site.
    if (page?.kind !== "page" || page.audience !== "public") return;
    pages.push({ routePath: listed[index]!.routePath, title: page.title, markdown: page.markdown });
  });
  return { siteName: home.siteName, revision, pages };
}
