/**
 * Growth: the artifact's `P.growth` (thread "Build console Home, Growth and Usage" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyGrowth } from "../legacy";
import type { ConsolePage } from "../types";

export const growthPage: ConsolePage = {
  key: "growth",
  filters: { aud: "all" },
  windowed: false,
  Legacy: LegacyGrowth,
};
