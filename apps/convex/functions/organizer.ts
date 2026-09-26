/**
 * Auto-organize: Premium's standing tidy-up, on unless the owner switches it off.
 *
 * Once a day it reads the owner's projects and inbox, asks Jev a few typed
 * questions about each (is this finished? where does this note belong?), and
 * leaves suggestions: mark a project done, archive a closed one gone quiet,
 * file an inbox note. The owner accepts or dismisses each, or lets a kind of
 * change happen "without asking".
 *
 * Where everything lives, which is the part a reviewer should check:
 *
 *  - Note text leaves the bucket only inside a sweep, for one Workers AI call
 *    that keeps nothing (docs/decisions/storage-and-credentials/inference.md).
 *  - The suggestions name notes, so they are written to the customer's own
 *    bucket (`.context/organizer/state.json`), never to this database.
 *  - This database holds `organizerSettings`: switches and counters.
 *
 * Only the owner sees any of it in v1. Every public function here checks the
 * owner role itself; every file operation goes through the one credential
 * barrier (`files.runFileOperation`) at the owner's own clearance.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  type ActionCtx,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import type { OperationResult } from "./lib/filesFns/operationTypes";
import { getMembership, requireWorkspaceRole } from "./lib/workspaceAuth";
import { requireUserId } from "./lib/billing/plan";
import { decideClientFor, eachLimited } from "./lib/organizer/decideClient";
import {
  NOTICE_GRACE_MS,
  type OrganizerKind,
  organizerRow,
  patchOrganizerRow,
  sweepIsDue,
  workspaceIsPaying,
} from "./lib/organizer/settings";
import type { OrganizerSuggestion, OrganizerUndo, SweepWork } from "./lib/organizer/sweepOps";
import { doneSuggestion, fileSuggestion } from "../../mcp/src/organizer/suggest.js";

const kindValidator = v.union(v.literal("done"), v.literal("archive"), v.literal("file"));
const countsValidator = v.object({ done: v.number(), archive: v.number(), file: v.number() });
const suggestionValidator = v.object({
  id: v.string(),
  kind: kindValidator,
  path: v.string(),
  title: v.string(),
  reason: v.string(),
  target: v.optional(v.object({ path: v.string(), title: v.string() })),
  status: v.optional(v.string()),
});
const undoValidator = v.union(
  v.object({ kind: v.literal("move"), from: v.string(), to: v.string() }),
  v.object({ kind: v.literal("status"), path: v.string(), value: v.string() }),
);

/** Questions in flight at once, per sweep. */
const DECIDE_CONCURRENCY = 4;
/** How many due workspaces one run of the schedule starts. */
const SWEEPS_PER_TICK = 50;
/** Spacing between the sweeps one tick starts, so they do not all land at once. */
const SWEEP_STAGGER_MS = 20_000;

/* -------------------------------------------------------------------------- */
/*                                   reading                                  */
/* -------------------------------------------------------------------------- */

export const status = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      available: v.boolean(),
      isOwner: v.boolean(),
      on: v.boolean(),
      noticeNeeded: v.boolean(),
      startsAt: v.union(v.number(), v.null()),
      sweep: v.union(
        v.null(),
        v.object({
          state: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
          startedAt: v.number(),
          finishedAt: v.union(v.number(), v.null()),
          read: v.number(),
          total: v.number(),
          found: countsValidator,
        }),
      ),
      pending: v.number(),
      autopilot: countsValidatorBooleans(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const membership = await getMembership(ctx, args.workspaceId, userId);
    if (membership === null) return null;
    const available = await workspaceIsPaying(ctx, args.workspaceId);
    const isOwner = membership.role === "owner";
    // A member who is not the owner learns only that it exists on this plan.
    const row = isOwner ? await organizerRow(ctx, args.workspaceId) : null;
    const on = available && row?.off !== true;
    return {
      available,
      isOwner,
      on,
      noticeNeeded: isOwner && available && row === null,
      startsAt: on ? (row?.startsAt ?? null) : null,
      sweep: row?.sweep ?? null,
      pending: on ? (row?.pending ?? 0) : 0,
      autopilot: row?.autopilot ?? { done: false, archive: false, file: false },
    };
  },
});

function countsValidatorBooleans() {
  return v.object({ done: v.boolean(), archive: v.boolean(), file: v.boolean() });
}

/* -------------------------------------------------------------------------- */
/*                                  switches                                  */
/* -------------------------------------------------------------------------- */

async function requireOwner(ctx: Parameters<typeof requireUserId>[0], workspaceId: Id<"workspaces">) {
  const userId = await requireUserId(ctx);
  await requireWorkspaceRole(ctx, workspaceId, userId, "owner");
  return userId;
}

