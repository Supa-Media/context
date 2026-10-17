/**
 * A dream now, asked for by the person's own agent
 * (`docs/decisions/texting-assistant/dreams.md`, "A first dream right away").
 *
 * Decided by the owner (Dev2), 2026-10-17: in Tex's onboarding, once Tex has
 * read a new person's recent email it runs their first dream straight away
 * and writes a first `tex/about-me.md`, then confirms it with them, instead of
 * waiting for 3 am.
 *
 * Asking does not run anything here. It makes the person's dream row due now,
 * and the texting Worker's minute cron hands it out through
 * `claimDueDreamsHandler` exactly like a nightly one: the same re-checks, the
 * dreams client's own short grant, the same `dream.run` audit, the same note.
 * So everything a nightly dream may and may not touch holds unchanged.
 *
 * Who may ask, and how often:
 *
 *  - the owner of the personal workspace, through a live grant that clears
 *    `gatewayOwnerClearance` there (owner, write, private) — never for a shared
 *    workspace, and never the dreams client itself, so a dream cannot start
 *    the next one;
 *  - only someone Tex dreams for at all: a linked phone that is not paused;
 *  - only when the built-in model would run it now: the Jev gate a dream's
 *    turn passes (Premium, the switches, the daily cap), asked without
 *    counting, since the dream counts itself when it runs;
 *  - never while one is due or running, and at most once per
 *    `DREAM_NOW_WINDOW_MS` of asking.
 *
 * Every accepted ask is audited as `dream.requested` with the acting client.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { gatewayOwnerClearance, resolveGrantByAccessTokenHandler } from "../controlPlane/session";
import { phoneSignInPaused } from "../emailProof";
import { gate } from "../jev/meter";
import { personalWorkspaceOf } from "../../textLinks";
import { DREAMS_CLIENT_ID, DREAM_LEASE_MS } from "./model";

/** How long after one ask the next is refused. One a morning is plenty; a night's dream still runs. */
export const DREAM_NOW_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The meter's feature a dream's turn is gated and counted on (`functions/builtinModel.ts`). */
const DREAM_FEATURE = "assistant" as const;

/**
 * What the agent is told, as a code. `started`: it will run within a minute or
 * two. `running`: one is due or under way. `recent`: asked within the window,
 * try again at `retryAt`. `not_included`, `daily_limit`, `unavailable` (the
 * built-in model is switched off): the gate's answer. `not_texting`: no linked
 * phone, or texting paused.
 */
export type DreamNowAnswer =
  | { status: "started" }
  | { status: "running" }
  | { status: "recent"; retryAt: number }
  | { status: "not_included" }
  | { status: "daily_limit" }
  | { status: "unavailable" }
  | { status: "not_texting" };

const GATE_ANSWERS = {
  not_premium: "not_included",
  daily_cap: "daily_limit",
  disabled: "unavailable",
  switched_off: "unavailable",
} as const;

function underWay(row: Doc<"texDreams">, now: number): boolean {
  if (row.claimedAt !== undefined && row.claimedAt + DREAM_LEASE_MS > now) return true;
  return row.nextDreamAt !== null && row.nextDreamAt <= now;
}

/**
 * Ask for a dream now. `null` for every caller who may not ask at all (an
 * unknown or dead token, not the owner, not their personal workspace, the
 * dreams client): one answer, so nothing about the workspace is learned from
 * which.
 */
export async function requestDreamNowHandler(
  ctx: MutationCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string },
): Promise<DreamNowAnswer | null> {
  const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken: args.hashedAccessToken });
  if (session === null || session.clientId === DREAMS_CLIENT_ID) return null;
  const workspaceId = gatewayOwnerClearance(session, args.expectedWorkspaceId);
  if (workspaceId === null) return null;
  const userId = session.actorUserId as Id<"users">;
  if ((await personalWorkspaceOf(ctx, userId)) !== workspaceId) return null;

  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (link === null || (await phoneSignInPaused(ctx, userId))) return { status: "not_texting" };

  const now = Date.now();
  const verdict = await gate(ctx, DREAM_FEATURE, workspaceId, now);
  if (!verdict.allowed) return { status: GATE_ANSWERS[verdict.reason] };

  const row = await ctx.db
    .query("texDreams")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (row !== null && underWay(row, now)) return { status: "running" };
  if (row?.askedAt !== undefined && row.askedAt + DREAM_NOW_WINDOW_MS > now) {
    return { status: "recent", retryAt: row.askedAt + DREAM_NOW_WINDOW_MS };
  }

  if (row === null) {
    await ctx.db.insert("texDreams", { userId, workspaceId, nextDreamAt: now, askedAt: now, updatedAt: now });
  } else {
    await ctx.db.patch(row._id, { workspaceId, nextDreamAt: now, askedAt: now, updatedAt: now });
  }
  await recordAudit(ctx, {
    workspaceId,
    actorUserId: userId,
    actorClientId: session.clientId,
    action: "dream.requested",
    details: {},
  });
  return { status: "started" };
}
