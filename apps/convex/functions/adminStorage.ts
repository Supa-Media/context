/**
 * The staff console's storage page: where each workspace's notes are read
 * from, and the one move per workspace that the "Workspace objects home"
 * workflow makes by hand (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * Every public function here authorizes with `requireAdmin`, the staff check
 * `functions/admin.ts` uses. The figures are counts and homes per workspace,
 * never a note's text, path or title.
 *
 * A move is one row per workspace in `storageMoves` (`schema/storageMoves.ts`),
 * which the report reads for "last move", refuses a second move from while it
 * runs, and resumes from when its run was killed. Stages and their refusals
 * are `adminStorageRules.ts`. The move runs as a chain of scheduled
 * `runMove` steps, one page each, so no single action has to fit the action
 * limit: each step records a heartbeat and its cursor, and the last one writes
 * the outcome. Every request and outcome is also audited. A public function may
 * schedule a decrypting internal function, but may not call one:
 * `__tests__/structure/scheduling.test.ts` is the rule.
 *
 * The move never skips parity. `object` goes through the same unforced switch
 * the workflow calls (`workspaceObjects.setHome`), so it is refused unless the
 * workspace was backfilled and its last parity check was clean; the refusal's
 * reason is recorded as it was given.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, query, type ActionCtx } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { requireAdmin, type AdminActor } from "./lib/admin";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { toConvexError } from "./lib/adminFns/errors";
import {
  copyStep,
  planMove,
  reportState,
  type CopyPage,
  type MoveTarget,
} from "./adminStorageRules";

/** Rows read per table. Past it the report says so, and its counts are floors. */
const ROW_LIMIT = 5000;

const homeValidator = v.union(
  v.literal("bucket"),
  v.literal("dual"),
  v.literal("object"),
);
const targetValidator = v.union(v.literal("dual"), v.literal("object"));

