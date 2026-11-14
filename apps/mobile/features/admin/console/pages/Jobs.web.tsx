/**
 * Jobs: the artifact's `P.jobs` (thread "Build console Jobs page" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyJobs } from "../legacy";
import type { ConsolePage } from "../types";

export const jobsPage: ConsolePage = {
  key: "jobs",
  filters: { who: "all" },
  windowed: false,
  Legacy: LegacyJobs,
};
