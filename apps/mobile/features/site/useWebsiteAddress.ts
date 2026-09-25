import { useEffect, useRef, useState } from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { ResolvedWebsiteAddress } from "@context/shared";

export interface WebsiteAddressRequest {
  handle: string;
  routePath: string;
  legacySlug?: string;
}

/**
 * Resolve one public address, discarding an answer after navigation, and keep
 * it current while it is open.
 *
 * The page is always read from the bucket, so staying current is only a
 * question of asking again: when the site's revision moves (a save under
 * `website/`, or a rebuild that brings the menu back) and when the visitor
 * returns to the tab (which also catches a file changed outside the app). A
 * refresh keeps the page on screen until the new answer lands; only a new
 * address starts from blank.
 */
export function useWebsiteAddress(
  request: WebsiteAddressRequest | null,
): ResolvedWebsiteAddress | undefined {
  const resolveAddress = useAction(api.functions.websites.resolveAddress);
  const auth = useConvexAuth();
  const [view, setView] = useState<ResolvedWebsiteAddress>();
  const [refreshes, setRefreshes] = useState(0);
  const handle = request?.handle;
  const routePath = request?.routePath;
  const legacySlug = request?.legacySlug;
  const revision = useQuery(
    api.functions.websites.siteRevision,
    handle === undefined ? "skip" : { handle },
  );

  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (revision === undefined) return;
    if (seen.current !== undefined && seen.current !== revision) {
      setRefreshes((count) => count + 1);
    }
    seen.current = revision;
  }, [revision]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") setRefreshes((count) => count + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const address = useRef<string | null>(null);
  useEffect(() => {
    if (auth.isLoading || handle === undefined || routePath === undefined) {
      address.current = null;
      setView(undefined);
      return;
    }
    const key = JSON.stringify([handle, routePath, legacySlug ?? null, auth.isAuthenticated]);
    if (address.current !== key) {
      address.current = key;
      setView(undefined);
    }
    let cancelled = false;
    resolveAddress({
      handle,
      routePath,
      ...(legacySlug === undefined ? {} : { legacySlug }),
    })
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch(() => {
        if (!cancelled) {
          setView({ kind: "unavailable", siteName: null, navigation: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    auth.isAuthenticated,
    auth.isLoading,
    handle,
    legacySlug,
    refreshes,
    resolveAddress,
    routePath,
  ]);

  return view;
}
