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
 * The move is two steps. The public mutation checks staff, writes a
 * "started" audit row and schedules `runMove`; the scheduled internal action
 * does the switch and the copy (the decrypting work) and writes the outcome
 * row. A public function may schedule a decrypting internal function, but may
 * not call one: `__tests__/structure/scheduling.test.ts` is the rule.
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

/** Rows read per table. Past it the report says so, and its counts are floors. */
const ROW_LIMIT = 5000;
/** Newest audit rows read for the "last move" column. A workspace moved longer ago than these shows none. */
const AUDIT_SCAN_LIMIT = 2000;
/** How long one move's copy may keep paging before it hands back as not finished. */
const COPY_BUDGET_MS = 6 * 60 * 1000;

const homeValidator = v.union(
  v.literal("bucket"),
  v.literal("dual"),
  v.literal("object"),
);
const targetValidator = v.union(v.literal("dual"), v.literal("object"));
const moveStates = ["started", "done", "refused", "failed"] as const;
type MoveState = (typeof moveStates)[number];
type MoveResult = { ok: boolean; reason?: string; copied?: boolean };

export const storageReport = query({
  args: {},
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
        /** The newest move's audit row for this workspace, if one is among the newest audit rows read. */
        lastMove: v.union(
          v.object({
            to: targetValidator,
            state: v.union(
              v.literal("started"),
              v.literal("done"),
              v.literal("refused"),
              v.literal("failed"),
            ),
            reason: v.union(v.string(), v.null()),
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
    const workspaces = await ctx.db.query("workspaces").take(ROW_LIMIT + 1);
    const homes = await ctx.db
      .query("workspaceObjectHomes")
      .take(ROW_LIMIT + 1);
    const audit = await ctx.db
      .query("adminAuditEvents")
      .withIndex("by_at")
      .order("desc")
      .take(AUDIT_SCAN_LIMIT);
    const byWorkspace = new Map<string, Doc<"workspaceObjectHomes">>();
    for (const row of homes.slice(0, ROW_LIMIT))
      byWorkspace.set(String(row.workspaceId), row);

    // Newest first, so the first move row seen for a slug is its last move.
    const lastBySlug = new Map<string, LastMove>();
    for (const row of audit) {
      if (
        row.action !== "storage.home_set" ||
        row.subject === undefined ||
        lastBySlug.has(row.subject)
      )
        continue;
      const move = lastMoveOf(row);
      if (move !== null) lastBySlug.set(row.subject, { ...move, at: row.at });
    }

    const rows = workspaces.slice(0, ROW_LIMIT).map((workspace) => {
      const record = byWorkspace.get(String(workspace._id));
      return {
        workspaceId: workspace._id,
        slug: workspace.slug,
        kind: workspace.kind,
        home: record?.home ?? ("bucket" as const),
        notes: null,
        since: record?.since ?? null,
        lastMove: lastBySlug.get(workspace.slug) ?? null,
      };
    });
    rows.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

    const counts = { object: 0, dual: 0, bucket: 0, total: rows.length };
    for (const row of rows) counts[row.home] += 1;
    return {
      workspaces: rows,
      counts,
      truncated: workspaces.length > ROW_LIMIT || homes.length > ROW_LIMIT,
    };
  },
});

/**
 * Ask for one workspace's home to move. Staff only. Writes a "started" audit
 * row and schedules `runMove`, which does the work and writes the outcome;
 * the console reads the outcome through `storageReport`'s `lastMove`.
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
    });
    return { queued: true as const };
  },
});

/**
 * The move itself, scheduled by `moveWorkspaceHome`. Internal.
 *
 * - `dual` (bucket to dual, or a rollback from object): the workflow's unforced
 *   `arm` switch, then its `copy` step for this workspace alone until done or
 *   out of budget. Reads stay on the bucket. `copied` says whether every body,
 *   row and rule crossed.
 * - `object` (dual to object): the unforced switch. Refused with the switch's
 *   reason (`NOT_BACKFILLED`, `PARITY_STALE`, `PARITY_DIFFERS`, ...).
 */
export const runMove = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    to: targetValidator,
    actorUserId: v.id("users"),
    actorEmail: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const outcome = {
      actorUserId: args.actorUserId,
      actorEmail: args.actorEmail,
      slug: args.slug,
      to: args.to,
    };
    let result: MoveResult;
    try {
      const set = await ctx.runAction(
        internal.functions.workspaceObjects.setHome,
        { workspaceId: args.workspaceId, home: args.to },
      );
      result = set.ok
        ? { ok: true }
        : { ok: false, reason: set.reason ?? "REFUSED" };
      if (set.ok && args.to === "dual")
        result.copied = await copyWorkspace(ctx, args.slug);
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "storage_move_failed",
          workspaceId: args.workspaceId,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      await ctx.runMutation(internal.functions.adminStorage.recordMoveOutcome, {
        ...outcome,
        state: "failed",
      });
      return null;
    }
    await ctx.runMutation(internal.functions.adminStorage.recordMoveOutcome, {
      ...outcome,
      state: result.ok ? "done" : "refused",
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.copied === undefined ? {} : { copied: result.copied }),
    });
    return null;
  },
});

/** The backfill's copy step for one workspace, paged until done or out of budget. False when anything was held back or failed. */
async function copyWorkspace(ctx: ActionCtx, slug: string): Promise<boolean> {
  const started = Date.now();
  let cursor: string | undefined;
  let clean = true;
  while (Date.now() - started < COPY_BUDGET_MS) {
    const page = await ctx.runAction(
      internal.functions.workspaceObjects.backfill,
      {
        step: "copy",
        dryRun: false,
        only: slug,
        ...(cursor === undefined ? {} : { cursor }),
      },
    );
    if ("refused" in page && page.refused !== undefined) return false;
    // Counts are per page: every page's failures and holds count toward the answer.
    if (page.failed > 0 || page.unreachable > 0 || page.heldBack > 0)
      clean = false;
    if (page.done) return clean;
    cursor = page.cursor;
  }
  return false;
}

// -- internals ------------------------------------------------------------

type LastMove = {
  to: "dual" | "object";
  state: MoveState;
  reason: string | null;
  at: number;
};

/** A move row's details, read back defensively: an unknown shape is no move. */
function lastMoveOf(row: Doc<"adminAuditEvents">): Omit<LastMove, "at"> | null {
  const details = row.details ?? {};
  const to = details.to;
  const state = details.state;
  if (
    (to !== "dual" && to !== "object") ||
    typeof state !== "string" ||
    !(moveStates as readonly string[]).includes(state)
  )
    return null;
  const reason = typeof details.reason === "string" ? details.reason : null;
  return { to, state: state as MoveState, reason };
}

export const recordMoveOutcome = internalMutation({
  args: {
    actorUserId: v.id("users"),
    actorEmail: v.string(),
    slug: v.string(),
    to: targetValidator,
    state: v.union(
      v.literal("done"),
      v.literal("refused"),
      v.literal("failed"),
    ),
    reason: v.optional(v.string()),
    copied: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
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
