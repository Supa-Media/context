/**
 * Turns: the artifact's `P.turns` (thread "Build console Turns and AI costs" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyTurns } from "../legacy";
import type { ConsolePage } from "../types";

export const turnsPage: ConsolePage = {
  key: "turns",
  filters: { end: "all" },
  windowed: true,
  Legacy: LegacyTurns,
};
