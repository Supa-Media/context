/**
 * AI costs: the artifact's `P.costs` (thread "Build console Turns and AI costs" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyCosts } from "../legacy";
import type { ConsolePage } from "../types";

export const costsPage: ConsolePage = {
  key: "costs",
  filters: {},
  windowed: true,
  Legacy: LegacyCosts,
};
