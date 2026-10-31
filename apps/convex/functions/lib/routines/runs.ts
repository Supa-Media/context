/**
 * Handing due routines to the texting Worker, and hearing how they went.
 *
 * Everything that could have changed since a row was written is asked again
 * here, at the moment a run is handed out: whether the writer can still write
 * in this workspace, which of the people it names are still members with a
 * phone. The gateway asks the rest — whether the writer can still see the
 * note, whether it is paused — when it reads the note to run it.
 */

import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { SCOPE_PRIVATE, SCOPE_READ, SCOPE_WRITE, clampScopes, hasOperationScope } from "../consentScopes";
import { accountTimeZone, routineRecipients, runsRoutine, writingRole } from "./access";
import { routineChat } from "./chats";
import { claimChatLooks, finishChatLook } from "../textGroupLooks";
import {
  MAX_DUE_RUNS,
  ONE_OFF_RETRY_EVERY_MS,
  ONE_OFF_RETRY_MS,
  RECONCILE_OUTCOMES,
  ROUTINES_CLIENT_ID,
  ROUTINES_CLIENT_NAME,
  ROUTINE_GRANT_TTL_MS,
  ROUTINE_LEASE_MS,
  WRITER_GONE,
  WRITER_UNKNOWN,
  effectiveTimeZone,
  isRoutineOutcome,
  nextRunFor,
} from "./model";
import { fallsBackToOwner, scheduleReconcile } from "./sync";

const ROUTINE_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE];

/** A token pair minted by the calling action: hashes only, never the plaintext. */
export type MintedToken = { hashedAccessToken: string; hashedRefreshToken: string };

/**
 * One claimed run. `token` indexes the calling action's plaintext list. A chat
 * routine's has none and names its chat's key instead: it runs as the chat's
 * own turn, which mints its own grant (`chats.ts`).
 */
export type ClaimedRun = {
  runId: string;
  token?: number;
  path: string;
  timeZone: string;
  send: "text" | "note" | "both";
  phones: string[];
  chat?: string;
  /** A chat routine's last run, so its turn can say what is new since (`wake: new mail`). */
  since?: number;
  /** When this routine next runs after this run (`null` when paused): the alarm re-arms at it. */
  nextRunAt?: number | null;
};

/** One routine, named by its workspace and path: an alarm's call, not the cron's. */
export type RunScope = { workspaceId: string; path: string };