export const setEnabled = mutation({
  args: { workspaceId: v.id("workspaces"), on: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireOwner(ctx, args.workspaceId);
    const now = Date.now();
    const row = await organizerRow(ctx, args.workspaceId);
    if (args.on) {
      await patchOrganizerRow(ctx, args.workspaceId, {
        off: false,
        noticeAt: row?.noticeAt ?? now,
        startsAt: row?.startsAt ?? now,
      });
      if (await workspaceIsPaying(ctx, args.workspaceId)) {
        await ctx.scheduler.runAfter(0, internal.functions.organizer.runSweep, { workspaceId: args.workspaceId });
      }
    } else {
      // Off stops sweeps and clears what was waiting; the list is in the
      // bucket, so clearing it is a trip through the barrier.
      await patchOrganizerRow(ctx, args.workspaceId, { off: true, noticeAt: row?.noticeAt ?? now, pending: 0 });
      await ctx.scheduler.runAfter(0, internal.functions.organizer.clearPending, { workspaceId: args.workspaceId, userId });
    }
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: args.on ? "organizer.on" : "organizer.off",
    });
    return null;
  },
});

export const acknowledgeNotice = mutation({
  args: { workspaceId: v.id("workspaces"), turnOff: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireOwner(ctx, args.workspaceId);
    const now = Date.now();
    if (args.turnOff === true) {
      await patchOrganizerRow(ctx, args.workspaceId, { off: true, noticeAt: now });
    } else {
      const startsAt = now + NOTICE_GRACE_MS;
      await patchOrganizerRow(ctx, args.workspaceId, { off: false, noticeAt: now, startsAt });
      await ctx.scheduler.runAt(startsAt, internal.functions.organizer.runSweep, { workspaceId: args.workspaceId });
    }
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: args.turnOff === true ? "organizer.off" : "organizer.notice_seen",
    });
    return null;
  },
});

export const setAutopilot = mutation({
  args: { workspaceId: v.id("workspaces"), kind: kindValidator, on: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireOwner(ctx, args.workspaceId);
    const row = await organizerRow(ctx, args.workspaceId);
    const autopilot = { ...(row?.autopilot ?? { done: false, archive: false, file: false }), [args.kind]: args.on };
    await patchOrganizerRow(ctx, args.workspaceId, { autopilot });
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "organizer.autopilot",
      details: { kind: args.kind, on: args.on },
    });
    return null;
  },
});

/** "Look now", and the payment return's first sweep. */
export const sweepNow = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.workspaceId);
    if (!(await workspaceIsPaying(ctx, args.workspaceId))) return null;
    const row = await organizerRow(ctx, args.workspaceId);
    if (row?.off === true) return null;
    if (!row || row.startsAt === undefined || row.startsAt > Date.now()) {
      // Pressing it is being told: the owner is looking at the feature.
      const now = Date.now();
      await patchOrganizerRow(ctx, args.workspaceId, { noticeAt: row?.noticeAt ?? now, startsAt: now });
    }
    await ctx.scheduler.runAfter(0, internal.functions.organizer.runSweep, { workspaceId: args.workspaceId, force: true });
    return null;
  },
});

/* -------------------------------------------------------------------------- */
/*                         suggestions, through the barrier                   */
/* -------------------------------------------------------------------------- */

type OrganizerAction = "gather" | "record" | "read" | "resolve" | "clear" | "autopilot" | "undo";

/** One trip through the barrier at the owner's clearance. */
async function organizerOp(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  actorUserId: Id<"users">,
  op: { action: OrganizerAction; input?: unknown; autopilot?: boolean },
): Promise<unknown> {
  const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId,
    minimum: "owner",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId,
    scope,
    grantedNames,
    actorName,
    operation: {
      kind: "organizer",
      action: op.action,
      input: JSON.stringify(op.input ?? {}),
      ...(op.autopilot === true ? { autopilot: true } : {}),
    },
  })) as OperationResult;
  if (result.kind !== "organizerResult") throw new ConvexError({ code: "ORGANIZER_FAILED", message: "Auto-organize couldn't reach your notes." });
  return JSON.parse(result.output) as unknown;
}

/** Owner check for an action, which cannot read the database itself. */
async function ownerOf(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Sign in first." });
  const allowed = await ctx.runQuery(internal.functions.organizer.isOwnerOnPlan, { workspaceId, userId });
  if (!allowed) throw new ConvexError({ code: "INSUFFICIENT_ROLE", message: "Only the owner can do this." });
  return userId;
}

export const isOwnerOnPlan = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    return membership?.role === "owner" && (await workspaceIsPaying(ctx, args.workspaceId));
  },
});

