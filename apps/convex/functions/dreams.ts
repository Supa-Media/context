/**
 * Tex's nightly dream (`docs/decisions/texting-assistant/dreams.md`).
 *
 * Registrations only; the logic is in `lib/dreams/`. The control plane keeps
 * when each person's dream is due and how the last one ended, never what it
 * read, thought or changed.
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { armLinkedDreamsHandler, claimDueDreamsHandler, recordDreamResultHandler } from "./lib/dreams/runs";
import { requestDreamNowHandler } from "./lib/dreams/now";

export const claimDueDreams = internalMutation({
  args: {
    runIds: v.array(v.string()),
    tokens: v.array(v.object({ hashedAccessToken: v.string(), hashedRefreshToken: v.string() })),
  },
  returns: v.array(
    v.object({ runId: v.string(), token: v.number(), timeZone: v.string(), since: v.union(v.number(), v.null()) }),
  ),
  handler: claimDueDreamsHandler,
});

export const recordDreamResult = internalMutation({
  args: { runId: v.string(), outcome: v.string() },
  returns: v.union(v.literal("recorded"), v.literal("unknown")),
  handler: recordDreamResultHandler,
});

/** Daily (`crons.ts`): a first dream for everyone with a linked phone who has none. */
export const armLinkedDreams = internalMutation({
  args: {},
  returns: v.number(),
  handler: armLinkedDreamsHandler,
});

/** The person's own agent asks for a dream now (`lib/dreams/now.ts`); the minute cron runs it. */
export const requestDreamNow = internalMutation({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ status: v.literal("started") }),
    v.object({ status: v.literal("running") }),
    v.object({ status: v.literal("recent"), retryAt: v.number() }),
    v.object({ status: v.literal("not_included") }),
    v.object({ status: v.literal("daily_limit") }),
    v.object({ status: v.literal("unavailable") }),
    v.object({ status: v.literal("not_texting") }),
  ),
  handler: requestDreamNowHandler,
});
