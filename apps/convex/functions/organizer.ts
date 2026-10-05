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
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { getMembership, requireWorkspaceRole } from "./lib/workspaceAuth";
import { requireUserId } from "./lib/billing/plan";
import { withJev } from "./lib/jev/client";
import { type SweepWhy, askEach } from "./lib/organizer/ask";
import { sweepWhyValidator } from "./lib/schema/organizer";
import {
  NOTICE_GRACE_MS,
  type OrganizerKind,
  organizerRow,
  patchOrganizerRow,
  sweepFinish,
  sweepIsDue,
  organizerAvailable,
} from "./lib/organizer/settings";
import { type OrganizerSuggestion, type OrganizerUndo, type SweepWork, isOrganizing, suggestionFor } from "./lib/organizer/sweepOps";
import { readWhatChanged } from "./lib/organizer/whatChanged";
import { organizerOp, ownerOf } from "./lib/organizer/trip";
import { teamOutlines, unsendRoute } from "./lib/organizer/routeTrips";

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
const fieldValidator = v.union(v.literal("owner"), v.literal("priority"), v.literal("status"));
const moveUndo = v.object({ kind: v.literal("move"), from: v.string(), to: v.string() });
const fieldUndo = v.object({ kind: v.literal("field"), path: v.string(), field: fieldValidator, value: v.string() });
const undoValidator = v.union(
  moveUndo,
  v.object({ kind: v.literal("status"), path: v.string(), value: v.string() }),
  fieldUndo,
  v.object({ kind: v.literal("batch"), undos: v.array(v.union(moveUndo, fieldUndo)) }),
  v.object({ kind: v.literal("sent"), team: v.string(), path: v.string() }),
);
/** A What changed card, for the app: what changed, the sentence that says so, and its steps. */
const changeValidator = v.object({
  id: v.string(),
  topic: v.union(v.literal("people"), v.literal("focus"), v.literal("project")),
  headline: v.string(),
  quote: v.string(),
  source: v.object({ path: v.string(), title: v.string(), kind: v.string() }),
  at: v.number(),
  steps: v.array(
    v.object({
      id: v.string(),
      do: v.union(v.literal("archive"), v.literal("set")),
      path: v.string(),
      title: v.string(),
      about: v.optional(v.union(v.literal("person"), v.literal("project"))),
      field: v.optional(fieldValidator),
      value: v.optional(v.string()),
      was: v.optional(v.string()),
    }),
  ),
});

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
          why: v.optional(sweepWhyValidator),
        }),
      ),
      pending: v.number(),
      /** What changed cards waiting, for the count beside its page. */
      changes: v.number(),
      autopilot: countsValidatorBooleans(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const membership = await getMembership(ctx, args.workspaceId, userId);
    if (membership === null) return null;
    const available = await organizerAvailable(ctx, args.workspaceId);
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
      changes: on ? (row?.changes ?? 0) : 0,
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
      if (await organizerAvailable(ctx, args.workspaceId)) {
        await ctx.scheduler.runAfter(0, internal.functions.organizer.runSweep, { workspaceId: args.workspaceId });
      }
    } else {
      // Off stops sweeps and clears what was waiting; the list is in the
      // bucket, so clearing it is a trip through the barrier.
      await patchOrganizerRow(ctx, args.workspaceId, { off: true, noticeAt: row?.noticeAt ?? now, pending: 0, changes: 0 });
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
    if (!(await organizerAvailable(ctx, args.workspaceId))) return null;
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

export const isOwnerOnPlan = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const membership = await getMembership(ctx, args.workspaceId, args.userId);
    return membership?.role === "owner" && (await organizerAvailable(ctx, args.workspaceId));
  },
});

export const suggestions = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ suggestions: v.array(suggestionValidator), sweptAt: v.union(v.number(), v.null()) }),
  handler: async (ctx, args): Promise<{ suggestions: ReturnType<typeof forApp>[]; sweptAt: number | null }> => {
    const userId = await ownerOf(ctx, args.workspaceId);
    const read = (await organizerOp(ctx, args.workspaceId, userId, { action: "read" })) as {
      suggestions: OrganizerSuggestion[];
      sweptAt: number | null;
    };
    return { suggestions: read.suggestions.filter(isOrganizing).map(forApp), sweptAt: read.sweptAt };
  },
});