/** The message a refused scope carries, which the due route answers as a 400. */
export const INVALID_SCOPE = "routine scope is not a workspace";

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
  args: { runIds: string[]; tokens: MintedToken[]; scope?: RunScope },
): Promise<ClaimedRun[]> {
  const now = Date.now();
  const limit = Math.min(MAX_DUE_RUNS, args.tokens.length, args.runIds.length);
  if (limit === 0) return [];
  // A scoped call (an alarm) looks at its one routine only. A workspace id that is not one of ours is refused, not read as nothing.
  const scoped = args.scope === undefined ? null : scopeOf(ctx, args.scope);
  const candidates =
    scoped === null
      ? await ctx.db
          .query("routines")
          .withIndex("by_nextRunAt", (q) => q.gte("nextRunAt", 0).lte("nextRunAt", now))
          .take(limit * 5)
      : await ctx.db
          .query("routines")
          .withIndex("by_workspace_path", (q) => q.eq("workspaceId", scoped.workspaceId).eq("path", scoped.path))
          .take(5);

  const runs: ClaimedRun[] = [];
  /** `${workspaceId}:${userId}` → token index already minted in this call. */
  const minted = new Map<string, number>();
  let clientEnsured = false;

  for (const row of candidates) {
    if (runs.length >= limit) break;
    if (leaseIsLive(row, now)) continue;
    // Due means now: a scoped call can find a row that is not due yet, and must leave it alone.
    if (row.nextRunAt === null || row.nextRunAt === undefined || row.nextRunAt > now) continue;

    const workspace = await ctx.db.get(row.workspaceId);
    // An alarm is for a person's own routines. A shared workspace's are the cron's to clean up, not an alarm's to run.
    if (scoped !== null && workspace?.kind !== "personal") continue;
    if (workspace === null || !runsRoutine(workspace, row)) {
      // Asked when a run is handed out, so a shared workspace's row left from
      // before routines were personal-only goes now, not at the next scan.
      await ctx.db.delete(row._id);
      continue;
    }
    const role = await writingRole(ctx, row.workspaceId, row.writerUserId);
    if (role === null) {
      // Asked now, not when the row was written: a writer who left, was made a
      // member, or deleted their account no longer runs anything here.
      await ctx.db.patch(row._id, { nextRunAt: null, lastOutcome: WRITER_GONE, updatedAt: now });
      continue;
    }
    if (row.writerSource === "fallback") {
      // Asked now too, so a row written before this rule never runs as the
      // owner of a shared workspace: nobody was seen writing it there.
      if (!(await fallsBackToOwner(ctx.db, workspace))) {
        await ctx.db.patch(row._id, { nextRunAt: null, lastOutcome: WRITER_UNKNOWN, updatedAt: now });
        continue;
      }
    }
    if (workspace.kind !== "personal") {
      // A chat routine: into its chat, as its writer's tag there, or nowhere.
      const chat = await routineChat(ctx, row.workspaceId, row.chat ?? "");
      const phones = chat === null ? [] : await routineRecipients(ctx, { ...row, send: "text" });
      const zone = effectiveTimeZone(row.timeZone, await accountTimeZone(ctx, row.writerUserId));
      if (chat === null || phones.length === 0) {
        await ctx.db.patch(row._id, { lastOutcome: "no_chat", lastRunAt: now, nextRunAt: nextRunFor(row, zone, now), updatedAt: now });
        continue;
      }
      const runId = args.runIds[runs.length]!;
      const since = row.lastRunAt;
      await ctx.db.patch(row._id, { claimedAt: now, runId, lastRunAt: now, nextRunAt: nextRunFor(row, zone, now), updatedAt: now });
      await recordAudit(ctx, {
        workspaceId: row.workspaceId,
        actorUserId: row.writerUserId,
        actorClientId: ROUTINES_CLIENT_ID,
        action: "routine.run",
        paths: [row.path],
        details: { path: row.path, chat: true },
      });
      runs.push({ runId, path: row.path, timeZone: zone, send: row.send, phones, chat: chat.groupKey, ...(since !== undefined ? { since } : {}) });
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
    const next = nextRunFor(row, zone, now);
    await ctx.db.patch(row._id, {
      claimedAt: now,
      runId,
      lastRunAt: now,
      nextRunAt: next,
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
      // The writer's own phone and nobody else's.
      phones: await routineRecipients(ctx, row),
      nextRunAt: next,
    });
  }
  if (scoped !== null) return runs;
  // A chat's own look at the mail shared with it is a chat run with no note behind it.
  runs.push(...(await claimChatLooks(ctx, args.runIds.slice(runs.length, limit), now)));
  return runs;
}

/** The scope as the ids the table is read by. A workspace id that is not one of ours is refused. */
function scopeOf(ctx: MutationCtx, scope: RunScope): { workspaceId: Id<"workspaces">; path: string } {
  const workspaceId = ctx.db.normalizeId("workspaces", scope.workspaceId);
  if (workspaceId === null) throw new ConvexError(INVALID_SCOPE);
  return { workspaceId, path: scope.path };
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
  if (row === null) return (await finishChatLook(ctx, args.runId)) ? "recorded" : "unknown";
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

  /*
    A one-off that failed is tried again, every few minutes, until
    ONE_OFF_RETRY_MS after the time it was set for. A repeating routine has its
    next slot; a reminder has no other, so one failed turn must not lose it.
  */
  if (row.cadence.unit === "once" && args.outcome === "failed" && !row.paused) {
    const zone = effectiveTimeZone(row.timeZone, await accountTimeZone(ctx, row.writerUserId));
    const setFor = nextRunFor(row, zone, 0);
    if (setFor !== null && now - setFor < ONE_OFF_RETRY_MS) {
      await ctx.db.patch(row._id, { nextRunAt: now + ONE_OFF_RETRY_EVERY_MS });
    }
  }

  // The row no longer describes the file: read the folder again.
  if (RECONCILE_OUTCOMES.has(args.outcome)) await scheduleReconcile(ctx, row.workspaceId, []);
  return "recorded";
}
