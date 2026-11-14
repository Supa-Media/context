/**
 * Credentials: the artifact's `P.credentials` (thread "Build console Storage, Search and settings" ports it). Until then it draws the old
 * console's section.
 */
import { LegacyCredentials } from "../legacy";
import type { ConsolePage } from "../types";

export const credentialsPage: ConsolePage = {
  key: "credentials",
  filters: {},
  windowed: false,
  Legacy: LegacyCredentials,
};
