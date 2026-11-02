/**
 * Handing due check-ins to the texting Worker, and hearing how they went
 * (`docs/decisions/texting-assistant/heartbeat.md`).
 *
 * Whether the phone is still linked, not paused, and the person still owns
 * the personal workspace is asked again at every claim (`texJobWorkspace`).
 * The grant is the check-in client's own, never the texting grant. The phones
 * a check-in may text are the person's own linked phones and nobody else's.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { SCOPE_PRIVATE, SCOPE_READ, SCOPE_WRITE, clampScopes, hasOperationScope } from "../consentScopes";
import { applyTexJobGrant, endTexJobGrant, ensureTexJobClient, texJobWorkspace, type MintedToken } from "../texJobs";
import { personalWorkspaceOf } from "../../textLinks";
import { accountTimeZone } from "../routines/access";
import { effectiveTimeZone } from "../routines/model";
import {
  HEARTBEAT_CLIENT_ID,
  HEARTBEAT_CLIENT_NAME,
  HEARTBEAT_GRANT_TTL_MS,
  HEARTBEAT_LEASE_MS,
  LOOKED_OUTCOMES,
  MAX_DUE_HEARTBEATS,
  QUIET_WAIT_MS,
  WAIT_FOR_TEXT_OUTCOMES,
  armHeartbeat,
  isHeartbeatOutcome,
  nextBeatAfter,
} from "./model";
import { MAX_DELIVERY_TRIES, RETRY_AFTER_MS, localDay } from "../attention/model";
import { MAX_CHECK_IN_TEXTS_A_DAY, firstBeatTomorrow, textsOn } from "./mail";
import { liveNotices } from "../mailHealth/model";

/** Retries a failed look gets before its slot comes round, each `RETRY_AFTER_MS` after the last. */
export const MAX_LOOK_RETRIES = 3;

/** Write is for the gateway's own log of the look (`tex/heartbeat/`); the model is read-only there. */
const HEARTBEAT_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE];

/**
 * One claimed check-in. `token` indexes the calling action's plaintext list.
 * `since` is null for a first one. `attention` is a claim for the person's
 * waiting attention pings (`lib/attention/`) instead of a look: the gateway
 * texts what waits in `tex/attention/` and runs no model.
 */
export type ClaimedHeartbeat = {
  runId: string;
  token: number;
  timeZone: string;
  since: number | null;
  phones: string[];
  attention: boolean;
};

function attentionIsDue(row: Doc<"texHeartbeats">, now: number): boolean {
  return typeof row.attentionDueAt === "number" && row.attentionDueAt <= now;
}

function leaseIsLive(row: Doc<"texHeartbeats">, now: number): boolean {
  return row.claimedAt !== undefined && row.claimedAt + HEARTBEAT_LEASE_MS > now;
}

async function zoneOf(ctx: MutationCtx, userId: Id<"users">): Promise<string> {
  return effectiveTimeZone(undefined, await accountTimeZone(ctx, userId));
}

/** The person's own linked phones. Never anyone else's: a check-in texts only the person it looked for. */
async function ownPhones(ctx: MutationCtx, userId: Id<"users">): Promise<string[]> {
  const links = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(10);
  return [...new Set(links.map((link) => link.phone))];
}

/**
 * Claim up to `tokens.length` due check-ins and mint each a grant.
 *
 * A row is due when `nextBeatAt <= now` and no live lease holds it. Claiming
 * moves `nextBeatAt` on to the next slot straight away, so a check-in whose
 * result never comes back is simply followed by the next one; the result, when
 * it comes, may push it further (after a text, to tomorrow).
 *
 * A row whose attention pings are due is handed out for those first, and its
 * check-in, if also due, waits for the next tick: the pings are what an agent
 * asked for, and they never move the check-in's slot.
 */
