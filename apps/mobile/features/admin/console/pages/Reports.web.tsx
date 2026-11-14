/**
 * Reports: the artifact's `P.reports` (thread "Build console People and Reports" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyReports } from "../legacy";
import type { ConsolePage } from "../types";

export const reportsPage: ConsolePage = {
  key: "reports",
  filters: { src: "all", st: "open" },
  windowed: false,
  Legacy: LegacyReports,
};
