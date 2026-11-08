/**
 * Whether the signed-in person has a feature flag on (`docs/decisions/app-and-console/feature-flags.md`):
 *
 *   const threads = useFlag("tex.conversation-threads");
 *
 * Every call shares one live query (`functions/featureFlags.ts` `myFlags`; Convex keeps one subscription per query),
 * so a check costs nothing after the first answer, and a change staff make in the console arrives by itself. Before
 * that first answer it is off, as it is for an id not in `packages/shared/src/flags.cjs`: off is the answer for
 * anything unsure. No earlier answer is kept to fill the gap, so a set never outlives the account it was read for.
 */

import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { isFlagId } from "@context/shared/src/flags.cjs";

/** The person's flags, or none while the first answer is on its way. */
export function useFlags(): readonly string[] {
  return useQuery(api.functions.featureFlags.myFlags, {}) ?? [];
}

export function useFlag(flagId: string): boolean {
  const flags = useFlags();
  return isFlagId(flagId) && flags.includes(flagId);
}
