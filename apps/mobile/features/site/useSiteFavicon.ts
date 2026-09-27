import { useEffect } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { showFavicon, siteFaviconHref } from "./siteFavicon";

/**
 * Wear `handle`'s workspace icon in the tab while its site is on screen, and
 * give the page's own favicon back on the way out (to the console, or to
 * another site). `null` wears nothing.
 *
 * Called from `HandleSite` and `SiteRoot`, which already hold a Convex client;
 * `WebsitePage` stays a drawing and never fetches. A no-op off the web.
 */
export function useSiteFavicon(handle: string | null): void {
  const read = useAction(api.functions.websites.siteIcon);
  useEffect(() => {
    if (handle === null || typeof document === "undefined") return;
    let cancelled = false;
    let restore: (() => void) | null = null;
    void siteFaviconHref(handle, read).then((href) => {
      if (cancelled || href === null) return;
      restore = showFavicon(document, href);
    });
    return () => {
      cancelled = true;
      restore?.();
    };
  }, [handle, read]);
}
