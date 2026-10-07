/**
 * Routines: notes that run on a schedule (`docs/decisions/routines.md`).
 *
 * Registrations only; the logic is in `lib/routines/`. The control plane keeps
 * when each routine runs and who it runs as, never what it says or answered.
 */

import { v } from "convex/values";
import { action, internalAction, internalMutation, mutation, query } from "../_generated/server";
import {
  myTimeZoneHandler,
  routineForNoteHandler,
  routineRunsHandler,
  runRoutineNowHandler,
  setMyTimeZoneHandler,
} from "./lib/routines/app";
import {
  commitRoutinesHandler,
  reconcileRoutinesHandler,
  recordRoutineSignalHandler,
  restoreRoutineWritersHandler,
  sweepRoutineWorkspacesHandler,
  takeRoutineWritersHandler,
} from "./lib/routines/sync";
import { claimDueRoutinesHandler, recordRoutineResultHandler } from "./lib/routines/runs";

const cadenceValidator = v.object({
  unit: v.union(v.literal("minute"), v.literal("hour"), v.literal("day"), v.literal("week"), v.literal("month")),
  every: v.number(),
});
const sendValidator = v.union(v.literal("text"), v.literal("note"), v.literal("both"));
const clockValidator = v.object({ hour: v.number(), minute: v.number() });
const writerValidator = v.object({ path: v.string(), userId: v.id("users") });
const scheduleValidator = v.object({
  path: v.string(),
  cadence: cadenceValidator,
  at: v.optional(clockValidator),
  days: v.optional(v.array(v.number())),
  monthDay: v.optional(v.number()),
  timeZone: v.optional(v.string()),
  paused: v.boolean(),
  send: sendValidator,
  to: v.array(v.string()),
});

// ── Keeping the rows a description of the bucket ───────────────────────────

/** A write touched `routines/`: who wrote which paths. Ids and paths only. */
export const recordRoutineSignal = internalMutation({
  args: {
    workspaceId: v.string(),
    userId: v.optional(v.string()),
    actorName: v.optional(v.string()),
    paths: v.array(v.string()),
  },
  returns: v.null(),
  handler: recordRoutineSignalHandler,
});

export const takeRoutineWriters = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(writerValidator),
  handler: takeRoutineWritersHandler,
});

export const restoreRoutineWriters = internalMutation({
  args: { workspaceId: v.id("workspaces"), writers: v.array(writerValidator) },
  returns: v.null(),
  handler: restoreRoutineWritersHandler,
});

export const commitRoutines = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    schedules: v.array(scheduleValidator),
    complete: v.boolean(),
    writers: v.array(writerValidator),
  },
  returns: v.object({ upserted: v.number(), deleted: v.number() }),
  handler: commitRoutinesHandler,
});

export const reconcileRoutines = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => await reconcileRoutinesHandler(ctx, args),
});

/** Every six hours (`crons.ts`): a scan for every workspace with a routine. */
export const sweepRoutineWorkspaces = internalMutation({
  args: {},
  returns: v.number(),
  handler: sweepRoutineWorkspacesHandler,
});

// ── Runs ────────────────────────────────────────────────────────────────────

export const claimDueRoutines = internalMutation({
  args: {
    runIds: v.array(v.string()),
    tokens: v.array(v.object({ hashedAccessToken: v.string(), hashedRefreshToken: v.string() })),
  },
  returns: v.array(
    v.object({
      runId: v.string(),
      token: v.number(),
      path: v.string(),
      timeZone: v.string(),
      send: sendValidator,
      phones: v.array(v.string()),
    }),
  ),
  handler: claimDueRoutinesHandler,
});

export const recordRoutineResult = internalMutation({
  args: { runId: v.string(), outcome: v.string() },
  returns: v.union(v.literal("recorded"), v.literal("unknown")),
  handler: recordRoutineResultHandler,
});

// ── The app ─────────────────────────────────────────────────────────────────

export const routineForNote = query({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      cadence: cadenceValidator,
      at: v.union(clockValidator, v.null()),
      days: v.union(v.array(v.number()), v.null()),
      monthDay: v.union(v.number(), v.null()),
      timeZone: v.union(v.string(), v.null()),
      paused: v.boolean(),
      send: sendValidator,
      to: v.array(v.string()),
      nextRunAt: v.union(v.number(), v.null()),
      lastRunAt: v.union(v.number(), v.null()),
      lastOutcome: v.union(v.string(), v.null()),
      writer: v.union(v.string(), v.null()),
    }),
  ),
  handler: routineForNoteHandler,
});

export const runRoutineNow = mutation({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.boolean(),
  handler: runRoutineNowHandler,
});

export const setMyTimeZone = mutation({
  args: { timeZone: v.string() },
  returns: v.null(),
  handler: setMyTimeZoneHandler,
});

/** The caller's own fallback zone, or null when they have never set one. */
export const myTimeZone = query({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: myTimeZoneHandler,
});

/** A routine's recent runs, newest first, read from the bucket for someone who can see the note. */
export const routineRuns = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.array(v.object({ at: v.number(), outcome: v.string(), text: v.string() })),
  handler: async (ctx, args) => await routineRunsHandler(ctx, args),
});
