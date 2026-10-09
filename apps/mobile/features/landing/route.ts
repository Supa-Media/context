import { landingPageFromPath, type LandingPage } from "@context/shared";
import { CAST_PREVIEW_PARAM } from "../home/castPreview";

/**
 * Which landing page, if any, an address on the web shows (Dev2, 2026-10-09:
 * "5 different landing pages /a /b /c /d /e, default to a").
 *
 * `/` is page a, and `/a` to `/e` are their own. The website the homepage
 * used to draw at `/` is still the homepage everywhere else: any `?page=`
 * (`/?page=pricing`, which `/pricing` redirects to) is a page of the site, and
 * a cast preview's draft (`/#cast-preview=…`) and the cast studio's stage are
 * recordings of it, so none of those is a landing page.
 */
export function landingFor(address: { pathname: string; page?: string | string[]; hash?: string; studio?: boolean }): LandingPage | null {
  if (address.studio) return null;
  const page = Array.isArray(address.page) ? address.page[0] : address.page;
  if (page !== undefined && page !== "") return null;
  if ((address.hash ?? "").includes(`${CAST_PREVIEW_PARAM}=`)) return null;
  return landingPageFromPath(address.pathname);
}
