import { useEffect, useMemo, useState } from "react";
import { useWebsiteAddress } from "../site/useWebsiteAddress";
import {
  BUILT_IN_SITE,
  HOME_SITE_HANDLE,
  LEGAL_PAGES,
  MISSING_PAGE_MARKDOWN,
  PRIVATE_PAGE,
  livePages,
  type HomePage,
} from "./homeSite";

export interface HomeSite {
  /** The site's pages, in menu order, as the tree lists them. */
  site: readonly HomePage[];
  /** The open page's Markdown, or `null` while it loads. */
  markdown: string | null;
  /** True once the workspace's own `website/` folder answered. */
  live: boolean;
}

/**
 * The homepage's pages: the live `website/` folder of `HOME_SITE_HANDLE` when
 * its site is on, the built-in copy when it is not.
 *
 * Until the live site answers, the built-in copy is drawn, so the first paint
 * is a page rather than a blank. Which of the two then stays is decided by the
 * site's home page alone. If `/` resolves,
 * the folder is the homepage and a page it does not have is "Nothing here",
 * exactly as on the site itself; if it does not (the setting is off, the
 * network is down, a self-host has no such workspace), the built-in pages are
 * drawn so the homepage is never blank.
 *
 * The notes that are not site pages (the private one, and Legal) are the
 * shell's own and never asked for.
 */
export function useHomeSite(routePath: string): HomeSite {
  const own = routePath === PRIVATE_PAGE.routePath || LEGAL_PAGES.some((page) => page.routePath === routePath);
  const home = useWebsiteAddress({ handle: HOME_SITE_HANDLE, routePath: "/" });
  const other = useWebsiteAddress(
    own || routePath === "/" ? null : { handle: HOME_SITE_HANDLE, routePath },
  );
  const live = home?.kind === "page";

  // Every page read this visit, so switching back to a tab is instant.
  const [loaded, setLoaded] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const answers = [home, other].filter((view) => view?.kind === "page");
    if (answers.length === 0) return;
    setLoaded((current) => {
      const next = new Map(current);
      for (const view of answers) if (view?.kind === "page") next.set(view.routePath, view.markdown);
      return next;
    });
  }, [home, other]);

  const site = useMemo(
    () => (home?.kind === "page" ? livePages(home.navigation, loaded) : BUILT_IN_SITE),
    [home, loaded],
  );

  const builtIn = BUILT_IN_SITE.find((page) => page.routePath === routePath)?.markdown ?? null;
  let markdown: string | null;
  if (own) {
    markdown = [PRIVATE_PAGE, ...LEGAL_PAGES].find((page) => page.routePath === routePath)!.markdown;
  } else if (!live) {
    // Not answered yet, or answered "no site": the built-in copy either way,
    // so the first paint is never blank and a server that never answers
    // (offline, or no such workspace) leaves a whole homepage behind.
    markdown = builtIn ?? (home === undefined ? null : MISSING_PAGE_MARKDOWN);
  } else if (routePath === "/") {
    markdown = home.markdown;
  } else if (other === undefined) {
    markdown = loaded.get(routePath) ?? builtIn;
  } else {
    markdown = other.kind === "page" ? other.markdown : MISSING_PAGE_MARKDOWN;
  }

  return { site, markdown, live };
}
