/**
 * Settings: the artifact's `P.settings` (thread "Build console Storage, Search and settings" ports it). Until then it draws the old
 * console's section.
 */
import { LegacySettings } from "../legacy";
import type { ConsolePage } from "../types";

export const settingsPage: ConsolePage = {
  key: "settings",
  filters: {},
  windowed: false,
  Legacy: LegacySettings,
};
