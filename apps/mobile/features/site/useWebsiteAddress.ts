import { useEffect, useState } from "react";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { ResolvedWebsiteAddress } from "@context/shared";

export interface WebsiteAddressRequest {
  handle: string;
  routePath: string;
  legacySlug?: string;
}

/** Resolve one public address once, discarding an answer after navigation. */
export function useWebsiteAddress(
  request: WebsiteAddressRequest | null,
): ResolvedWebsiteAddress | undefined {
  const resolveAddress = useAction(api.functions.websites.resolveAddress);
  const auth = useConvexAuth();
  const [view, setView] = useState<ResolvedWebsiteAddress>();
  const handle = request?.handle;
  const routePath = request?.routePath;
  const legacySlug = request?.legacySlug;

  useEffect(() => {
    if (auth.isLoading || handle === undefined || routePath === undefined) {
      setView(undefined);
      return;
    }
    let cancelled = false;
    setView(undefined);
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
    resolveAddress,
    routePath,
  ]);

  return view;
}
