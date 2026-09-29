import { useCallback, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { HOME_SITE_HANDLE } from "../../home/homeSnapshot";
import {
  deviceStorage,
  readCachedWeek,
  shownWeek,
  weekFromPages,
  writeCachedWeek,
  type WhatsNewState,
} from "./whatsNew";

/** How long the site gets to answer before this device's copy is shown. */
const OFFLINE_AFTER_MS = 5_000;

/**
 * The newest devlog week, and whether this person has read it.
 *
 * Asks the pinned site once, and again only when its revision moves, the way
 * the homepage does (`useHomeSite`). Mount it only for a signed-in console:
 * the homepage's visitor already has the devlog page in its sidebar and makes
 * no request to the control plane at all.
 */
export function useWhatsNew(): {
  state: WhatsNewState;
  seenWeek: number | null | undefined;
  markSeen: () => void;
  retry: () => void;
} {
  const [state, setState] = useState<WhatsNewState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const revision = useQuery(api.functions.websites.siteRevision, { handle: HOME_SITE_HANDLE });
  const seenWeek = useQuery(api.functions.devlog.devlogSeenWeek, {});
  const snapshot = useAction(api.functions.websites.siteSnapshot);
  const mark = useMutation(api.functions.devlog.markDevlogSeen);
  const answered = useRef(false);

  const fallBack = useCallback(() => {
    const cached = readCachedWeek(deviceStorage());
    setState(cached === null ? { kind: "error" } : { kind: "offline", ...cached });
  }, []);

  // Nothing heard from the site in time: this device's copy, if it has one.
  useEffect(() => {
    if (answered.current) return;
    const timer = setTimeout(() => {
      if (!answered.current) fallBack();
    }, OFFLINE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [attempt, fallBack]);

  useEffect(() => {
    if (revision === undefined) return;
    let live = true;
    snapshot({ handle: HOME_SITE_HANDLE })
      .then((site) => {
        if (!live) return;
        answered.current = true;
        const week = weekFromPages(site?.pages);
        if (week === null) {
          setState({ kind: "none" });
          return;
        }
        writeCachedWeek(deviceStorage(), week, Date.now());
        setState({ kind: "ready", week });
      })
      .catch(() => {
        if (!live) return;
        answered.current = true;
        fallBack();
      });
    return () => {
      live = false;
    };
  }, [revision, attempt, snapshot, fallBack]);

  const week = shownWeek(state);
  const markSeen = useCallback(() => {
    if (week === null) return;
    void mark({ week: week.number }).catch(() => {
      // Offline: the dot comes back until the next open that reaches us.
    });
  }, [mark, week]);

  const retry = useCallback(() => {
    answered.current = false;
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { state, seenWeek, markSeen, retry };
}