export async function claimDueHeartbeatsHandler(
  ctx: MutationCtx,
  args: { runIds: string[]; tokens: MintedToken[] },
): Promise<ClaimedHeartbeat[]> {
  const now = Date.now();
  const limit = Math.min(MAX_DUE_HEARTBEATS, args.tokens.length, args.runIds.length);
  if (limit === 0) return [];
  const candidates = await ctx.db
    .query("texHeartbeats")
    .withIndex("by_nextBeatAt", (q) => q.gte("nextBeatAt", 0).lte("nextBeatAt", now))
    .take(limit * 5);
  const pinged = await ctx.db
    .query("texHeartbeats")
    .withIndex("by_attentionDueAt", (q) => q.gte("attentionDueAt", 0).lte("attentionDueAt", now))
    .take(limit * 5);
  const seen = new Set(pinged.map((row) => row._id));
  const rows = [...pinged, ...candidates.filter((row) => !seen.has(row._id))];

  const beats: ClaimedHeartbeat[] = [];
  let clientEnsured = false;
  for (const row of rows) {
    if (beats.length >= limit) break;
    if (leaseIsLive(row, now)) continue;
    const workspaceId = await texJobWorkspace(ctx, row.userId, row.workspaceId);
    if (workspaceId === null) {
      // Unlinked, paused or gone: no check-in until a text arms one again, and no waiting ping is ever sent.
      await ctx.db.patch(row._id, { nextBeatAt: null, attentionDueAt: null, updatedAt: now });
      continue;
    }
    const phones = await ownPhones(ctx, row.userId);
    const scopes = clampScopes(HEARTBEAT_SCOPES, "owner");
    if (phones.length === 0 || !hasOperationScope(scopes)) continue;
    if (!clientEnsured) {
      await ensureTexJobClient(ctx, HEARTBEAT_CLIENT_ID, HEARTBEAT_CLIENT_NAME);
      clientEnsured = true;
    }
    const token = beats.length;
    await applyTexJobGrant(ctx, {
      clientId: HEARTBEAT_CLIENT_ID,
      userId: row.userId,
      workspaceId,
      scopes,
      token: args.tokens[token]!,
      expiresAt: now + HEARTBEAT_GRANT_TTL_MS,
      now,
    });
    const runId = args.runIds[token]!;
    const timeZone = await zoneOf(ctx, row.userId);
    const attention = attentionIsDue(row, now);
    await ctx.db.patch(
      row._id,
      attention
        ? { claimedAt: now, runId, runKind: "attention", attentionDueAt: null, updatedAt: now }
        : { claimedAt: now, runId, runKind: undefined, nextBeatAt: nextBeatAfter(timeZone, now), mailRaising: undefined, updatedAt: now },
    );
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: row.userId,
      actorClientId: HEARTBEAT_CLIENT_ID,
      action: attention ? "attention.run" : "heartbeat.run",
      details: {},
    });
    beats.push({ runId, token, timeZone, since: row.lastBeatAt ?? null, phones, attention });
  }
  return beats;
}

/**
 * How a check-in went: a code from the closed list, and nothing else.
 * Releases the lease and ends the grant. One that texted waits until
 * tomorrow; one with no model or no chat waits for their next text; anything
 * else goes on at the next slot. An unknown run id or code changes nothing.
 */