export const storageReport = query({
  args: {
    /** A counter the page changes to read the report again, after a move or while one runs. The server ignores its value. */
    refresh: v.optional(v.number()),
  },
  returns: v.object({
    workspaces: v.array(
      v.object({
        workspaceId: v.id("workspaces"),
        slug: v.string(),
        kind: v.union(v.literal("personal"), v.literal("shared")),
        home: homeValidator,
        /**
         * Always null for now: the census shows no per-workspace note count, and counting notes per workspace is
         * not cheap here. Kept so the page can show one without a shape change.
         */
        notes: v.union(v.number(), v.null()),
        /** When `home` was last set; null while no record exists (bucket by default). */
        since: v.union(v.number(), v.null()),
        /** The workspace's newest move, from `storageMoves`; null when it has never been asked to move. */
        lastMove: v.union(
          v.object({
            to: targetValidator,
            state: v.union(
              v.literal("running"),
              v.literal("stale"),
              v.literal("done"),
              v.literal("incomplete"),
              v.literal("refused"),
              v.literal("failed"),
            ),
            reason: v.union(v.string(), v.null()),
            /** When the move was asked for. */
            at: v.number(),
          }),
          v.null(),
        ),
      }),
    ),
    counts: v.object({
      object: v.number(),
      dual: v.number(),
      bucket: v.number(),
      total: v.number(),
    }),
    /** True when a table held more rows than were read; every count is then a floor. */
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    const now = Date.now();
    const workspaces = await ctx.db.query("workspaces").take(ROW_LIMIT + 1);
    const homes = await ctx.db
      .query("workspaceObjectHomes")
      .take(ROW_LIMIT + 1);
    const moves = await ctx.db.query("storageMoves").take(ROW_LIMIT + 1);
    const byWorkspace = new Map<string, Doc<"workspaceObjectHomes">>();
    for (const row of homes.slice(0, ROW_LIMIT))
      byWorkspace.set(String(row.workspaceId), row);
    const moveByWorkspace = new Map<string, Doc<"storageMoves">>();
    for (const row of moves.slice(0, ROW_LIMIT))
      moveByWorkspace.set(String(row.workspaceId), row);

    const rows = workspaces.slice(0, ROW_LIMIT).map((workspace) => {
      const record = byWorkspace.get(String(workspace._id));
      const move = moveByWorkspace.get(String(workspace._id));
      return {
        workspaceId: workspace._id,
        slug: workspace.slug,
        kind: workspace.kind,
        home: record?.home ?? ("bucket" as const),
        notes: null,
        since: record?.since ?? null,
        lastMove:
          move === undefined
            ? null
            : {
                to: move.to,
                state: reportState(move, now),
                reason: move.reason ?? null,
                at: move.startedAt,
              },
      };
    });
    rows.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

    const counts = { object: 0, dual: 0, bucket: 0, total: rows.length };
    for (const row of rows) counts[row.home] += 1;
    return {
      workspaces: rows,
      counts,
      truncated:
        workspaces.length > ROW_LIMIT ||
        homes.length > ROW_LIMIT ||
        moves.length > ROW_LIMIT,
    };
  },
});

/**
 * Ask for one workspace's home to move. Staff only. Refuses a move out of
 * stage, or one already running, with the reason; otherwise writes the row
 * and a "started" audit row, and schedules the first `runMove` step.
 */
export const moveWorkspaceHome = mutation({
  args: { workspaceId: v.id("workspaces"), to: targetValidator },
  returns: v.object({ queued: v.literal(true) }),
  handler: async (ctx, { workspaceId, to }) => {
    const actor = await requireAdmin(ctx).catch((error: unknown) => {
      throw toConvexError(error);
    });
    const workspace = await ctx.db.get(workspaceId);
    if (workspace === null)
      throw new ConvexError({ code: "NOT_FOUND", message: "Not found" });
    const now = Date.now();
    const home = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    const existing = await ctx.db
      .query("storageMoves")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    const plan = planMove({
      name: workspace.slug,
      home: home?.home ?? "bucket",
      to,
      row: existing,
      now,
    });
    if (!plan.ok)
      throw new ConvexError({ code: "CONFLICT", message: plan.message });

    const fields = {
      to,
      state: "running" as const,
      startedAt: now,
      heartbeatAt: now,
      gaps: plan.gaps,
      ...(plan.cursor === undefined ? {} : { cursor: plan.cursor }),
    };
    if (existing === null) {
      await ctx.db.insert("storageMoves", { workspaceId, ...fields });
    } else {
      await ctx.db.patch(existing._id, {
        ...fields,
        reason: undefined,
        cursor: plan.cursor,
      });
    }
    await recordAdminAudit(ctx, actor, "storage.home_set", workspace.slug, {
      to,
      state: "started",
    });
    await ctx.scheduler.runAfter(0, internal.functions.adminStorage.runMove, {
      workspaceId,
      slug: workspace.slug,
      to,
      actorUserId: actor.userId,
      actorEmail: actor.email,
      startedAt: now,
      switched: plan.switched,
      gaps: plan.gaps,
      ...(plan.cursor === undefined ? {} : { cursor: plan.cursor }),
    });
    return { queued: true as const };
  },
});

/**
 * One step of a move, scheduled by `moveWorkspaceHome` and by itself. Internal.
 *
 * Each step does one thing, then hands on:
 * - not yet `switched`: the unforced switch (`bucket` -> `dual`, or `dual` ->
 *   `object`, which ends here). A refusal ends the move with its reason.
 * - `switched` (copy): one backfill page for this workspace alone. Not done:
 *   record the cursor and heartbeat, and schedule the next page. Done: the
 *   outcome is `done`, or `incomplete` when any page had a gap.
 *
 * A step whose run was superseded (a newer request replaced its row) stops
 * without writing. A failure is recorded as `failed`.
 */
export const runMove = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    to: targetValidator,
    actorUserId: v.id("users"),
    actorEmail: v.string(),
    startedAt: v.number(),
    switched: v.boolean(),
    gaps: v.boolean(),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const step = await onePage(ctx, args);
    if ("state" in step) {
      await ctx.runMutation(internal.functions.adminStorage.recordMoveOutcome, {
        workspaceId: args.workspaceId,
        startedAt: args.startedAt,
        actorUserId: args.actorUserId,
        actorEmail: args.actorEmail,
        slug: args.slug,
        to: args.to,
        state: step.state,
        ...(step.reason === undefined ? {} : { reason: step.reason }),
        ...(step.copied === undefined ? {} : { copied: step.copied }),
      });
      return null;
    }
    const { cursor: _previous, ...rest } = args;
    const current = await ctx.runMutation(
      internal.functions.adminStorage.recordMoveProgress,
      {
        workspaceId: args.workspaceId,
        startedAt: args.startedAt,
        gaps: step.gaps,
        ...(step.cursor === undefined ? {} : { cursor: step.cursor }),
      },
    );
    if (!current) return null;
    await ctx.scheduler.runAfter(0, internal.functions.adminStorage.runMove, {
      ...rest,
      switched: true,
      gaps: step.gaps,
      ...(step.cursor === undefined ? {} : { cursor: step.cursor }),
    });
    return null;
  },
});