export const suggestions = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ suggestions: v.array(suggestionValidator), sweptAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, args): Promise<{ suggestions: OrganizerSuggestion[]; sweptAt: number | null }> => {
    const userId = await ownerOf(ctx, args.workspaceId);
    const read = (await organizerOp(ctx, args.workspaceId, userId, { action: "read" })) as {
      suggestions: OrganizerSuggestion[];
      sweptAt: number | null;
    };
    return { suggestions: read.suggestions.map(forApp), sweptAt: read.sweptAt };
  },
});

/** The app's shape: no etag, nothing undefined. */
function forApp(suggestion: OrganizerSuggestion) {
  return {
    id: suggestion.id,
    kind: suggestion.kind,
    path: suggestion.path,
    title: suggestion.title,
    reason: suggestion.reason ?? "",
    ...(suggestion.target ? { target: { path: suggestion.target.path, title: suggestion.target.title } } : {}),
    ...(typeof suggestion.status === "string" ? { status: suggestion.status } : {}),
  };
}

export const resolve = action({
  args: { workspaceId: v.id("workspaces"), id: v.string(), decision: v.union(v.literal("accept"), v.literal("dismiss")) },
  returns: v.object({
    applied: v.boolean(),
    offer: v.union(kindValidator, v.null()),
    undo: v.union(undoValidator, v.null()),
    error: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ applied: boolean; offer: OrganizerKind | null; undo: OrganizerUndo | null; error?: string }> => {
    const userId = await ownerOf(ctx, args.workspaceId);
    const outcome = (await organizerOp(ctx, args.workspaceId, userId, {
      action: "resolve",
      input: { id: args.id, decision: args.decision },
    })) as { applied: boolean; offer: OrganizerKind | null; pending: number; undo: OrganizerUndo | null; error: string | null };
    const autopilot: Record<OrganizerKind, boolean> = await ctx.runMutation(internal.functions.organizer.noteResolved, {
      workspaceId: args.workspaceId,
      userId,
      pending: outcome.pending,
      decision: args.decision,
      applied: outcome.applied,
    });
    return {
      applied: outcome.applied,
      // Offering what is already on would be asking twice.
      offer: outcome.offer !== null && !autopilot[outcome.offer] ? outcome.offer : null,
      undo: outcome.undo,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  },
});

export const noteResolved = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    pending: v.number(),
    decision: v.union(v.literal("accept"), v.literal("dismiss")),
    applied: v.boolean(),
  },
  returns: countsValidatorBooleans(),
  handler: async (ctx, args) => {
    await patchOrganizerRow(ctx, args.workspaceId, { pending: args.pending });
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId: args.userId,
      action: args.decision === "accept" ? "organizer.accept" : "organizer.dismiss",
      details: { applied: args.applied },
    });
    const row = await organizerRow(ctx, args.workspaceId);
    return row?.autopilot ?? { done: false, archive: false, file: false };
  },
});

export const undo = action({
  args: {
    workspaceId: v.id("workspaces"),
    token: v.optional(undoValidator),
    entry: v.optional(v.object({ at: v.string(), kind: v.string(), paths: v.array(v.string()) })),
  },
  returns: v.object({ applied: v.boolean(), error: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const userId = await ownerOf(ctx, args.workspaceId);
    const outcome = (await organizerOp(ctx, args.workspaceId, userId, {
      action: "undo",
      input: { ...(args.token ? { token: args.token } : {}), ...(args.entry ? { entry: args.entry } : {}) },
    })) as { applied: boolean; error?: string };
    return { applied: outcome.applied, ...(outcome.error ? { error: outcome.error } : {}) };
  },
});

export const clearPending = internalAction({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Re-asked now: switched back on in between means there is nothing to clear.
    const row = await ctx.runQuery(internal.functions.organizer.sweepRow, { workspaceId: args.workspaceId });
    if (row?.row?.off !== true || row.ownerUserId === null) return null;
    await organizerOp(ctx, args.workspaceId, row.ownerUserId, { action: "clear" });
    return null;
  },
});

/* -------------------------------------------------------------------------- */
/*                                   sweeping                                 */
/* -------------------------------------------------------------------------- */

export const sweepRow = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.object({ row: v.any(), ownerUserId: v.union(v.id("users"), v.null()), paying: v.boolean() })),
  handler: async (ctx, args) => {
    const row = await organizerRow(ctx, args.workspaceId);
    const owner = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .filter((q) => q.eq(q.field("role"), "owner"))
      .first();
    return { row, ownerUserId: owner?.userId ?? null, paying: await workspaceIsPaying(ctx, args.workspaceId) };
  },
});

/**
 * Claim the sweep, re-asking everything that could have changed since it was
 * scheduled: still paying, still on, past the notice, not already running.
 */
