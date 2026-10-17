/**
 * Tex's check-in (`docs/decisions/texting-assistant/heartbeat.md`).
 *
 * Registrations only; the logic is in `lib/heartbeats/`. The control plane
 * keeps when each person's next check-in is due and how the last one ended,
 * never what it read or said.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import {
  armLinkedHeartbeatsHandler,
  claimDueHeartbeatsHandler,
  recordHeartbeatResultHandler,
} from "./lib/heartbeats/runs";

export const claimDueHeartbeats = internalMutation({
  args: {
    runIds: v.array(v.string()),
    tokens: v.array(v.object({ hashedAccessToken: v.string(), hashedRefreshToken: v.string() })),
  },
  returns: v.array(
    v.object({
      runId: v.string(),
      token: v.number(),
      timeZone: v.string(),
      since: v.union(v.number(), v.null()),
      phones: v.array(v.string()),
    }),
  ),
  handler: claimDueHeartbeatsHandler,
});

export const recordHeartbeatResult = internalMutation({
  args: { runId: v.string(), outcome: v.string() },
  returns: v.union(v.literal("recorded"), v.literal("unknown")),
  handler: recordHeartbeatResultHandler,
});

/** Daily (`crons.ts`): a first check-in for everyone with a linked phone who has none. */
export const armLinkedHeartbeats = internalMutation({
  args: {},
  returns: v.number(),
  handler: armLinkedHeartbeatsHandler,
});