type Outcome = {
  state: "done" | "incomplete" | "refused" | "failed";
  reason?: string;
  copied?: boolean;
};

/** Does one step's work and says whether the move ends (an outcome) or hands on (a cursor and its gaps). */
async function onePage(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    slug: string;
    to: MoveTarget;
    switched: boolean;
    gaps: boolean;
    cursor?: string;
  },
): Promise<Outcome | { cursor: string | undefined; gaps: boolean }> {
  try {
    if (!args.switched) {
      const set = await ctx.runAction(
        internal.functions.workspaceObjects.setHome,
        {
          workspaceId: args.workspaceId,
          home: args.to,
        },
      );
      if (!set.ok) return { state: "refused", reason: set.reason ?? "REFUSED" };
      if (args.to === "object") return { state: "done" };
      return { cursor: undefined, gaps: false };
    }
    const page: CopyPage = await ctx.runAction(
      internal.functions.workspaceObjects.backfill,
      {
        step: "copy",
        dryRun: false,
        only: args.slug,
        ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      },
    );
    if (page.refused !== undefined)
      return { state: "failed", reason: page.refused };
    const next = copyStep(page, args.gaps);
    if (next.done)
      return { state: next.gaps ? "incomplete" : "done", copied: !next.gaps };
    return { cursor: next.cursor, gaps: next.gaps };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "storage_move_failed",
        workspaceId: args.workspaceId,
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return { state: "failed" };
  }
}

/**
 * A page's heartbeat and cursor. False when the row is no longer this run's
 * (superseded, or already finished): the caller then stops.
 */
export const recordMoveProgress = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    startedAt: v.number(),
    cursor: v.optional(v.string()),
    gaps: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db
      .query("storageMoves")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (
      row === null ||
      row.state !== "running" ||
      row.startedAt !== args.startedAt
    )
      return false;
    await ctx.db.patch(row._id, {
      heartbeatAt: Date.now(),
      gaps: args.gaps,
      cursor: args.cursor,
    });
    return true;
  },
});

/**
 * The move's outcome: the row's state, and the audit row. A superseded run
 * writes neither.
 */
export const recordMoveOutcome = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    startedAt: v.number(),
    actorUserId: v.id("users"),
    actorEmail: v.string(),
    slug: v.string(),
    to: targetValidator,
    state: v.union(
      v.literal("done"),
      v.literal("incomplete"),
      v.literal("refused"),
      v.literal("failed"),
    ),
    reason: v.optional(v.string()),
    copied: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db
      .query("storageMoves")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (
      row === null ||
      row.state !== "running" ||
      row.startedAt !== args.startedAt
    )
      return null;
    await ctx.db.patch(row._id, {
      state: args.state,
      heartbeatAt: Date.now(),
      reason: args.reason,
      cursor: undefined,
    });
    const actor: AdminActor = {
      userId: args.actorUserId as Id<"users">,
      email: args.actorEmail,
    };
    await recordAdminAudit(ctx, actor, "storage.home_set", args.slug, {
      to: args.to,
      state: args.state,
      ...(args.reason === undefined ? {} : { reason: args.reason }),
      ...(args.copied === undefined ? {} : { copied: args.copied }),
    });
    return null;
  },
});