/** The What changed cards waiting for the owner, newest first. */
export const changes = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ changes: v.array(changeValidator) }),
  handler: async (ctx, args) => {
    const userId = await ownerOf(ctx, args.workspaceId);
    const read = (await organizerOp(ctx, args.workspaceId, userId, { action: "read" })) as { suggestions: OrganizerSuggestion[] };
    const cards = read.suggestions
      .filter((item) => item.kind === "change" && item.topic && item.source && Array.isArray(item.steps))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .map((item) => ({
        id: item.id,
        topic: item.topic!,
        headline: item.title,
        quote: item.reason ?? "",
        source: { path: item.source!.path, title: item.source!.title, kind: item.source!.kind },
        at: item.at ?? 0,
        steps: item.steps!.map((step) => ({
          id: step.id,
          do: step.do,
          path: step.path,
          title: step.title,
          ...(step.about ? { about: step.about } : {}),
          ...(step.field ? { field: step.field } : {}),
          ...(typeof step.value === "string" ? { value: step.value } : {}),
          ...(typeof step.was === "string" ? { was: step.was } : {}),
        })),
      }));
    return { changes: cards };
  },
});

/** The app's shape: no etag, nothing undefined. */
function forApp(suggestion: OrganizerSuggestion & { kind: OrganizerKind }) {
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
  args: {
    workspaceId: v.id("workspaces"),
    id: v.string(),
    decision: v.union(v.literal("accept"), v.literal("dismiss")),
    /** A change card: the ticked steps. Absent means all of them. */
    steps: v.optional(v.array(v.string())),
  },
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
      input: { id: args.id, decision: args.decision, ...(args.steps ? { steps: args.steps } : {}) },
    })) as { applied: boolean; offer: OrganizerKind | null; pending: number; changes: number; undo: OrganizerUndo | null; error: string | null };
    const autopilot: Record<OrganizerKind, boolean> = await ctx.runMutation(internal.functions.organizer.noteResolved, {
      workspaceId: args.workspaceId,
      userId,
      pending: outcome.pending,
      changes: outcome.changes,
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
    changes: v.optional(v.number()),
    decision: v.union(v.literal("accept"), v.literal("dismiss")),
    applied: v.boolean(),
  },
  returns: countsValidatorBooleans(),
  handler: async (ctx, args) => {
    await patchOrganizerRow(ctx, args.workspaceId, {
      pending: args.pending,
      ...(args.changes === undefined ? {} : { changes: args.changes }),
    });
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
    // A note sent to a team is undone in the team's workspace, not here.
    if (args.token?.kind === "sent") return await unsendRoute(ctx, args.workspaceId, userId, args.token);
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
    return { row, ownerUserId: owner?.userId ?? null, paying: await organizerAvailable(ctx, args.workspaceId) };
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
    const paying = await organizerAvailable(ctx, args.workspaceId);
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
    changes: v.optional(v.number()),
    why: v.optional(sweepWhyValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row: Doc<"organizerSettings"> | null = await organizerRow(ctx, args.workspaceId);
    if (!row?.sweep) return null;
    const now = Date.now();
    const { why: _earlier, ...sweep } = row.sweep;
    await ctx.db.patch(row._id, {
      sweep: {
        ...sweep,
        read: args.read,
        total: args.total,
        ...(args.found ? { found: args.found } : {}),
        ...(args.finished ? { state: args.finished, finishedAt: now } : {}),
        ...(args.finished === "failed" && args.why ? { why: args.why } : {}),
      },
      ...(args.pending === undefined ? {} : { pending: args.pending }),
      ...(args.changes === undefined ? {} : { changes: args.changes }),
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
    let answered = 0;
    let total = 0;
    let why: SweepWhy | null = null;
    try {
      // What changed reads the inbox's arrivals only when its switch, the plan
      // and the day's cap allow, so a refused feature costs no reads.
      const changesGate = await ctx.runQuery(internal.functions.jev.gate, { feature: "whatChanged", workspaceId });
      const work = (await organizerOp(ctx, workspaceId, claim.ownerUserId, {
        action: "gather",
        input: { changes: changesGate.allowed },
      })) as SweepWork;
      // First, before anything is filed away: what the arrivals say changed.
      // A personal workspace's arrivals may be news for its owner's teams too.
      const teams =
        work.changes && work.changes.sources.length > 0 && work.routing
          ? await teamOutlines(ctx, workspaceId, claim.ownerUserId, work.routing)
          : null;
      const changed =
        work.changes && work.changes.sources.length > 0
          ? await withJev(ctx, { feature: "whatChanged", workspaceId }, (jev) => readWhatChanged(jev, work.changes, Date.now(), teams))
          : null;
      total = work.items.length;
      await ctx.runMutation(internal.functions.organizer.sweepProgress, { workspaceId, read, total });

      const found: OrganizerSuggestion[] = [...work.ready];
      // Every question goes through Jev smarts: switched off, over the day's
      // cap or not Premium means no session, and the sweep records only the
      // suggestions that needed no question, and why.
      const asked = await withJev(ctx, { feature: "organizer", workspaceId }, (jev, refusal) =>
        askEach(jev, refusal, work.items, {
          concurrency: DECIDE_CONCURRENCY,
          onAnswer: (item, answers) => {
            const suggestion = suggestionFor(item, work.destinations, answers);
            if (suggestion) found.push(suggestion);
          },
          onRead: async (count) => {
            await ctx.runMutation(internal.functions.organizer.sweepProgress, { workspaceId, read: count, total });
          },
        }),
      );
      read = asked.read;
      answered = asked.answered;
      why = asked.why;

      const recorded = (await organizerOp(ctx, workspaceId, claim.ownerUserId, {
        action: "record",
        input: {
          suggestions: [...found, ...(changed?.found ?? [])],
          ...(changed && changed.readUpTo !== null ? { changesReadUpTo: changed.readUpTo } : {}),
        },
      })) as { pending: number; changes: number };
      let pending = recorded.pending;
      const kinds = (["done", "archive", "file"] as const).filter((kind) => claim.autopilot[kind]);
      if (kinds.length > 0 && pending > 0) {
        await organizerOp(ctx, workspaceId, claim.ownerUserId, { action: "autopilot", input: { kinds }, autopilot: true });
        const after = (await organizerOp(ctx, workspaceId, claim.ownerUserId, { action: "read" })) as { suggestions: OrganizerSuggestion[] };
        pending = after.suggestions.length;
      }
      const counts = { done: 0, archive: 0, file: 0 };
      for (const suggestion of found.filter(isOrganizing)) counts[suggestion.kind] += 1;
      if (changed) {
        console.log(JSON.stringify({ event: "organizer_changes_read", workspaceId, read: changed.read, answered: changed.answered, found: changed.found.length }));
      }
      await ctx.runMutation(internal.functions.organizer.sweepProgress, {
        workspaceId,
        read,
        total,
        finished: sweepFinish(total, answered),
        found: counts,
        pending,
        // Autopilot never applies a change card, so the recorded count stands.
        changes: recorded.changes,
        ...(why ? { why } : {}),
      });
      if (why) console.error(JSON.stringify({ event: "organizer_sweep_unanswered", workspaceId, read, total, why }));
    } catch (error) {
      // Numbers and a code only: the message may quote a path.
      const code = error instanceof ConvexError ? String((error.data as { code?: unknown })?.code ?? "convex") : error instanceof Error ? error.name : "unknown";
      console.error(JSON.stringify({ event: "organizer_sweep_failed", workspaceId, read, total, code }));
      await ctx.runMutation(internal.functions.organizer.sweepProgress, { workspaceId, read, total, finished: "failed", why: "error" });
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
      if (!sweepIsDue(row, await organizerAvailable(ctx, row.workspaceId), now, { ignoreInterval: false })) continue;
      await ctx.scheduler.runAfter(started * SWEEP_STAGGER_MS, internal.functions.organizer.runSweep, {
        workspaceId: row.workspaceId,
      });
      started += 1;
    }
    return started;
  },
});
