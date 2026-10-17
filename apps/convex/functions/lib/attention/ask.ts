/**
 * An agent asks for the person's attention
 * (`docs/decisions/texting-assistant/attention.md`).
 *
 * Asking texts nothing here. It counts the ping against the day, works out
 * when it may go, and makes the person's check-in row due then; the texting
 * Worker's minute cron hands it out through `claimDueHeartbeatsHandler` with
 * the check-in client's own short grant, and the gateway texts what is waiting
 * in `tex/attention/`. So the path to their phone is the check-in's, and so
 * are its re-checks: still linked, not paused, still their workspace.
 *
 * Who may ask: the owner of the personal workspace, through a live grant that
 * clears `gatewayOwnerClearance` there, for themselves only. Never another
 * person (nobody is named; the phones are the grant's person's own), never a
 * shared workspace, and never Tex's check-in client, which delivers pings and
 * must not be able to make more. Every accepted ask is audited as
 * `attention.requested` with the acting client.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { gatewayOwnerClearance, resolveGrantByAccessTokenHandler } from "../controlPlane/session";
import { phoneSignInPaused } from "../emailProof";
import { accountTimeZone } from "../routines/access";
import { effectiveTimeZone } from "../routines/model";
import { personalWorkspaceOf } from "../../textLinks";
import { HEARTBEAT_CLIENT_ID, armHeartbeat } from "../heartbeats/model";
import { DAILY_EMERGENCIES, DAILY_PINGS, localDay, pingDueAt, type AttentionUrgency } from "./model";

/**
 * What the agent is told, as a code. `soon`: it goes within a minute or two.
 * `later`: it waits until `dueAt` (night, or spaced after the last one).
 * `limit`: the day's pings of this kind are used up. `held`: the gateway held
 * it by the person's own settings, so nothing was counted or armed; asked
 * anyway, so a caller who may not ask writes no log. `not_texting`: no linked
 * phone, or texting paused. `timeZone` dates the gateway's log entry.
 */
export type AttentionAnswer =
  | { status: "soon" | "later"; dueAt: number; timeZone: string }
  | { status: "limit" | "held"; timeZone: string }
  | { status: "not_texting" };

/** A due time this close to now is "soon": the minute cron picks it up. */
const SOON_MS = 2 * 60 * 1000;

function counts(row: Doc<"texHeartbeats">, day: string) {
  if (row.attentionDay !== day) return { pings: 0, emergencies: 0 };
  return { pings: row.attentionCount ?? 0, emergencies: row.emergencyCount ?? 0 };
}

/**
 * Ask for the person's attention. `null` for every caller who may not ask at
 * all (an unknown or dead token, not the owner, not their personal
 * workspace, the check-in client): one answer, so nothing about the
 * workspace is learned from which.
 */
export async function requestAttentionHandler(
  ctx: MutationCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string; urgency: AttentionUrgency; deliver: boolean },
): Promise<AttentionAnswer | null> {
  const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken: args.hashedAccessToken });
  if (session === null || session.clientId === HEARTBEAT_CLIENT_ID) return null;
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
  const timeZone = effectiveTimeZone(undefined, await accountTimeZone(ctx, userId));
  if (!args.deliver) {
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: userId,
      actorClientId: session.clientId,
      action: "attention.held",
      details: { urgency: args.urgency },
    });
    return { status: "held", timeZone };
  }
  const byUser = () =>
    ctx.db
      .query("texHeartbeats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
  // The row pings ride on. One that exists keeps its check-in exactly as it was.
  if ((await byUser()) === null) await armHeartbeat(ctx, { userId, workspaceId, timeZone, now });
  const row = await byUser();
  if (row === null) return { status: "not_texting" };

  const day = localDay(now, timeZone);
  const used = counts(row, day);
  const emergency = args.urgency === "emergency";
  if (emergency ? used.emergencies >= DAILY_EMERGENCIES : used.pings >= DAILY_PINGS) {
    return { status: "limit", timeZone };
  }

  const dueAt = pingDueAt(args.urgency, now, timeZone, row.attentionTextedAt);
  const waiting = typeof row.attentionDueAt === "number" ? row.attentionDueAt : null;
  await ctx.db.patch(row._id, {
    attentionDueAt: waiting === null ? dueAt : Math.min(waiting, dueAt),
    attentionDay: day,
    attentionCount: used.pings + (emergency ? 0 : 1),
    emergencyCount: used.emergencies + (emergency ? 1 : 0),
    attentionTries: 0,
    updatedAt: now,
  });
  await recordAudit(ctx, {
    workspaceId,
    actorUserId: userId,
    actorClientId: session.clientId,
    action: "attention.requested",
    details: { urgency: args.urgency },
  });
  return { status: dueAt - now <= SOON_MS ? "soon" : "later", dueAt, timeZone };
}
