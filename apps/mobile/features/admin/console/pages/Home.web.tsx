/**
 * Home: the artifact's `P.home` (thread "Build console Home, Growth and Usage" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyHome } from "../legacy";
import type { ConsolePage } from "../types";

export const homePage: ConsolePage = {
  key: "home",
  filters: {},
  windowed: true,
  Legacy: LegacyHome,
};
