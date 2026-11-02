/**
 * The action side of carrying row changes to a workspace's object (`../../workspaceObjectPush.ts` holds the
 * outbox's queries and mutations; this holds what runs them from an action). Kept apart from them so a module that
 * only needs to wait for the object (`./objectFirst.ts`, every action that narrows) does not load the functions the
 * mutation builder itself is needed to define.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { objectDoor } from "./objectDoor";
import { MARK_TTL_MS, markToken } from "./markRules";
import type { objectRowOf } from "../workspaceObjects/rows";

/** Rows per object call: the object's `MAX_ROWS_PER_PUT`. */
const ROWS_PER_CALL = 2_000;
/** Rounds one drain runs before handing on to a fresh one. */
const ROUNDS_PER_DRAIN = 20;
/** How soon a failed push is tried again. */
export const RETRY_MS = 30 * 1000;

type ObjectRow = NonNullable<ReturnType<typeof objectRowOf>>;

type Call = ReturnType<typeof objectDoor>;

async function pushRound(
  ctx: ActionCtx,
  call: Call,
  workspaceId: Id<"workspaces">,
  round: { all: boolean; access: boolean; readAt: number; rows: ObjectRow[]; removed: string[]; close: string[] },
): Promise<void> {
  // The marks this round carries the change of close in the same call as its last rows and rules, never before.
  const closing = round.close.length > 0 ? { close: round.close } : {};
  const rules = round.access
    ? {
        member: await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId, audience: "member" }),
        guest: await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId, audience: "guest" }),
      }
    : null;
  if (round.all) {
    // The whole set, staged in pages and swapped in on the last, so a row the tree no longer has leaves.
    const epoch = `push-${round.readAt}`;
    let after: string | undefined = undefined;
    for (;;) {
      const next: { rows: ObjectRow[]; after: string | null } = await ctx.runQuery(internal.functions.workspaceObjectPush.page, {
        workspaceId,
        after,
        readAt: round.readAt,
      });
      const last = next.after === null;
      await call("ws.rows.snapshot", { epoch, rows: next.rows, last, mode: "replace" });
      if (last) break;
      after = next.after ?? undefined;
    }
    if (rules !== null || round.close.length > 0) await call("ws.apply", { rows: [], removed: [], at: round.readAt, ...(rules !== null ? { rules } : {}), ...closing });
    return;
  }
  // Rows and rules in one call: a move changes both, and the object must never judge new paths by old rules.
  const calls = Math.max(round.rows.length, round.removed.length, 1);
  for (let at = 0; at < calls; at += ROWS_PER_CALL) {
    const first = at === 0;
    const last = at + ROWS_PER_CALL >= calls;
    await call("ws.apply", {
      rows: round.rows.slice(at, at + ROWS_PER_CALL),
      removed: round.removed.slice(at, at + ROWS_PER_CALL),
      at: round.readAt,
      ...(first && rules !== null ? { rules } : {}),
      ...(last ? closing : {}),
    });
  }
}

/**
 * A mark for changes that may narrow and opened none (`./mutations.ts` records them as unmarked), opened before the
 * round that carries them. It cannot go before their commit, as a writer's does, but it holds the object to "behind"
 * from here until the rows land: closed with them in the same call, or, when the push fails, by the next round that
 * reads the rows after it (its control-plane record already says done). `null` for a workspace no longer judged in
 * its object, which needs none.
 */
async function coverUnmarked(ctx: ActionCtx, call: Call, workspaceId: Id<"workspaces">): Promise<string | null> {
  const token = markToken();
  if (!(await ctx.runMutation(internal.functions.workspaceObjectMarks.open, { workspaceId, token, now: Date.now() }))) return null;
  await ctx.runMutation(internal.functions.workspaceObjectMarks.done, { token, at: Date.now() });
  await call("ws.mark.open", { token, ttlMs: MARK_TTL_MS });
  return token;
}

/**
 * Carry the workspace's waiting changes to its object, now. What an action that narrows access awaits before it
 * answers, so nothing reports success while the object could still show what was taken away. `"busy"`: another
 * drain holds the workspace and will carry them; `"done"`: none wait.
 */
