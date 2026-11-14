/**
 * Flags: the artifact's `P.flags` (thread "Build console Storage, Search and settings" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyFlags } from "../legacy";
import type { ConsolePage } from "../types";

export const flagsPage: ConsolePage = {
  key: "flags",
  filters: {},
  windowed: false,
  Legacy: LegacyFlags,
};
