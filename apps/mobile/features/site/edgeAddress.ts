/**
 * A website address as anybody sees it, from the copy the router keeps at the
 * edge (`infra/router/src/sitePages.ts`) rather than from the bucket.
 *
 * Pages wait for Publish, so the router keeps each one for as long as its
 * site's revision holds still, and a visit costs one small question instead
 * of a read of the customer's storage. Only for a visitor who is not signed
 * in: a members-only page differs by who asks, so a signed-in visitor asks
 * Convex directly. Only on the web over https, where the router is the page's
 * own origin; anywhere else (the native app, local development) there is no
 * router to ask. Every failure is `null`, and the caller asks Convex itself.
 */

import type { ResolvedWebsiteAddress } from "@context/shared";

export const SITE_PAGE_PATH = "/_site/page";

const KINDS = new Set(["page", "authentication_required", "unavailable", "legacy_short_link"]);

export interface EdgeAddressRequest {
  handle: string;
  routePath: string;
  legacySlug?: string;
}

/** The page's own origin when it is served by the router, else `null`. */
export function edgeOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const location = window.location as Location | undefined;
  return location?.protocol === "https:" ? location.origin : null;
}

export function edgeAddressUrl(origin: string, request: EdgeAddressRequest): string {
  const query = new URLSearchParams({ handle: request.handle, path: request.routePath });
  if (request.legacySlug !== undefined) query.set("legacy", request.legacySlug);
  return `${origin}${SITE_PAGE_PATH}?${query.toString()}`;
}

export async function fetchEdgeAddress(
  request: EdgeAddressRequest,
  origin: string | null = edgeOrigin(),
  fetchImpl: typeof fetch | undefined = typeof fetch === "function" ? fetch : undefined,
): Promise<ResolvedWebsiteAddress | null> {
  if (origin === null || fetchImpl === undefined) return null;
  try {
    const response = await fetchImpl(edgeAddressUrl(origin, request), {
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { kind?: unknown } | null;
    return body !== null && typeof body === "object" && KINDS.has(body.kind as string)
      ? (body as ResolvedWebsiteAddress)
      : null;
  } catch {
    return null;
  }
}
