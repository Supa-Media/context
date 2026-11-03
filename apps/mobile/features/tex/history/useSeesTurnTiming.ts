import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

/**
 * Whether the viewer builds Tex: an owner or editor of the pinned context
 * (`functions/texTurnTiming.ts`), so the history draws where each turn's time
 * went (Dev, 2026-11-03: "only breakdowns for developers", then "not just
 * admin page, any context-lc editor"). False while it is asked, so nobody
 * else ever sees it flash in.
 */
export function useSeesTurnTiming(): boolean {
  return useQuery(api.functions.texTurnTiming.canSeeTurnTiming, {}) === true;
}
