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
import { requestAttentionHandler } from "./lib/attention/ask";

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
      attention: v.boolean(),
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

/**
 * An agent asks for the person's attention (`lib/attention/ask.ts`): counted,
 * spaced and made due on the person's check-in row, which delivers it.
 */
export const requestAttention = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    urgency: v.union(v.literal("emergency"), v.literal("asked"), v.literal("fyi")),
    deliver: v.boolean(),
  },
  returns: v.union(
    v.null(),
    v.object({ status: v.union(v.literal("soon"), v.literal("later")), dueAt: v.number(), timeZone: v.string() }),
    v.object({ status: v.union(v.literal("limit"), v.literal("held")), timeZone: v.string() }),
    v.object({ status: v.literal("not_texting") }),
  ),
  handler: requestAttentionHandler,
});
