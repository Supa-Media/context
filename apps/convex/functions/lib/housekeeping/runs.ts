/**
 * Handing due housekeeping runs to the texting Worker, and hearing how they
 * went (`docs/decisions/texting-assistant/housekeeping.md`).
 *
 * Whether the phone is still linked, not paused, and the person still owns
 * the personal workspace is asked again at every claim (`texJobWorkspace`).
 * The grant is housekeeping's own client, never the texting grant. A run
 * texts nobody: what it did is in the person's own `tex/housekeeping/`.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { SCOPE_PRIVATE, SCOPE_READ, SCOPE_WRITE, clampScopes, hasOperationScope } from "../consentScopes";
import { applyTexJobGrant, endTexJobGrant, ensureTexJobClient, texJobWorkspace, type MintedToken } from "../texJobs";
import { personalWorkspaceOf } from "../../textLinks";
import { accountTimeZone } from "../routines/access";
import { effectiveTimeZone } from "../routines/model";
import { validateName } from "../names";
import {
  HOUSEKEEPING_CLIENT_ID,
  HOUSEKEEPING_CLIENT_NAME,
  HOUSEKEEPING_GRANT_TTL_MS,
  HOUSEKEEPING_LEASE_MS,
  MAX_DUE_HOUSEKEEPING,
  armHousekeeping,
  isHousekeepingOutcome,
  nextHousekeepingAfter,
} from "./model";

/** Write moves, archives and rewrites their notes, and writes the run's log in `tex/housekeeping/`. */
const HOUSEKEEPING_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE];

/** One claimed run. `token` indexes the calling action's plaintext list. */
export type ClaimedHousekeeping = { runId: string; token: number; timeZone: string };

function leaseIsLive(row: Doc<"texHousekeeping">, now: number): boolean {
  return row.claimedAt !== undefined && row.claimedAt + HOUSEKEEPING_LEASE_MS > now;
}

async function zoneOf(ctx: MutationCtx, userId: Id<"users">): Promise<string> {
  return effectiveTimeZone(undefined, await accountTimeZone(ctx, userId));
}

/**
 * Claim up to `tokens.length` due runs and mint each a grant.
 *
 * A row is due when `nextRunAt <= now` and no live lease holds it. Claiming
 * moves `nextRunAt` on to tomorrow straight away, so a run whose result never
 * comes back is simply followed by the next day's.
 */
export async function claimDueHousekeepingHandler(
  ctx: MutationCtx,
  args: { runIds: string[]; tokens: MintedToken[] },
): Promise<ClaimedHousekeeping[]> {
  const now = Date.now();
  const limit = Math.min(MAX_DUE_HOUSEKEEPING, args.tokens.length, args.runIds.length);
  if (limit === 0) return [];
  const candidates = await ctx.db
    .query("texHousekeeping")
    .withIndex("by_nextRunAt", (q) => q.gte("nextRunAt", 0).lte("nextRunAt", now))
    .take(limit * 5);

  const runs: ClaimedHousekeeping[] = [];
  let clientEnsured = false;
  for (const row of candidates) {
    if (runs.length >= limit) break;
    if (leaseIsLive(row, now)) continue;
    const workspaceId = await texJobWorkspace(ctx, row.userId, row.workspaceId);
    if (workspaceId === null) {
      // Unlinked, paused or gone: no housekeeping until a text arms it again.
      await ctx.db.patch(row._id, { nextRunAt: null, updatedAt: now });
      continue;
    }
    const scopes = clampScopes(HOUSEKEEPING_SCOPES, "owner");
    if (!hasOperationScope(scopes)) continue;
    if (!clientEnsured) {
      await ensureTexJobClient(ctx, HOUSEKEEPING_CLIENT_ID, HOUSEKEEPING_CLIENT_NAME);
      clientEnsured = true;
    }
    const token = runs.length;
    await applyTexJobGrant(ctx, {
      clientId: HOUSEKEEPING_CLIENT_ID,
      userId: row.userId,
      workspaceId,
      scopes,
      token: args.tokens[token]!,
      expiresAt: now + HOUSEKEEPING_GRANT_TTL_MS,
      now,
    });
    const runId = args.runIds[token]!;
    const timeZone = await zoneOf(ctx, row.userId);
    await ctx.db.patch(row._id, { claimedAt: now, runId, nextRunAt: nextHousekeepingAfter(timeZone, now), updatedAt: now });
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: row.userId,
      actorClientId: HOUSEKEEPING_CLIENT_ID,
      action: "housekeeping.run",
      details: {},
    });
    runs.push({ runId, token, timeZone });
  }
  return runs;
}

