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
