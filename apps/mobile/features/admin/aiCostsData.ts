/**
 * The AI costs tab's data, as hooks the section calls.
 *
 * Placeholders until the coordinator wires them to the Convex queries: they
 * return `undefined` (the tab's loading state) and nothing else, so the screen
 * can be built and tested before the queries exist. The shapes are in
 * `apps/convex/functions/lib/adminFns/aiCostsShape.ts`.
 */

import type {
  AiCostsAccount,
  AiCostsCloudflare,
  AiCostsReport,
} from "@context/convex/functions/lib/adminFns/aiCostsShape";

/** The window's report and Cloudflare's own count. Both `undefined` until they land. */
export function useAiCostsData(days: number): {
  report: AiCostsReport | undefined;
  cloudflare: AiCostsCloudflare | undefined;
} {
  void days;
  // TODO(coordinator): wire to api.functions.admin.aiCostsReport (and aiCostsCloudflare)
  return { report: undefined, cloudflare: undefined };
}

/**
 * One account's drill-down. `undefined` while loading or when nothing is
 * open (`userId` null); `null` when the account cannot be found.
 */
export function useAiCostsAccount(userId: string | null, days: number): AiCostsAccount | undefined {
  void userId;
  void days;
  // TODO(coordinator): wire to api.functions.admin.aiCostsAccount
  return undefined;
}
