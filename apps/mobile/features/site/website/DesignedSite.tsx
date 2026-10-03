/**
 * A site's own design, on native: there is no document to draw HTML into, so
 * a designed page falls back to the default look (`WebsitePage` checks
 * `designedSiteAvailable` first). The web build is `DesignedSite.web.tsx`.
 */

import type { ResolvedWebsitePage, WebsiteDesign } from "@context/shared";

export const designedSiteAvailable = false;

export function DesignedSite(_props: {
  view: Extract<ResolvedWebsitePage, { kind: "page" }>;
  design: WebsiteDesign;
  navigate: (routePath: string) => void;
  hrefFor: (routePath: string) => string;
}) {
  return null;
}
