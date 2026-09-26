import { useEffect, useRef, useState } from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { ResolvedWebsiteAddress } from "@context/shared";
import { fetchEdgeAddress } from "./edgeAddress";

export interface WebsiteAddressRequest {
  handle: string;
  routePath: string;
  legacySlug?: string;
}

/**
 * Resolve one public address, discarding an answer after navigation, and keep
 * it current while it is open.
 *
 * A visitor who is not signed in is answered from the copy the router keeps
 * per Publish (`edgeAddress.ts`), and anyone else, or any failure there, by
 * Convex. Staying current is only a question of asking again: when the site's
 * revision moves (a Publish, or a restriction) and when the visitor returns
 * to the tab. A refresh keeps the page on screen until the new answer lands;
 * only a new address starts from blank.
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
    const args = { handle, routePath, ...(legacySlug === undefined ? {} : { legacySlug }) };
    const edge = auth.isAuthenticated ? Promise.resolve(null) : fetchEdgeAddress(args);
    edge
      .then((kept) => kept ?? resolveAddress(args))
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
