/**
 * Tex's nightly dream, the control plane's half: when one is due, and arming
 * it (`docs/decisions/texting-assistant/dreams.md`).
 *
 * Decided by the owner (Dev2), 2026-10-15: a nightly job, for everyone who
 * texts Tex, that updates `tex/about.md` from the day's conversations and
 * logs exactly what it changed in `tex/dreams/`. This file holds only when:
 * the dream itself runs on the gateway, as the person, through the same
 * dispatcher and privacy engine as any of their texts.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { nextRunFor } from "../routines/model";

/** The dream runner's first-party client. The gateway decides by it (`apps/mcp/src/agent/dream.js`). */
export const DREAMS_CLIENT_ID = "context_dreams";
/** What the note's history and Connected apps call it. */
export const DREAMS_CLIENT_NAME = "Tex, dreaming";

/** When in their night it runs, in their own time zone. */
export const DREAM_AT = { hour: 3, minute: 0 } as const;

/** How long a handed-out dream holds its row, and how long its grant lives. Same reasoning as routines. */
export const DREAM_LEASE_MS = 15 * 60 * 1000;
export const DREAM_GRANT_TTL_MS = DREAM_LEASE_MS;

/** Most dreams one `/agent-texts/dreams/due` call hands out. */
export const MAX_DUE_DREAMS = 10;

/**
 * What a dream may report: a code, never a sentence. `dreamed` changed the
 * note, `unchanged` read the day and found nothing to keep, `nothing_new` had
 * no texts to read.
 */
export const DREAM_OUTCOMES = [
  "dreamed",
  "unchanged",
  "nothing_new",
  "failed",
  "daily_limit",
  "no_provider",
] as const;
export type DreamOutcome = (typeof DREAM_OUTCOMES)[number];

export function isDreamOutcome(value: unknown): value is DreamOutcome {
  return typeof value === "string" && (DREAM_OUTCOMES as readonly string[]).includes(value);
}

/** Outcomes tried again the next night. Any other that did not dream (no model here) waits for a text. */
export const RETRIED_OUTCOMES: ReadonlySet<string> = new Set(["failed", "daily_limit"]);

/** Outcomes after which the day counts as dreamed: the next dream reads only what came after it. */
export const DREAMED_OUTCOMES: ReadonlySet<string> = new Set(["dreamed", "unchanged", "nothing_new"]);

/** The next 3:00 am in `timeZone` after `afterMs`. */
export function nextDreamAfter(timeZone: string, afterMs: number): number | null {
  return nextRunFor({ cadence: { unit: "day", every: 1 }, at: DREAM_AT, paused: false }, timeZone, afterMs);
}

/**
 * Tex answered a text for this person: tonight is worth a dream. Creates the
 * row the first time, and sets the next dream when none is set. A row already
 * waiting on tonight's dream keeps its time.
 */
export async function armDream(
  ctx: MutationCtx,
  args: { userId: Id<"users">; workspaceId: Id<"workspaces">; timeZone: string; now: number; texted: boolean },
): Promise<void> {
  const row = await ctx.db
    .query("texDreams")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .first();
  const next = nextDreamAfter(args.timeZone, args.now);
  const texted = args.texted ? { lastTextedAt: args.now } : {};
  if (row === null) {
    await ctx.db.insert("texDreams", {
      userId: args.userId,
      workspaceId: args.workspaceId,
      nextDreamAt: next,
      ...texted,
      updatedAt: args.now,
    });
    return;
  }
  // Only a text makes tonight worth a dream for someone who already has a row.
  await ctx.db.patch(row._id, {
    workspaceId: args.workspaceId,
    ...texted,
    ...(row.nextDreamAt === null && args.texted ? { nextDreamAt: next } : {}),
    updatedAt: args.now,
  });
}
