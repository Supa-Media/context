/**
 * Tex's housekeeping (`docs/decisions/texting-assistant/housekeeping.md`).
 *
 * Registrations only; the logic is in `lib/housekeeping/`. The control plane
 * keeps when each person's next run is due and how the last one ended, never
 * what it read or changed.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import {
  armLinkedHousekeepingHandler,
  claimDueHousekeepingHandler,
  recordHousekeepingResultHandler,
} from "./lib/housekeeping/runs";

export const claimDueHousekeeping = internalMutation({
  args: {
    runIds: v.array(v.string()),
    tokens: v.array(v.object({ hashedAccessToken: v.string(), hashedRefreshToken: v.string() })),
  },
  returns: v.array(v.object({ runId: v.string(), token: v.number(), timeZone: v.string() })),
  handler: claimDueHousekeepingHandler,
});

export const recordHousekeepingResult = internalMutation({
  args: { runId: v.string(), outcome: v.string() },
  returns: v.union(v.literal("recorded"), v.literal("unknown")),
  handler: recordHousekeepingResultHandler,
});

/** Daily (`crons.ts`): a first housekeeping run for everyone with a linked phone who has none. */
export const armLinkedHousekeeping = internalMutation({
  args: {},
  returns: v.number(),
  handler: armLinkedHousekeepingHandler,
});
