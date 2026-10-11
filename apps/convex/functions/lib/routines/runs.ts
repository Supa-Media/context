/**
 * Handing due routines to the texting Worker, and hearing how they went.
 *
 * Everything that could have changed since a row was written is asked again
 * here, at the moment a run is handed out: whether the writer can still write
 * in this workspace, which of the people it names are still members with a
 * phone. The gateway asks the rest — whether the writer can still see the
 * note, whether it is paused — when it reads the note to run it.
 */

import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { SCOPE_PRIVATE, SCOPE_READ, SCOPE_WRITE, clampScopes, hasOperationScope } from "../consentScopes";
import { accountTimeZone, routineRecipients, writingRole } from "./access";
import {
  MAX_DUE_RUNS,
  RECONCILE_OUTCOMES,
  ROUTINES_CLIENT_ID,
  ROUTINES_CLIENT_NAME,
  ROUTINE_GRANT_TTL_MS,
  ROUTINE_LEASE_MS,
  WRITER_GONE,
  effectiveTimeZone,
  isRoutineOutcome,
  nextRunFor,
} from "./model";
import { scheduleReconcile } from "./sync";

const ROUTINE_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE];

/** A token pair minted by the calling action: hashes only, never the plaintext. */
export type MintedToken = { hashedAccessToken: string; hashedRefreshToken: string };

/** One claimed run. `token` indexes the calling action's plaintext list. */
export type ClaimedRun = {
  runId: string;
  token: number;
  path: string;
  timeZone: string;
  send: "text" | "note" | "both";
  phones: string[];
};

function leaseIsLive(row: Doc<"routines">, now: number): boolean {
  return row.claimedAt !== undefined && row.claimedAt + ROUTINE_LEASE_MS > now;
}

/**
 * Claim up to `tokens.length` due rows and mint each writer a grant.
 *
 * - A row is due when `nextRunAt <= now` and no live lease holds it.
 * - Its `nextRunAt` moves to the next run after now, so a window missed while
 *   nothing polled runs once, not once per missed slot.
 * - One grant row per (workspace, writer) for the `context_routines` client,
 *   patched per run; runs for the same writer in one call share its token. A
 *   writer with a run still out under a live lease from an earlier call waits:
 *   patching the grant would cut that run's token off mid-turn.
 */
export async function claimDueRoutinesHandler(
  ctx: MutationCtx,
  args: { runIds: string[]; tokens: MintedToken[] },
): Promise<ClaimedRun[]> {
  const now = Date.now();
  const limit = Math.min(MAX_DUE_RUNS, args.tokens.length, args.runIds.length);
  if (limit === 0) return [];
  const candidates = await ctx.db
    .query("routines")
    .withIndex("by_nextRunAt", (q) => q.gte("nextRunAt", 0).lte("nextRunAt", now))
    .take(limit * 5);

  const runs: ClaimedRun[] = [];
  /** `${workspaceId}:${userId}` → token index already minted in this call. */
  const minted = new Map<string, number>();
  let clientEnsured = false;

  for (const row of candidates) {
    if (runs.length >= limit) break;
    if (leaseIsLive(row, now)) continue;

    const role = await writingRole(ctx, row.workspaceId, row.writerUserId);
    if (role === null) {
      // Asked now, not when the row was written: a writer who left, was made a
      // member, or deleted their account no longer runs anything here.
      await ctx.db.patch(row._id, { nextRunAt: null, lastOutcome: WRITER_GONE, updatedAt: now });
      continue;
    }
    const scopes = clampScopes(ROUTINE_SCOPES, role);
    if (!hasOperationScope(scopes)) continue;

    const key = `${row.workspaceId}:${row.writerUserId}`;
    let token = minted.get(key);
    if (token === undefined) {
      if (await writerHasRunOut(ctx, row, now)) continue;
      token = minted.size;
      if (!clientEnsured) {
        await ensureRoutinesClient(ctx);
        clientEnsured = true;
      }
      await applyRoutineGrant(ctx, row, scopes, args.tokens[token]!, now);
      minted.set(key, token);
    }

    const zone = effectiveTimeZone(row.timeZone, await accountTimeZone(ctx, row.writerUserId));
    const runId = args.runIds[runs.length]!;
    await ctx.db.patch(row._id, {
      claimedAt: now,
      runId,
      lastRunAt: now,
      nextRunAt: nextRunFor(row, zone, now),
      updatedAt: now,
    });
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      actorUserId: row.writerUserId,
      actorClientId: ROUTINES_CLIENT_ID,
      action: "routine.run",
      paths: [row.path],
      details: { path: row.path },
    });
    runs.push({
      runId,
      token,
      path: row.path,
      timeZone: zone,
      send: row.send,
      // A routine nobody was seen writing runs as the owner, so it texts only
      // the owner: its `to:` could have been written by anyone who reached
      // the folder without a signal, naming themselves.
      phones: await routineRecipients(ctx, { ...row, to: row.writerSource === "signal" ? row.to : [] }),
    });
  }
  return runs;
}

