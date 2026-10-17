/**
 * Handing due dreams to the texting Worker, and hearing how they went.
 *
 * Everything that could have changed since a row was armed is asked again at
 * the moment a dream is handed out: whether the phone is still linked and not
 * paused ("This wasn't me"), and whether the person still owns the personal
 * workspace it runs in. The grant is the dreams client's own, never the
 * texting grant, which the next text replaces.
 */

import type { Doc } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { SCOPE_PRIVATE, SCOPE_READ, SCOPE_WRITE, clampScopes, hasOperationScope } from "../consentScopes";
import { applyTexJobGrant, endTexJobGrant, ensureTexJobClient, texJobWorkspace, type MintedToken } from "../texJobs";
import { personalWorkspaceOf } from "../../textLinks";
import { accountTimeZone } from "../routines/access";
import { effectiveTimeZone } from "../routines/model";
import {
  DREAMED_OUTCOMES,
  DREAMS_CLIENT_ID,
  DREAMS_CLIENT_NAME,
  DREAM_GRANT_TTL_MS,
  DREAM_LEASE_MS,
  MAX_DUE_DREAMS,
  RETRIED_OUTCOMES,
  armDream,
  isDreamOutcome,
  nextDreamAfter,
} from "./model";

const DREAM_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE];

export type { MintedToken } from "../texJobs";

/** One claimed dream. `token` indexes the calling action's plaintext list. `since` is null for a first dream. */
export type ClaimedDream = { runId: string; token: number; timeZone: string; since: number | null };

function leaseIsLive(row: Doc<"texDreams">, now: number): boolean {
  return row.claimedAt !== undefined && row.claimedAt + DREAM_LEASE_MS > now;
}

/**
 * Claim up to `tokens.length` due dreams and mint each a grant.
 *
 * A row is due when `nextDreamAt <= now` and no live lease holds it. Claiming
 * clears `nextDreamAt`: the next text arms the next night, so a quiet person
 * is not dreamed about night after night over the same day.
 */
export async function claimDueDreamsHandler(
  ctx: MutationCtx,
  args: { runIds: string[]; tokens: MintedToken[] },
): Promise<ClaimedDream[]> {
  const now = Date.now();
  const limit = Math.min(MAX_DUE_DREAMS, args.tokens.length, args.runIds.length);
  if (limit === 0) return [];
  const candidates = await ctx.db
    .query("texDreams")
    .withIndex("by_nextDreamAt", (q) => q.gte("nextDreamAt", 0).lte("nextDreamAt", now))
    .take(limit * 5);

  const dreams: ClaimedDream[] = [];
  let clientEnsured = false;
  for (const row of candidates) {
    if (dreams.length >= limit) break;
    if (leaseIsLive(row, now)) continue;
    const workspaceId = await texJobWorkspace(ctx, row.userId, row.workspaceId);
    if (workspaceId === null) {
      // Unlinked, paused or gone: no dream until a text arms one again.
      await ctx.db.patch(row._id, { nextDreamAt: null, updatedAt: now });
      continue;
    }
    const scopes = clampScopes(DREAM_SCOPES, "owner");
    if (!hasOperationScope(scopes)) continue;
    if (!clientEnsured) {
      await ensureTexJobClient(ctx, DREAMS_CLIENT_ID, DREAMS_CLIENT_NAME);
      clientEnsured = true;
    }
    const token = dreams.length;
    await applyTexJobGrant(ctx, {
      clientId: DREAMS_CLIENT_ID,
      userId: row.userId,
      workspaceId,
      scopes,
      token: args.tokens[token]!,
      expiresAt: now + DREAM_GRANT_TTL_MS,
      now,
    });
    const runId = args.runIds[token]!;
    await ctx.db.patch(row._id, { claimedAt: now, runId, nextDreamAt: null, updatedAt: now });
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: row.userId,
      actorClientId: DREAMS_CLIENT_ID,
      action: "dream.run",
      details: {},
    });
    dreams.push({
      runId,
      token,
      timeZone: effectiveTimeZone(undefined, await accountTimeZone(ctx, row.userId)),
      since: row.lastDreamedAt ?? null,
    });
  }
  return dreams;
}

/**
 * How a dream went: a code from the closed list, and nothing else. Releases
 * the lease and ends the grant. A dream that did not finish is tried again
 * the next night, and one refused for want of a model waits for a text; an
 * unknown run id or code changes nothing.
 */
export async function recordDreamResultHandler(
  ctx: MutationCtx,
  args: { runId: string; outcome: string },
): Promise<"recorded" | "unknown"> {
  if (!isDreamOutcome(args.outcome)) return "unknown";
  const row = await ctx.db
    .query("texDreams")
    .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
    .unique();
  if (row === null) return "unknown";
  const now = Date.now();
  const dreamed = DREAMED_OUTCOMES.has(args.outcome);
  const zone = effectiveTimeZone(undefined, await accountTimeZone(ctx, row.userId));
  await ctx.db.patch(row._id, {
    lastOutcome: args.outcome,
    claimedAt: undefined,
    runId: undefined,
    // From when it started: a text that came in during it is read by the next one.
    ...(dreamed ? { lastDreamedAt: row.claimedAt ?? now } : {}),
    // A text during the dream has already armed the next; one that did not finish tries again tomorrow night.
    nextDreamAt: row.nextDreamAt ?? (RETRIED_OUTCOMES.has(args.outcome) ? nextDreamAfter(zone, now) : null),
    updatedAt: now,
  });
  await endTexJobGrant(ctx, { clientId: DREAMS_CLIENT_ID, userId: row.userId, workspaceId: row.workspaceId, now });
  return "recorded";
}

/**
 * Daily, for everyone who has linked a phone: a row and a first dream for
 * anyone who has none yet, so nobody waits on their next text to get one
 * (the owner, 2026-10-15: "set this up for all users"). Anyone with a row
 * is left to their texts.
 */
export async function armLinkedDreamsHandler(ctx: MutationCtx): Promise<number> {
  const now = Date.now();
  let armed = 0;
  for (const link of await ctx.db.query("phoneLinks").take(2000)) {
    const row = await ctx.db
      .query("texDreams")
      .withIndex("by_user", (q) => q.eq("userId", link.userId))
      .first();
    if (row !== null) continue;
    const workspaceId = await personalWorkspaceOf(ctx, link.userId);
    if (workspaceId === null) continue;
    const zone = effectiveTimeZone(undefined, await accountTimeZone(ctx, link.userId));
    await armDream(ctx, { userId: link.userId, workspaceId, timeZone: zone, now, texted: false });
    armed += 1;
  }
  return armed;
}