export async function recordHeartbeatResultHandler(
  ctx: MutationCtx,
  args: { runId: string; outcome: string },
): Promise<"recorded" | "unknown"> {
  if (!isHeartbeatOutcome(args.outcome)) return "unknown";
  const row = await ctx.db
    .query("texHeartbeats")
    .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
    .unique();
  if (row === null) return "unknown";
  const now = Date.now();
  if (row.runKind === "attention") {
    await recordAttentionResult(ctx, row, args.outcome, now);
    return "recorded";
  }
  const zone = await zoneOf(ctx, row.userId);
  const texted = args.outcome === "texted";
  const today = localDay(now, zone);
  const textedToday = textsOn(row, today) + (texted ? 1 : 0);
  // Today's texts used up: nothing more until tomorrow's first slot, mail included (`mail.ts`).
  const nextBeatAt = WAIT_FOR_TEXT_OUTCOMES.has(args.outcome)
    ? null
    : texted && textedToday >= MAX_CHECK_IN_TEXTS_A_DAY
      ? (firstBeatTomorrow(zone, now) ?? nextBeatAfter(zone, now))
      : (row.nextBeatAt ?? nextBeatAfter(zone, now));
  // A look that failed (the tree slow or not serving, the gateway unreachable) is tried again soon, a few
  // times in each slot, rather than at the next slot hours later; the next slot counts afresh, so failures
  // that run on from one slot into the next still get their retries (2026-10-28: they had stopped for good).
  // One that found them mid-conversation looks again once the chat has gone quiet, however often that takes.
  const failed = args.outcome === "failed";
  const failedLooks = failed ? (row.failedFor === nextBeatAt ? (row.failedLooks ?? 0) : 0) + 1 : undefined;
  const retry = failed && nextBeatAt !== null && failedLooks! <= MAX_LOOK_RETRIES
    ? Math.min(nextBeatAt, now + RETRY_AFTER_MS)
    : args.outcome === "busy" && nextBeatAt !== null
      ? Math.min(nextBeatAt, now + QUIET_WAIT_MS)
      : nextBeatAt;
  await ctx.db.patch(row._id, {
    lastOutcome: args.outcome,
    failedLooks,
    failedFor: failed && nextBeatAt !== null ? nextBeatAt : undefined,
    claimedAt: undefined,
    runId: undefined,
    // From when it started: anything changed during it is looked at by the next one.
    ...(LOOKED_OUTCOMES.has(args.outcome) ? { lastBeatAt: row.claimedAt ?? now } : {}),
    ...(texted ? { lastTextedAt: now, textedDay: today, textedCount: textedToday } : {}),
    // What it raised about their mailboxes counts as told only once it reached them (`lib/mailHealth/`).
    ...(texted && (row.mailRaising?.length ?? 0) > 0
      ? { mailNotices: [...liveNotices(row.mailNotices, now), ...row.mailRaising!.map((raised) => ({ ...raised, at: now }))] }
      : {}),
    mailRaising: undefined,
    nextBeatAt: retry,
    updatedAt: now,
  });
  await endTexJobGrant(ctx, { clientId: HEARTBEAT_CLIENT_ID, userId: row.userId, workspaceId: row.workspaceId, now });
  return "recorded";
}

/**
 * How a delivery of attention pings went. The check-in's slot, its last
 * outcome and what it has seen are left alone. A ping asked for while this
 * one was out keeps its own due time. A failed delivery is tried again a few
 * times; the gateway marks what it texted in `tex/attention/`, so a retry
 * never sends a ping twice.
 */
async function recordAttentionResult(ctx: MutationCtx, row: Doc<"texHeartbeats">, outcome: string, now: number) {
  const waiting = typeof row.attentionDueAt === "number" ? row.attentionDueAt : null;
  const tries = (row.attentionTries ?? 0) + 1;
  const retry = outcome === "failed" && tries < MAX_DELIVERY_TRIES;
  const retryAt = now + RETRY_AFTER_MS;
  await ctx.db.patch(row._id, {
    claimedAt: undefined,
    runId: undefined,
    runKind: undefined,
    attentionDueAt: retry ? Math.min(waiting ?? retryAt, retryAt) : waiting,
    attentionTries: outcome === "failed" ? tries : 0,
    ...(outcome === "texted" ? { attentionTextedAt: now } : {}),
    updatedAt: now,
  });
  await endTexJobGrant(ctx, { clientId: HEARTBEAT_CLIENT_ID, userId: row.userId, workspaceId: row.workspaceId, now });
}

/**
 * Daily, for everyone who has linked a phone: a row and a first check-in for
 * anyone who has none yet, so nobody waits on their next text to get one.
 * Anyone with a row is left to its schedule and their texts.
 */
export async function armLinkedHeartbeatsHandler(ctx: MutationCtx): Promise<number> {
  const now = Date.now();
  let armed = 0;
  for (const link of await ctx.db.query("phoneLinks").take(2000)) {
    const row = await ctx.db
      .query("texHeartbeats")
      .withIndex("by_user", (q) => q.eq("userId", link.userId))
      .first();
    if (row !== null) continue;
    const workspaceId = await personalWorkspaceOf(ctx, link.userId);
    if (workspaceId === null) continue;
    await armHeartbeat(ctx, { userId: link.userId, workspaceId, timeZone: await zoneOf(ctx, link.userId), now });
    armed += 1;
  }
  return armed;
}