/** Whether another of this writer's routines here is still out under a live lease. */
async function writerHasRunOut(ctx: MutationCtx, row: Doc<"routines">, now: number): Promise<boolean> {
  const siblings = await ctx.db
    .query("routines")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", row.workspaceId))
    .take(400);
  return siblings.some(
    (other) => other._id !== row._id && other.writerUserId === row.writerUserId && leaseIsLive(other, now),
  );
}

/**
 * The writer's routines grant on this workspace, holding this token. Never the
 * texting grant, which is one per person and is replaced by the next text.
 */
async function applyRoutineGrant(
  ctx: MutationCtx,
  row: Doc<"routines">,
  scopes: string[],
  token: MintedToken,
  now: number,
): Promise<void> {
  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_workspace_user", (q) => q.eq("workspaceId", row.workspaceId).eq("userId", row.writerUserId))
    .collect();
  const reusable = grants.find((grant) => grant.clientId === ROUTINES_CLIENT_ID && grant.status === "active");
  const fields = {
    scopes,
    hashedAccessToken: token.hashedAccessToken,
    hashedRefreshToken: token.hashedRefreshToken,
    accessTokenExpiresAt: now + ROUTINE_GRANT_TTL_MS,
  };
  if (reusable === undefined) {
    await ctx.db.insert("oauthGrants", {
      workspaceId: row.workspaceId,
      userId: row.writerUserId,
      clientId: ROUTINES_CLIENT_ID,
      ...fields,
      status: "active",
      createdAt: now,
    });
  } else {
    await ctx.db.patch(reusable._id, fields);
  }
}

async function ensureRoutinesClient(ctx: MutationCtx): Promise<void> {
  const existing = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", ROUTINES_CLIENT_ID))
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("oauthClients", {
    clientId: ROUTINES_CLIENT_ID,
    clientName: ROUTINES_CLIENT_NAME,
    redirectUris: [],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: [],
    responseTypes: [],
    createdAt: Date.now(),
  });
}

/**
 * How a run went: a code from the closed list, and nothing else. Releases the
 * lease, and ends the run's token once none of the writer's runs here is out.
 * An unknown run id or code changes nothing.
 */
export async function recordRoutineResultHandler(
  ctx: MutationCtx,
  args: { runId: string; outcome: string },
): Promise<"recorded" | "unknown"> {
  if (!isRoutineOutcome(args.outcome)) return "unknown";
  const row = await ctx.db
    .query("routines")
    .withIndex("by_run_id", (q) => q.eq("runId", args.runId))
    .unique();
  if (row === null) return "unknown";
  const now = Date.now();
  await ctx.db.patch(row._id, {
    lastOutcome: args.outcome,
    claimedAt: undefined,
    runId: undefined,
    updatedAt: now,
  });

  if (!(await writerHasRunOut(ctx, row, now))) {
    const grants = await ctx.db
      .query("oauthGrants")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", row.workspaceId).eq("userId", row.writerUserId))
      .collect();
    for (const grant of grants) {
      if (grant.clientId !== ROUTINES_CLIENT_ID || grant.status !== "active") continue;
      if ((grant.accessTokenExpiresAt ?? 0) > now) await ctx.db.patch(grant._id, { accessTokenExpiresAt: now });
    }
  }

  // The row no longer describes the file: read the folder again.
  if (RECONCILE_OUTCOMES.has(args.outcome)) await scheduleReconcile(ctx, row.workspaceId, []);
  return "recorded";
}
