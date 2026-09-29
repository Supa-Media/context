import { useEffect, useReducer, useRef, useState } from "react";
import { Platform } from "react-native";
import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import {
  HOME_SITE_HANDLE,
  homeSourceReducer,
  initialHomeSource,
  injectedHomeSnapshot,
  isStale,
  parseHomeSnapshot,
  type HomeSnapshot,
  type HomeSource,
} from "./homeSnapshot";
import { castPreviewFrom } from "./castPreview";

/** How long a visit with no site in its HTML waits before drawing the copy. */
const WAIT_MS = 4_000;

/**
 * An owner's "Preview demo" tab: their draft, from the address. The fragment
 * stays, so reloading the tab plays the show again.
 */
function previewForThisTab(): HomeSnapshot | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  return castPreviewFrom(window.location.hash);
}

/**
 * The homepage's source for this visit (`HomeSource` says what each is). It
 * starts from the site in the HTML, asks for one when there is none, and asks
 * again only when the site's revision moves, so an edit to `website/` shows up
 * without a reload and nothing else ever redraws the page.
 */
export function useHomeSite(): HomeSource {
  // An owner's "Preview demo" tab: their draft is the site, and the real one
  // never replaces it (`castPreview.ts`).
  const [preview] = useState(previewForThisTab);
  const [source, dispatch] = useReducer(homeSourceReducer, undefined, () =>
    initialHomeSource(preview ?? injectedHomeSnapshot(), Platform.OS === "web"),
  );
  const snapshot = useAction(api.functions.websites.siteSnapshot);
  const revision = useQuery(
    api.functions.websites.siteRevision,
    source.kind === "builtIn" || preview !== null ? "skip" : { handle: HOME_SITE_HANDLE },
  );

  const asking = useRef(false);
  const waiting = source.kind === "waiting";
  const stale = isStale(source, revision);
  useEffect(() => {
    if ((!waiting && !stale) || asking.current) return;
    asking.current = true;
    let done = false;
    const timer = waiting
      ? setTimeout(() => {
          if (!done) dispatch({ type: "gaveUp" });
        }, WAIT_MS)
      : undefined;
    snapshot({ handle: HOME_SITE_HANDLE })
      .then((answer) => dispatch({ type: "answered", snapshot: parseHomeSnapshot(answer) }))
      .catch(() => dispatch({ type: "answered", snapshot: null }))
      .finally(() => {
        done = true;
        asking.current = false;
        if (timer !== undefined) clearTimeout(timer);
      });
    // `source` too: an answer read before the latest edit leaves it stale,
    // and asks once more.
  }, [waiting, stale, snapshot, source]);

  return source;
}
