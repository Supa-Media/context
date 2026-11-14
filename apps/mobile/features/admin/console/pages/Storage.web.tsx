/**
 * Storage: the artifact's `P.storage` (thread "Build console Storage, Search and settings" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyStorage } from "../legacy";
import type { ConsolePage } from "../types";

export const storagePage: ConsolePage = {
  key: "storage",
  filters: { ws: "all" },
  windowed: false,
  Legacy: LegacyStorage,
};
