/**
 * Tex's housekeeping, the control plane's half: when the next run is due, and
 * arming it (`docs/decisions/texting-assistant/housekeeping.md`).
 *
 * Asked for by the owner (Dev2), 2026-10-17: "a proactive and consistent …
 * probably in the same proactive loop as a workspace heartbeat … fiercely
 * organizing things, updating project statuses, archiving, getting the chaos
 * score lower." Once a day Tex tidies the person's personal workspace, and
 * logs each change in `tex/housekeeping/` with how to put it back.
 *
 * This file holds only when. The run itself is on the gateway, as the person,
 * through the same dispatcher and privacy engine as any of their texts, held
 * to what `housekeepingGuard.js` allows.
 */

import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { nextRunFor } from "../routines/model";

/** Housekeeping's first-party client. The gateway decides by it (`apps/mcp/src/agent/housekeeping.js`). */
export const HOUSEKEEPING_CLIENT_ID = "context_housekeeping";
/** What the note's history and Connected apps call it. */
export const HOUSEKEEPING_CLIENT_NAME = "Tex, keeping house";

/** Once a day, at the first look after 9am in their own time zone: after the night's dream, before their day fills up. */
export const HOUSEKEEPING_AT = { hour: 9, minute: 0 } as const;

/** How long a handed-out run holds its row, and how long its grant lives. */
export const HOUSEKEEPING_LEASE_MS = 15 * 60 * 1000;
export const HOUSEKEEPING_GRANT_TTL_MS = HOUSEKEEPING_LEASE_MS;

/** Most runs one `/agent-texts/housekeeping/due` call hands out. */
export const MAX_DUE_HOUSEKEEPING = 10;

/**
 * What a run may report: a code, never a sentence. `tidied` changed
 * something; `unchanged` looked and found nothing to do.
 */
export const HOUSEKEEPING_OUTCOMES = ["tidied", "unchanged", "failed", "daily_limit", "no_provider"] as const;
export type HousekeepingOutcome = (typeof HOUSEKEEPING_OUTCOMES)[number];

export function isHousekeepingOutcome(value: unknown): value is HousekeepingOutcome {
  return typeof value === "string" && (HOUSEKEEPING_OUTCOMES as readonly string[]).includes(value);
}

/** The next run in `timeZone` after `afterMs`. */
export function nextHousekeepingAfter(timeZone: string, afterMs: number): number | null {
  return nextRunFor({ cadence: { unit: "day", every: 1 }, at: HOUSEKEEPING_AT, paused: false }, timeZone, afterMs);
}

/**
 * Make sure this person has a run coming: creates the row the first time,
 * and sets the next run when none is set (one that stopped for want of a
 * model starts again with their next text). A row already waiting keeps its
 * time, so texting Tex never brings one forward.
 */
export async function armHousekeeping(
  ctx: MutationCtx,
  args: { userId: Id<"users">; workspaceId: Id<"workspaces">; timeZone: string; now: number },
): Promise<void> {
  const row = await ctx.db
    .query("texHousekeeping")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .first();
  const next = nextHousekeepingAfter(args.timeZone, args.now);
  if (row === null) {
    await ctx.db.insert("texHousekeeping", {
      userId: args.userId,
      workspaceId: args.workspaceId,
      nextRunAt: next,
      updatedAt: args.now,
    });
    return;
  }
  await ctx.db.patch(row._id, {
    workspaceId: args.workspaceId,
    ...(row.nextRunAt === null ? { nextRunAt: next } : {}),
    updatedAt: args.now,
  });
}
