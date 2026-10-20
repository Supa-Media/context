/**
 * Tex's check-in, the control plane's half: when the next one is due, and
 * arming it (`docs/decisions/texting-assistant/heartbeat.md`).
 *
 * Asked for by the owner (Dev2), 2026-10-17, after another assistant read
 * their workspace between messages, found an image they had asked Tex for and
 * sent it unprompted: "I don't think Tex does something like this where it is
 * periodically checking the workspace, a heartbeat of sorts". A few times a
 * day Tex looks at what changed in the person's own workspace since it last
 * looked, and texts them only when it found something worth their attention.
 *
 * This file holds only when. The look itself runs on the gateway, as the
 * person, through the same dispatcher and privacy engine as any of their
 * texts, and what it saw and decided is written to `tex/heartbeat/` in their
 * own bucket.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { nextRunFor } from "../routines/model";

/** The check-in's first-party client. The gateway decides by it (`apps/mcp/src/agent/heartbeat.js`). */
export const HEARTBEAT_CLIENT_ID = "context_heartbeat";
/** What the note's history and Connected apps call it. */
export const HEARTBEAT_CLIENT_NAME = "Tex, checking in";

/**
 * When in their day it looks, in their own time zone: waking hours only, and
 * no more than three times. A text from a check-in is a text they did not ask
 * for, so it never arrives at night. A check-in that texted goes on to the
 * next slot like any other; new mail can bring a look forward (`mail.ts`),
 * and a person hears from check-ins at most `MAX_CHECK_IN_TEXTS_A_DAY` times
 * a day (the owner, 2026-10-19: "let's do 3 text a day and if we need to
 * reduce it we can"). Decided here, not by the model.
 */
export const BEAT_TIMES = [
  { hour: 10, minute: 0 },
  { hour: 14, minute: 0 },
  { hour: 18, minute: 0 },
] as const;

/** How long a handed-out check-in holds its row, and how long its grant lives. */
export const HEARTBEAT_LEASE_MS = 15 * 60 * 1000;
export const HEARTBEAT_GRANT_TTL_MS = HEARTBEAT_LEASE_MS;

/** Most check-ins one `/agent-texts/heartbeats/due` call hands out. */
export const MAX_DUE_HEARTBEATS = 10;

/**
 * What a check-in may report: a code, never a sentence. `texted` found
 * something and reached their phone; `quiet` looked and found nothing worth a
 * text; `nothing_new` had nothing changed to look at and ran no model;
 * `paused` was switched off in `tex/heartbeat.md`; `no_chat` had something to
 * say and no chat to say it in; `busy` found them mid-conversation with Tex
 * and looks again once the chat has been quiet (`QUIET_WAIT_MS`).
 */
export const HEARTBEAT_OUTCOMES = [
  "texted",
  "quiet",
  "nothing_new",
  "paused",
  "no_chat",
  "failed",
  "daily_limit",
  "no_provider",
  "busy",
] as const;

/**
 * How long a check-in that found them mid-conversation waits before it looks
 * again: a check-in never lands in the middle of a chat (Tex's runtime
 * redesign, decided by the owner, 2026-10-19: "check-ins wait 10 quiet minutes").
 */
export const QUIET_WAIT_MS = 10 * 60 * 1000;
export type HeartbeatOutcome = (typeof HEARTBEAT_OUTCOMES)[number];

export function isHeartbeatOutcome(value: unknown): value is HeartbeatOutcome {
  return typeof value === "string" && (HEARTBEAT_OUTCOMES as readonly string[]).includes(value);
}

/** Outcomes after which what changed so far counts as seen: the next look reads only what came after. */
export const LOOKED_OUTCOMES: ReadonlySet<string> = new Set(["texted", "quiet", "nothing_new", "paused"]);

/**
 * Outcomes that stop the check-ins until their next text: no model here (not
 * Premium), or no chat to text into. Anything else carries on at the next slot.
 */
export const WAIT_FOR_TEXT_OUTCOMES: ReadonlySet<string> = new Set(["no_provider", "no_chat"]);

/** The next check-in slot in `timeZone` after `afterMs`. */
export function nextBeatAfter(timeZone: string, afterMs: number): number | null {
  let soonest: number | null = null;
  for (const at of BEAT_TIMES) {
    const next = nextRunFor({ cadence: { unit: "day", every: 1 }, at, paused: false }, timeZone, afterMs);
    if (next !== null && (soonest === null || next < soonest)) soonest = next;
  }
  return soonest;
}

/**
 * Make sure this person has a check-in coming: creates the row the first
 * time, and sets the next slot when none is set (a check-in that stopped for
 * want of a model or a chat starts again with their next text). A row already
 * waiting on a slot keeps it, so texting Tex never brings one forward.
 */
export async function armHeartbeat(
  ctx: MutationCtx,
  args: { userId: Id<"users">; workspaceId: Id<"workspaces">; timeZone: string; now: number },
): Promise<void> {
  const row = await ctx.db
    .query("texHeartbeats")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .first();
  const next = nextBeatAfter(args.timeZone, args.now);
  if (row === null) {
    await ctx.db.insert("texHeartbeats", {
      userId: args.userId,
      workspaceId: args.workspaceId,
      nextBeatAt: next,
      updatedAt: args.now,
    });
    return;
  }
  await ctx.db.patch(row._id, {
    workspaceId: args.workspaceId,
    ...(row.nextBeatAt === null ? { nextBeatAt: next } : {}),
    updatedAt: args.now,
  });
}
