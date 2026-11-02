/**
 * The triage desk as `texDashboard.triageNow` answers it: each note's facts read from the pinned context's
 * workspace object at its current text (decided by the owner, 2026-11-02;
 * `docs/decisions/storage-and-credentials/facts-in-objects.md`). An action cannot be subscribed to, so the live
 * `triage` query stays only to hear that the desk's rows changed, and the desk is asked again then and once a
 * minute while the page is open (a note's words can change without its row). Until the first answer, or if it
 * fails, the query's own answer stands.
 */

import { useEffect, useRef, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { TexTriage } from "./insights";

/** How often the desk is read again while the page stays open. */
export const DESK_REFRESH_MS = 60_000;

export function useTriageDesk(enabled: boolean): TexTriage | undefined {
  const live = useQuery(api.functions.texDashboard.triage, enabled ? {} : "skip");
  // Held in a ref so the request follows the rows, not the identity of the function handed back.
  const ask = useRef(useAction(api.functions.texDashboard.triageNow));
  const [fresh, setFresh] = useState<TexTriage | undefined>(undefined);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setTick((now) => now + 1), DESK_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || live === undefined) return;
    let current = true;
    ask.current({})
      .then((desk) => current && setFresh(desk))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [enabled, live, tick]);

  if (!enabled) return undefined;
  return fresh ?? live;
}