export const beginSweep = internalMutation({
  args: { workspaceId: v.id("workspaces"), force: v.optional(v.boolean()) },
  returns: v.union(
    v.null(),
    v.object({ ownerUserId: v.id("users"), autopilot: countsValidatorBooleans() }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await organizerRow(ctx, args.workspaceId);
    const paying = await workspaceIsPaying(ctx, args.workspaceId);
    if (!row || !sweepIsDue(row, paying, now, { ignoreInterval: args.force === true })) return null;
    const owner = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .filter((q) => q.eq(q.field("role"), "owner"))
      .first();
    if (!owner) return null;
    await ctx.db.patch(row._id, {
      sweep: { state: "running", startedAt: now, finishedAt: null, read: 0, total: 0, found: { done: 0, archive: 0, file: 0 } },
      updatedAt: now,
    });
    return { ownerUserId: owner.userId, autopilot: row.autopilot };
  },
});

export const sweepProgress = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    read: v.number(),
    total: v.number(),
    finished: v.optional(v.union(v.literal("done"), v.literal("failed"))),
    found: v.optional(countsValidator),
    pending: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row: Doc<"organizerSettings"> | null = await organizerRow(ctx, args.workspaceId);
    if (!row?.sweep) return null;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      sweep: {
        ...row.sweep,
        read: args.read,
        total: args.total,
        ...(args.found ? { found: args.found } : {}),
        ...(args.finished ? { state: args.finished, finishedAt: now } : {}),
      },
      ...(args.pending === undefined ? {} : { pending: args.pending }),
      updatedAt: now,
    });
    return null;
  },
});

export const runSweep = internalAction({
  args: { workspaceId: v.id("workspaces"), force: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(internal.functions.organizer.beginSweep, args);
    if (!claim) return null;
    const { workspaceId } = args;
    let read = 0;
    let total = 0;
    try {
      const work = (await organizerOp(ctx, workspaceId, claim.ownerUserId, { action: "gather" })) as SweepWork;
      total = work.items.length;
      await ctx.runMutation(internal.functions.organizer.sweepProgress, { workspaceId, read, total });

      const found: OrganizerSuggestion[] = [...work.ready];
      const client = await decideClientFor(workspaceId);
      if (client) {
        await eachLimited(work.items, DECIDE_CONCURRENCY, async (item) => {
          const answers = await client.decide(item.request);
          read += 1;
          if (answers) {
            const suggestion =
              item.kind === "project"
                ? doneSuggestion(item.project, item.facts, answers)
                : fileSuggestion(item.note, item.title, work.destinations, answers);
            if (suggestion) found.push(suggestion as OrganizerSuggestion);
          }
          if (read % 10 === 0) {
            await ctx.runMutation(internal.functions.organizer.sweepProgress, { workspaceId, read, total });
          }
        });
      }

      const recorded = (await organizerOp(ctx, workspaceId, claim.ownerUserId, {
        action: "record",
        input: { suggestions: found },
      })) as { pending: number };
      let pending = recorded.pending;
      const kinds = (["done", "archive", "file"] as const).filter((kind) => claim.autopilot[kind]);
      if (kinds.length > 0 && pending > 0) {
        await organizerOp(ctx, workspaceId, claim.ownerUserId, { action: "autopilot", input: { kinds }, autopilot: true });
        pending = ((await organizerOp(ctx, workspaceId, claim.ownerUserId, { action: "read" })) as { suggestions: unknown[] }).suggestions.length;
      }
      const counts = { done: 0, archive: 0, file: 0 };
      for (const suggestion of found) counts[suggestion.kind] += 1;
      await ctx.runMutation(internal.functions.organizer.sweepProgress, {
        workspaceId,
        read,
        total,
        finished: "done",
        found: counts,
        pending,
      });
    } catch (error) {
      // Numbers only: the error may quote a path.
      console.error(JSON.stringify({ event: "organizer_sweep_failed", workspaceId, read, total }));
      await ctx.runMutation(internal.functions.organizer.sweepProgress, { workspaceId, read, total, finished: "failed" });
      if (!(error instanceof ConvexError)) return null;
    }
    return null;
  },
});

/** The hourly schedule: start every sweep that is due, a few at a time. */
export const scheduleDueSweeps = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("organizerSettings")
      .withIndex("by_startsAt", (q) => q.lte("startsAt", now))
      .take(SWEEPS_PER_TICK * 4);
    let started = 0;
    for (const row of rows) {
      if (started >= SWEEPS_PER_TICK) break;
      if (row.startsAt === undefined) continue;
      if (!sweepIsDue(row, await workspaceIsPaying(ctx, row.workspaceId), now, { ignoreInterval: false })) continue;
      await ctx.scheduler.runAfter(started * SWEEP_STAGGER_MS, internal.functions.organizer.runSweep, {
        workspaceId: row.workspaceId,
      });
      started += 1;
    }
    return started;
  },
});
