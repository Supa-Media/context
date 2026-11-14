/**
 * Search: the artifact's `P.search` (thread "Build console Storage, Search and settings" ports it). Until then it draws the old
 * console's section.
 */
import { LegacySearch } from "../legacy";
import { S } from "../state";
import type { ConsolePage } from "../types";

export const searchPage: ConsolePage = {
  key: "search",
  filters: { idx: "attention", from: "all" },
  windowed: () => S.subs[0] !== "indexes",
  Legacy: LegacySearch,
};
