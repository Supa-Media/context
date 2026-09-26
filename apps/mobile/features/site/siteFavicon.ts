import { dataUrlFor } from "../console/files/imageBytes";

/**
 * A published site's favicon: the workspace's own icon, in place of Context's.
 *
 * Pure, and free of Convex, for the reason `useWorkspaceIcons` gives: the
 * fetch is passed in by the one hook that holds a client, so this module can be
 * tested and imported anywhere. The server answers `null` for every site that
 * is not on, so an absent icon and a site nobody published look the same here
 * as they do to a visitor: the Context favicon stays.
 */

/** What `websites.siteIcon` answers. */
export type SiteIconAnswer =
  | null
  | { kind: "emoji"; emoji: string }
  | { kind: "photo"; bytes: ArrayBuffer; contentType: string };

/**
 * An emoji as an SVG the browser draws in the tab.
 *
 * Escaped as XML and then percent-encoded, so nothing in the value can end the
 * `<text>` or the attribute the URL sits in. The server stores only a single
 * emoji; this does not rely on that.
 */
export function emojiFaviconHref(emoji: string): string {
  const text = emoji
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    `<text x="50" y="50" dy=".35em" text-anchor="middle" font-size="88">${text}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}`;
}

/**
 * One answer per handle for the session. The icon changes rarely and a stale
 * one in a tab costs nothing, so a visitor clicking through a site asks once
 * rather than once per page. A failure is cached too, as the Context favicon,
 * so a store that is down costs one request.
 */
const answers = new Map<string, Promise<string | null>>();

export function siteFaviconHref(
  handle: string,
  read: (args: { handle: string }) => Promise<SiteIconAnswer>,
): Promise<string | null> {
  const cached = answers.get(handle);
  if (cached !== undefined) return cached;
  const pending = read({ handle })
    .then((icon) => {
      if (icon === null) return null;
      if (icon.kind === "emoji") return emojiFaviconHref(icon.emoji);
      return dataUrlFor(icon.bytes, icon.contentType);
    })
    .catch(() => null);
  answers.set(handle, pending);
  return pending;
}

/** For tests: forget every answer. */
export function resetSiteFaviconCache(): void {
  answers.clear();
}

/**
 * Put `href` in the tab, and return how to take it back out.
 *
 * The page's own icon links (Expo inserts one) are detached rather than
 * rewritten, and the same nodes go back where they were on restore, so leaving
 * the site for the console gives back exactly the head it had. Detached rather
 * than left beside ours because which of several icon links a browser picks
 * is not something to rely on.
 */
export function showFavicon(doc: Document, href: string): () => void {
  const head = doc.head;
  const originals = Array.from(head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')).map(
    (link) => ({ link, parent: link.parentNode, next: link.nextSibling }),
  );
  for (const { link } of originals) link.remove();
  const ours = doc.createElement("link");
  ours.rel = "icon";
  ours.href = href;
  ours.setAttribute("data-site-favicon", "");
  head.appendChild(ours);

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    ours.remove();
    for (const { link, parent, next } of originals) {
      if (parent === null) continue;
      parent.insertBefore(link, next !== null && next.parentNode === parent ? next : null);
    }
  };
}
