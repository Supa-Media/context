import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { ResolvedWebsiteAddress } from "@context/shared";
import { fetchEdgeAddress } from "./edgeAddress";
import {
  answerKey,
  heldAnswer,
  keptAnswer,
  loadAnswer,
  noteRevision,
  noteShown,
  noteSignedIn,
  prefetchMenu,
  prefetchPage,
  type AskAddress,
  type SiteAsk,
} from "./siteAnswers";

export type WebsiteAddressRequest = SiteAsk;

/** How a page of the site at `handle` is asked for when nothing else is said. */
const plainAsk = (handle: string) => (routePath: string): SiteAsk => ({ handle, routePath });

/**
 * One way to ask for an address: a visitor who is not signed in from the copy
 * the router keeps per Publish (`edgeAddress.ts`), anyone else, or any failure
 * there, from Convex.
 */
function useAskAddress(): { ask: AskAddress; signedIn: boolean; ready: boolean } {
  const resolveAddress = useAction(api.functions.websites.resolveAddress);
  const auth = useConvexAuth();
  const signedIn = auth.isAuthenticated;
  const ask = useCallback<AskAddress>(
    async (args) => {
      const plain = { handle: args.handle, routePath: args.routePath, ...(args.legacySlug === undefined ? {} : { legacySlug: args.legacySlug }) };
      const edge = signedIn ? null : await fetchEdgeAddress(plain);
      return edge ?? (await resolveAddress(plain));
    },
    [resolveAddress, signedIn],
  );
  return { ask, signedIn, ready: !auth.isLoading };
}

/**
 * Resolve one public address, discarding an answer after navigation, and keep
 * it current while it is open.
 *
 * Answers are kept for the tab (`siteAnswers.ts`): an address opened before
 * is drawn at once, the pages the site's menu names are fetched as soon as a
 * page lands, and an address not fetched yet keeps the site's last page on
 * screen until its answer lands. Staying current is only a question of asking
 * again: when the site's revision moves (a Publish, or a restriction), which
 * also drops every kept answer for the site, when the visitor returns to the
 * tab, and behind a kept answer that is no longer fresh.
 *
 * `askFor` says how a page of this site is asked for by its route path, the
 * way a click on it would be, so the pages fetched ahead are the ones looked
 * for.
 */
export function useWebsiteAddress(
  request: WebsiteAddressRequest | null,
  askFor?: (routePath: string) => SiteAsk,
): ResolvedWebsiteAddress | undefined {
  const { ask, signedIn, ready } = useAskAddress();
  const [view, setView] = useState<ResolvedWebsiteAddress>();
  const [refreshes, setRefreshes] = useState(0);
  const handle = request?.handle;
  const routePath = request?.routePath;
  const legacySlug = request?.legacySlug;
  const revision = useQuery(
    api.functions.websites.siteRevision,
    handle === undefined ? "skip" : { handle },
  );
  const askForRef = useRef(askFor);
  askForRef.current = askFor;

  useEffect(() => {
    if (revision === undefined || handle === undefined) return;
    if (noteRevision(handle, revision)) setRefreshes((count) => count + 1);
  }, [handle, revision]);

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
    if (!ready || handle === undefined || routePath === undefined) {
      address.current = null;
      setView(undefined);
      return;
    }
    noteSignedIn(signedIn);
    const args: SiteAsk = { handle, routePath, ...(legacySlug === undefined ? {} : { legacySlug }) };
    const key = answerKey(args, signedIn);
    const kept = keptAnswer(args, signedIn);
    const moved = address.current !== key;
    if (moved) {
      address.current = key;
      setView(kept?.view ?? heldAnswer(handle, signedIn));
      if (kept !== undefined) noteShown(args, signedIn, kept.view);
    }
    // A move to a page kept fresh is finished; anything else asks.
    if (moved && kept?.fresh === true) return;
    let cancelled = false;
    loadAnswer(args, signedIn, ask)
      .then((next) => {
        if (cancelled) return;
        setView(next);
        noteShown(args, signedIn, next);
        prefetchMenu(args, next, askForRef.current ?? plainAsk(handle), signedIn, ask);
      })
      .catch(() => {
        if (!cancelled) {
          setView({ kind: "unavailable", siteName: null, navigation: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ask, handle, legacySlug, ready, refreshes, routePath, signedIn]);

  return view;
}

/**
 * Fetch a page of the site at `handle` ahead of a click on it: a designed
 * site's own links, which its menu may not name, as the pointer reaches them.
 */
export function useSitePrefetch(
  handle: string | null,
  askFor?: (routePath: string) => SiteAsk,
): (routePath: string) => void {
  const { ask, signedIn, ready } = useAskAddress();
  return useCallback(
    (routePath: string) => {
      if (!ready || handle === null) return;
      prefetchPage((askFor ?? plainAsk(handle))(routePath), signedIn, ask);
    },
    [ask, askFor, handle, ready, signedIn],
  );
}
