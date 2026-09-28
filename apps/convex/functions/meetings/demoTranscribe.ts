/**
 * Transcription for the homepage's demo meeting: somebody who has not signed
 * in presses New meeting on context.lc and hears their own words come back.
 *
 * ## Why an unauthenticated door exists at all
 *
 * `transcribeChunk` refuses anybody without an account, and says why: an
 * anonymous caller must not spend somebody else's allowance. The owner asked
 * for visitors to be able to *try* a meeting on the homepage (2026-09-28), and
 * a meeting with no words in it is not trying one. So this is a second door,
 * and it is narrow on purpose. The first door is untouched.
 *
 * ## What bounds it, and each bound is enforced here rather than trusted
 *
 *  - **Length.** A demo meeting is `DEMO_MEETING_MS` long. The app ends it
 *    there, and this action refuses a chunk that starts after it or is longer
 *    than a chunk ever is, so a client that ignores the app's clock still buys
 *    at most that much audio per meeting.
 *  - **Size.** `DEMO_MAX_AUDIO_CHARS` of base64 per chunk, well over a 20s
 *    chunk with call audio and far under what a paid inference call would
 *    take.
 *  - **Per visitor.** `visitorId` is a random id the tab mints once. It is not
 *    identity and cannot be — anybody can mint another — so it only stops one
 *    tab from recording forever by accident.
 *  - **Everyone together**, which is the bound that holds against somebody
 *    minting ids: `DEMO_CHUNKS_PER_MINUTE` a minute and `DEMO_CHUNKS_PER_DAY` a
 *    day across every visitor. At Whisper's price that caps the worst day at
 *    a few hundred minutes of audio. When it is spent the demo says so and the
 *    signed-in product is unaffected, because its budget is keyed per account.
 *
 * ## What it writes
 *
 * `rateLimits` rows and nothing else, exactly as `transcribeChunk`. The audio
 * exists in one request's memory; the words go back to the visitor's tab, where
 * the note lives in browser memory and is gone on reload.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../../_generated/api";
import { action, internalMutation } from "../../_generated/server";
import { tryConsumeRateLimit } from "../lib/rateLimit";
import { transcribeAtWorker, transcriptSegment, type TranscriptSegment } from "./transcribe";

/** How long one demo meeting may run. The app stops the recording here too. */
export const DEMO_MEETING_MS = 2 * 60_000;

/** The longest chunk accepted. Recorders rotate every 20s; this is slack. */
export const DEMO_MAX_CHUNK_MS = 30_000;

/** The most base64 one chunk may carry (~1.1 MB of audio). */
export const DEMO_MAX_AUDIO_CHARS = 1_500_000;

/** One tab's allowance: a couple of full demo meetings, then a pause. */
export const DEMO_CHUNKS_PER_VISITOR = 16;
export const DEMO_VISITOR_WINDOW_MS = 10 * 60_000;

/** Every visitor together. The bound that holds against minted ids. */
export const DEMO_CHUNKS_PER_MINUTE = 60;
export const DEMO_CHUNKS_PER_DAY = 3_000;

/** What a tab's id looks like: 32 hex characters from `crypto.getRandomValues`. */
const VISITOR_ID_PATTERN = /^[a-f0-9]{32}$/;

function demoRefused(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

/**
 * Spend one chunk from the visitor's allowance and from everyone's.
 *
 * Internal, like `consumeTranscribeBudget`, and for its reason: nothing but the
 * action below can call it, so the only key it ever builds is one this file
 * computed. The visitor is charged first and the shared budget only if the
 * visitor had room, so one tab spinning cannot drain everybody's minute.
 * `tryConsumeRateLimit` commits each spend in this one transaction, so a
 * refusal by the shared budget still charges the visitor, which is the
 * direction a limit on inference has to fail in.
 */
export const consumeDemoBudget = internalMutation({
  args: { visitorId: v.string() },
  returns: v.union(v.literal("ok"), v.literal("visitor"), v.literal("everyone")),
  handler: async (ctx, args): Promise<"ok" | "visitor" | "everyone"> => {
    const visitor = await tryConsumeRateLimit(ctx, {
      key: `meetings.demoTranscribe:visitor:${args.visitorId}`,
      limit: DEMO_CHUNKS_PER_VISITOR,
      windowMs: DEMO_VISITOR_WINDOW_MS,
    });
    if (!visitor) return "visitor";
    const minute = await tryConsumeRateLimit(ctx, {
      key: "meetings.demoTranscribe:everyone:minute",
      limit: DEMO_CHUNKS_PER_MINUTE,
      windowMs: 60_000,
    });
    if (!minute) return "everyone";
    const day = await tryConsumeRateLimit(ctx, {
      key: "meetings.demoTranscribe:everyone:day",
      limit: DEMO_CHUNKS_PER_DAY,
      windowMs: 24 * 60 * 60_000,
    });
    return day ? "ok" : "everyone";
  },
});

export const transcribeDemoChunk = action({
  args: {
    visitorId: v.string(),
    audioBase64: v.string(),
    mimeType: v.string(),
    chunkId: v.string(),
    offsetMs: v.number(),
    durationMs: v.number(),
  },
  returns: v.object({
    segments: v.array(transcriptSegment),
    refusedSegments: v.number(),
  }),
  handler: async (
    ctx,
    { visitorId, ...chunk },
  ): Promise<{ segments: TranscriptSegment[]; refusedSegments: number }> => {
    // Shape first: every check here is free, and none of them spends budget.
    if (!VISITOR_ID_PATTERN.test(visitorId)) {
      throw demoRefused("INVALID_ARGUMENT", "This demo recording has no visitor id.");
    }
    if (
      !Number.isFinite(chunk.offsetMs) ||
      !Number.isFinite(chunk.durationMs) ||
      chunk.offsetMs < 0 ||
      chunk.durationMs <= 0 ||
      chunk.durationMs > DEMO_MAX_CHUNK_MS ||
      chunk.offsetMs >= DEMO_MEETING_MS
    ) {
      throw demoRefused("DEMO_TOO_LONG", "A demo meeting stops at two minutes.");
    }
    if (chunk.audioBase64.length > DEMO_MAX_AUDIO_CHARS) {
      throw demoRefused("INVALID_ARGUMENT", "This piece of audio is too large for the demo.");
    }

    const budget = await ctx.runMutation(
      internal.functions.meetings.demoTranscribe.consumeDemoBudget,
      { visitorId },
    );
    if (budget !== "ok") {
      throw demoRefused(
        "RATE_LIMITED",
        budget === "visitor"
          ? "You have used this tab's demo recordings for now. Try again in a few minutes."
          : "The demo is busy right now. Try again in a little while, or sign in to record.",
      );
    }

    // A caller hash per visitor, so the Worker's own per-caller limit treats
    // each tab as a caller rather than every visitor as one.
    return await transcribeAtWorker(chunk, `demo:${visitorId}`);
  },
});
