/**
 * MEETING SUMMARIES: WHO MAY RUN ONE, AND THE METER.
 *
 * A meeting's transcript becomes a summary note through a model call the
 * gateway makes (`apps/mcp`), on Anthropic's Haiku. Every plan may have them,
 * "Same for all" (decided by the owner, 2026-10-09): a paying workspace gets
 * the larger daily cap and a free one the smaller (`dailyCallsFree` in
 * `lib/jev/features.ts`). The kill switch is
 * `admin.setJevSwitch({ feature: "meetingSummary", off: true })`, like the rest.
 *
 * Any live grant may start one. The gateway has already checked that the grant
 * can write the note, so there is no client allow-list here, unlike the
 * built-in model's (`functions/builtinModel.ts`).
 *
 * Nothing about the meeting reaches this file. The gateway reports token counts
 * after the call, never text.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { isPaying, type JevRefusal } from "./lib/jev/meter";
import { HAIKU_MODEL } from "./lib/jev/models";
import { countTurn, recordTurn, resolveTurn } from "./lib/jev/turns";

/** The meter's name for this feature. Permanent: usage and switches are keyed by it. */
export const MEETING_FEATURE = "meetingSummary" as const;

const refusalValidator = v.union(v.literal("disabled"), v.literal("switched_off"), v.literal("daily_cap"));

/** A meeting summary is open to every plan, so `not_premium` can never be its refusal. */
function meetingRefusal(reason: JevRefusal): "disabled" | "switched_off" | "daily_cap" {
  if (reason === "not_premium") throw new Error("a meeting summary is open to every plan, so it is never refused as not_premium");
  return reason;
}

/**
 * May this grant summarise a meeting now? Counts the call before anything is
 * spent. `paying` says which cap applied, so the caller can show it.
 */
export const startMeetingSummary = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.union(v.string(), v.null()) },
  returns: v.union(
    v.null(),
    v.object({ allowed: v.literal(true), remaining: v.number(), paying: v.boolean() }),
    v.object({ allowed: v.literal(false), reason: refusalValidator, paying: v.boolean() }),
  ),
  handler: async (ctx, args) => {
    const turn = await resolveTurn(ctx, args.hashedAccessToken, args.expectedWorkspaceId);
    if (turn === null) return null;
    const verdict = await countTurn(ctx, MEETING_FEATURE, turn.workspaceId, Date.now());
    const paying = await isPaying(ctx, turn.workspaceId);
    if (!verdict.allowed) return { allowed: false as const, reason: meetingRefusal(verdict.reason), paying };
    return { allowed: true as const, remaining: verdict.remaining, paying };
  },
});

/**
 * What a finished summary spent, priced from the model's own counts. A missing
 * model is Haiku, the model the gateway calls. Best effort: the call was
 * already counted against the cap.
 */
export const recordMeetingSummaryUsage = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.union(v.string(), v.null()),
    inputTokens: v.number(),
    outputTokens: v.number(),
    /** Prompt tokens read from the provider's cache, priced at its cache-read rate. */
    cacheReadTokens: v.optional(v.number()),
    /** Prompt tokens written to the provider's cache, priced at its cache-write rate. */
    cacheWriteTokens: v.optional(v.number()),
    /** The model that answered. Absent: Haiku. Malformed: priced as Haiku, with no model row. */
    model: v.optional(v.string()),
    failed: v.boolean(),
    ms: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const turn = await resolveTurn(ctx, args.hashedAccessToken, args.expectedWorkspaceId);
    if (turn === null) return false;
    await recordTurn(ctx, MEETING_FEATURE, turn.workspaceId, args, HAIKU_MODEL, Date.now());
    return true;
  },
});
