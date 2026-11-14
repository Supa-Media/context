/**
 * People: the artifact's `P.people` (thread "Build console People and Reports" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyPeople } from "../legacy";
import type { ConsolePage } from "../types";

export const peoplePage: ConsolePage = {
  key: "people",
  filters: { aud: "all", ans: "0", told: "all", ps: "all", cf: "all", sort: "lastup" },
  windowed: false,
  Legacy: LegacyPeople,
};
