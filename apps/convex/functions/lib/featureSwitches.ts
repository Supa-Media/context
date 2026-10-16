/**
 * The features staff switch on and off in the admin console's Features tab
 * (`functions/featureSwitches.ts`). A switch is for a feature that is built
 * and shipped but not yet open to everyone: its code is on production, and
 * this row decides whether it runs. Every switch is off until staff turn it
 * on, and a missing row reads as off.
 */

import type { QueryCtx } from "../../_generated/server";

export const FEATURES = [
  {
    key: "vaultKeyUse",
    label: "AIs use vault keys",
    description:
      "Lets an AI use a saved key through Context on the one website it is for, after the person says yes. Off, every request is refused and no key leaves the vault.",
  },
] as const;

export type FeatureKey = (typeof FEATURES)[number]["key"];

export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURES.some((feature) => feature.key === value);
}

/** Every feature's state, a missing row being off. */
export async function featureStates(ctx: Pick<QueryCtx, "db">): Promise<Record<FeatureKey, boolean>> {
  const states = Object.fromEntries(FEATURES.map((feature) => [feature.key, false])) as Record<FeatureKey, boolean>;
  for (const row of await ctx.db.query("featureSwitches").collect()) {
    if (isFeatureKey(row.key)) states[row.key] = row.on;
  }
  return states;
}