export async function drainWorkspace(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  options: Parameters<typeof objectDoor>[2] = {},
): Promise<"done" | "busy" | "more"> {
  if (!(await ctx.runMutation(internal.functions.workspaceObjectPush.claim, { workspaceId, now: Date.now() }))) return "busy";
  const call = objectDoor(ctx, workspaceId, options);
  try {
    for (let round = 0; round < ROUNDS_PER_DRAIN; round += 1) {
      const next = await ctx.runQuery(internal.functions.workspaceObjectPush.pending, { workspaceId });
      // An entry that only changed the binding carries no rows or rules: it clears the object's kept copy, nothing more.
      const rowsOrRules = next.all || next.access || next.rows.length > 0 || next.removed.length > 0;
      if (next.unmarked && rowsOrRules) {
        const cover = await coverUnmarked(ctx, call, workspaceId);
        if (cover !== null) next.close = [...next.close, cover];
      }
      if ((next.entryIds.length > 0 && (rowsOrRules || !next.binding)) || next.close.length > 0) await pushRound(ctx, call, workspaceId, next);
      // The kept binding is cleared before the entry is acked, so the workspace reads as behind until it is gone.
      if (next.binding) await call("ws.binding.clear");
      if (next.close.length > 0) await ctx.runMutation(internal.functions.workspaceObjectMarks.drop, { tokens: next.close });
      const more = await ctx.runMutation(internal.functions.workspaceObjectPush.ack, {
        workspaceId,
        entryIds: next.entryIds,
        now: Date.now(),
      });
      if (!more) return "done";
    }
  } catch (error) {
    await ctx.runMutation(internal.functions.workspaceObjectPush.release, { workspaceId });
    await ctx.scheduler.runAfter(RETRY_MS, internal.functions.workspaceObjectPush.drain, { workspaceId });
    console.warn(JSON.stringify({ event: "workspace_object_push_failed", workspaceId, reason: error instanceof Error ? error.message : "failed" }));
    throw error;
  }
  await ctx.runMutation(internal.functions.workspaceObjectPush.release, { workspaceId });
  await ctx.scheduler.runAfter(0, internal.functions.workspaceObjectPush.drain, { workspaceId });
  return "more";
}

/** How long an action that narrowed access waits for the object before it answers anyway, and says so in the log. */
export const SETTLE_MS = 10_000;
const SETTLE_POLL_MS = 150;
/** Entries stamped this far after the action's clock still count as the action's own: the mutation's clock may lead. */
const CLOCK_MARGIN_MS = 2_000;

/**
 * Wait until every change written before now has reached the workspace's object: what an action that narrowed
 * access calls after its mutation and before it answers. `true` at once for a workspace not judged in its object
 * (it has no outbox). `false` past `SETTLE_MS`, logged: the change is kept and the push goes on retrying.
 */
export async function objectSettled(ctx: ActionCtx, workspaceId: Id<"workspaces">, settleMs = SETTLE_MS): Promise<boolean> {
  try {
    return await settle(ctx, workspaceId, settleMs);
  } catch (error) {
    // Never the caller's failure: its change is kept, and the push goes on retrying.
    console.warn(JSON.stringify({ event: "workspace_object_settle_failed", workspaceId, reason: error instanceof Error ? error.message : "failed" }));
    return false;
  }
}

async function settle(ctx: ActionCtx, workspaceId: Id<"workspaces">, settleMs: number): Promise<boolean> {
  const started = Date.now();
  const since = started + CLOCK_MARGIN_MS;
  for (;;) {
    if (!(await ctx.runQuery(internal.functions.workspaceObjectPush.waitingSince, { workspaceId, at: since }))) return true;
    try {
      await drainWorkspace(ctx, workspaceId);
    } catch {
      // Logged and retried by `drainWorkspace`.
    }
    if (!(await ctx.runQuery(internal.functions.workspaceObjectPush.waitingSince, { workspaceId, at: since }))) return true;
    if (Date.now() - started > settleMs) {
      console.warn(JSON.stringify({ event: "workspace_object_narrowing_late", workspaceId, waitedMs: Date.now() - started }));
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

/** `result`, once the changes before it reached the workspace's object: for an action that moved, hid or narrowed. */
export async function settledAfter<T>(ctx: ActionCtx, workspaceId: Id<"workspaces">, result: T): Promise<T> {
  await objectSettled(ctx, workspaceId);
  return result;
}
