/**
 * A site's own design, drawn on the web.
 *
 * The page's HTML is composed from the sanitized frame and layout and the
 * page's own words, and sanitized again as a whole (`designHtml.ts`,
 * `composeSitePage`), then set as the inner HTML of one container. Its
 * stylesheet is set as text, never parsed as markup, after the base sheet,
 * and every rule in it is scoped to the container (`.ctx-site`).
 *
 * A link to a page on this site is followed in place, as the default look's
 * menu is, and carries the real address so a new tab opens the right page.
 * Every other link is left to the browser.
 *
 * The page scrolls in a box of its own: the app turns the document's
 * scrolling off (`public/index.html`), so without one a long site could never
 * be read past its first screen, and a site should not have to know that.
 */

import { createElement, useEffect, useMemo, useRef } from "react";
import { SITE_BASE_CSS, SITE_SCOPE_CLASS, googleFontsUrl, type ResolvedWebsitePage, type WebsiteDesign } from "@context/shared";
import { emojiPictures } from "../../share/emojiPictures";
import { publishedImages } from "../../share/publishedImages";
import { designedPageHtml, sitePathOf } from "./designHtml";

export const designedSiteAvailable = true;

const FONT_LINK = "data-context-site-font";

export function DesignedSite({
  view,
  design,
  navigate,
  hrefFor,
}: {
  view: Extract<ResolvedWebsitePage, { kind: "page" }>;
  design: WebsiteDesign;
  navigate: (routePath: string) => void;
  hrefFor: (routePath: string) => string;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const html = useMemo(
    () => designedPageHtml(view, design, { emoji: emojiPictures(view.emoji), images: publishedImages(view.images) }),
    [view, design],
  );

  // The site's fonts, from Google Fonts only, the way the default look loads its serif.
  useEffect(() => {
    const links: HTMLLinkElement[] = [];
    for (const raw of design.fonts) {
      const href = googleFontsUrl(raw);
      if (href === null) continue;
      const loaded = [...document.querySelectorAll<HTMLLinkElement>(`link[${FONT_LINK}]`)].some(
        (link) => link.getAttribute("href") === href,
      );
      if (loaded) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.setAttribute(FONT_LINK, "");
      document.head.appendChild(link);
      links.push(link);
    }
    return () => links.forEach((link) => link.remove());
  }, [design.fonts]);

  // Real addresses on this site's links, so hovering and new tabs are right;
  // the site path is kept beside it for following the link in place. Only
  // `data-ctx-*` is ours: the sanitizer strips it from anything a site writes.
  useEffect(() => {
    const root = container.current;
    if (root === null) return;
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const path = sitePathOf(anchor.getAttribute("href") ?? "", view.routePath);
      if (path === null) continue;
      anchor.setAttribute("data-ctx-path", path);
      anchor.setAttribute("href", hrefFor(path));
    }
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[data-ctx-path]");
      if (anchor === null || anchor === undefined || anchor.getAttribute("target") === "_blank") return;
      const path = anchor.getAttribute("data-ctx-path")!;
      const [route, hash] = path.split("#");
      if (route === view.routePath && hash !== undefined) return;
      event.preventDefault();
      navigate(route!);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [html, hrefFor, navigate, view.routePath]);

  // A new page opens at its top, as a page load would.
  useEffect(() => {
    if (scroller.current !== null) scroller.current.scrollTop = 0;
  }, [view.routePath]);

  return createElement(
    "div",
    {
      ref: scroller,
      "data-testid": "site-scroll",
      style: { height: "100%", flex: "1 1 0%", minHeight: 0, overflowY: "auto", WebkitOverflowScrolling: "touch" },
    },
    // Set as text, so it is never read as markup; every rule is scoped below.
    createElement("style", null, `${SITE_BASE_CSS}\n${design.css}`),
    createElement("div", {
      className: SITE_SCOPE_CLASS,
      "data-testid": "site-designed",
      ref: container,
      dangerouslySetInnerHTML: { __html: html },
    }),
  );
}