/**
 * How a run went: a code from the closed list, and nothing else. Releases the
 * lease and ends the grant. Every run goes on tomorrow, one that found no
 * model included: a plan can change overnight. An unknown run id or code changes nothing.
 */
export async function recordHousekeepingResultHandler(
  ctx: MutationCtx,
  args: { runId: string; outcome: string },
): Promise<"recorded" | "unknown"> {
  if (!isHousekeepingOutcome(args.outcome)) return "unknown";
  const row = await ctx.db
    .query("texHousekeeping")
    .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
    .unique();
  if (row === null) return "unknown";
  const now = Date.now();
  const nextRunAt = row.nextRunAt ?? nextHousekeepingAfter(await zoneOf(ctx, row.userId), now);
  await ctx.db.patch(row._id, {
    lastOutcome: args.outcome,
    claimedAt: undefined,
    runId: undefined,
    lastRunAt: row.claimedAt ?? now,
    nextRunAt,
    updatedAt: now,
  });
  await endTexJobGrant(ctx, { clientId: HOUSEKEEPING_CLIENT_ID, userId: row.userId, workspaceId: row.workspaceId, now });
  return "recorded";
}

/**
 * Daily, for everyone who has linked a phone: a row and a first run for
 * anyone who has none yet, and a next run for a row that stopped. Anyone
 * with a run ahead is left to its schedule.
 */
export async function armLinkedHousekeepingHandler(ctx: MutationCtx): Promise<number> {
  const now = Date.now();
  let armed = 0;
  for (const link of await ctx.db.query("phoneLinks").take(2000)) {
    const row = await ctx.db
      .query("texHousekeeping")
      .withIndex("by_user", (q) => q.eq("userId", link.userId))
      .first();
    if (row !== null && row.nextRunAt !== null) continue;
    const workspaceId = await personalWorkspaceOf(ctx, link.userId);
    if (workspaceId === null) continue;
    await armHousekeeping(ctx, { userId: link.userId, workspaceId, timeZone: await zoneOf(ctx, link.userId), now });
    armed += 1;
  }
  return armed;
}

/** What `runHousekeepingNowHandler` did, as a code: the workflow prints it, and nothing else. */
export type HousekeepingNow = "due" | "running" | "not_armed" | "unknown_name";

/**
 * Bring one person's next run forward to now, by their handle or their
 * personal workspace's slug, for the manual "Tex housekeeping now" workflow:
 * a fix to housekeeping is verified on a real run without waiting for 9am
 * (2026-10-26). The next Cron tick claims it as it claims any due run, every
 * check asked again there. A run already handed out is left to finish.
 */
export async function runHousekeepingNowHandler(ctx: MutationCtx, args: { name: string }): Promise<HousekeepingNow> {
  const valid = validateName(args.name.replace(/^@/, ""));
  if (!valid.ok) return "unknown_name";
  const claim = await ctx.db
    .query("names")
    .withIndex("by_name", (q) => q.eq("name", valid.normalized))
    .unique();
  let userId: Id<"users"> | null = claim?.kind === "user" ? (claim.userId ?? null) : null;
  if (claim?.kind === "workspace" && claim.workspaceId !== undefined) {
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", claim.workspaceId!))
      .take(50);
    userId = members.find((member) => member.role === "owner")?.userId ?? null;
  }
  if (userId === null) return "unknown_name";
  const row = await ctx.db
    .query("texHousekeeping")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (row === null) return "not_armed";
  const now = Date.now();
  if (leaseIsLive(row, now)) return "running";
  await ctx.db.patch(row._id, { nextRunAt: now, updatedAt: now });
  return "due";
}
