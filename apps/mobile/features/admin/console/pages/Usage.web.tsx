/**
 * Usage: the artifact's `P.usage` (thread "Build console Home, Growth and Usage" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyUsage } from "../legacy";
import type { ConsolePage } from "../types";

export const usagePage: ConsolePage = {
  key: "usage",
  filters: {},
  windowed: true,
  Legacy: LegacyUsage,
};
