/**
 * Keeping the routine rows a description of the bucket.
 *
 * Two ways in, one way through: a signal (the gateway's `/gateway/routines`,
 * or a console write through the barrier) records who wrote which paths and
 * schedules one debounced scan of the workspace's `routines/` folder; the scan
 * reads the files through `runFileOperation`, keeps their schedules, and drops
 * the text. The rows are a derivative: deleting every one of them and running
 * a scan gives back the same schedule, because the folder is the truth.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../../../_generated/server";
import {
  MAX_PATH_LENGTH,
  MAX_ROUTINES_PER_WORKSPACE,
  MAX_SIGNAL_PATHS,
  RECONCILE_AFTER_SIGNAL_MS,
  RECONCILE_STALE_MS,
  ROUTINES_ROOT,
  WRITER_GONE,
  effectiveTimeZone,
  isUnderRoutines,
  nextRunFor,
  scheduleFromNote,
  type RoutineSchedule,
} from "./model";
import { accountTimeZone, userForActorName, workspaceOwner, writingRole } from "./access";

type Writer = { path: string; userId: Id<"users"> };

/** The paths a signal may name: strings under `routines/`, bounded. */
export function routinePathsOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const paths: string[] = [];
  for (const entry of value.slice(0, MAX_SIGNAL_PATHS)) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_PATH_LENGTH) continue;
    if (entry.includes("\0") || entry.split("/").some((part) => part === "..")) continue;
    if (!isUnderRoutines(entry)) continue;
    paths.push(entry.replace(/^\/+/, ""));
  }
  return paths.length === 0 ? null : [...new Set(paths)];
}

/**
 * Note `writer` for these paths and make sure one scan is coming. The writer
 * is kept only if they can write here right now; a member, a stranger and a
 * deleted account are the same as no writer, and the scan still runs.
 */
export async function recordRoutineSignalHandler(
  ctx: MutationCtx,
  args: { workspaceId: string; userId?: string; actorName?: string; paths: string[] },
): Promise<null> {
  const workspaceId = ctx.db.normalizeId("workspaces", args.workspaceId);
  if (workspaceId === null || (await ctx.db.get(workspaceId)) === null) return null;
  const paths = routinePathsOf(args.paths);
  if (paths === null) return null;

  let writer: Id<"users"> | null = null;
  if (args.userId !== undefined) writer = ctx.db.normalizeId("users", args.userId);
  else if (args.actorName !== undefined) writer = await userForActorName(ctx, args.actorName);
  if (writer !== null && (await writingRole(ctx, workspaceId, writer)) === null) writer = null;

  const writers = writer === null ? [] : paths.map((path) => ({ path, userId: writer }));
  await scheduleReconcile(ctx, workspaceId, writers);
  return null;
}

/** One pending scan per workspace; a burst of signals shares it. */
export async function scheduleReconcile(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  writers: Writer[],
): Promise<void> {
  const now = Date.now();
  const pending = await ctx.db
    .query("routineReconciles")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .first();
  if (pending === null) {
    await ctx.db.insert("routineReconciles", { workspaceId, writers, scheduledAt: now });
  } else {
    // Later signals win for a path: the writer is whoever wrote it last.
    const merged = new Map(pending.writers.map((entry) => [entry.path, entry.userId]));
    for (const entry of writers) {
      merged.delete(entry.path);
      merged.set(entry.path, entry.userId);
    }
    const kept = [...merged].slice(-MAX_ROUTINES_PER_WORKSPACE).map(([path, userId]) => ({ path, userId }));
    const stale = now - pending.scheduledAt > RECONCILE_STALE_MS;
    await ctx.db.patch(pending._id, { writers: kept, ...(stale ? { scheduledAt: now } : {}) });
    if (!stale) return;
  }
  await ctx.scheduler.runAfter(RECONCILE_AFTER_SIGNAL_MS, internal.functions.routines.reconcileRoutines, {
    workspaceId,
  });
}

/** Take the pending writers; the next signal schedules a scan of its own. */
export async function takeRoutineWritersHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<Writer[]> {
  const pending = await ctx.db
    .query("routineReconciles")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  const writers = pending.flatMap((row) => row.writers);
  for (const row of pending) await ctx.db.delete(row._id);
  return writers;
}

/** A scan that could not finish: its writers wait for the next one. */
export async function restoreRoutineWritersHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; writers: Writer[] },
): Promise<null> {
  if (args.writers.length === 0) return null;
  const pending = await ctx.db
    .query("routineReconciles")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .first();
  if (pending === null) {
    // Not rescheduled: the safety-net sweep picks up pending rows.
    await ctx.db.insert("routineReconciles", {
      workspaceId: args.workspaceId,
      writers: args.writers,
      scheduledAt: Date.now(),
    });
  } else {
    const known = new Set(pending.writers.map((entry) => entry.path));
    const older = args.writers.filter((entry) => !known.has(entry.path));
    await ctx.db.patch(pending._id, { writers: [...older, ...pending.writers] });
  }
  return null;
}

/** The scan's answer: every routine file it read, and whether the listing was whole. */
export interface RoutineScan {
  schedules: RoutineSchedule[];
  complete: boolean;
}

const OWNER_CLEARANCE = { scope: "private" as const, grantedNames: [] as string[] };

/**
 * List `routines/<folder>/` and read each `.md` directly inside, at the
 * owner's clearance: the scan only learns *when*. Whether the writer may see
 * the note is asked by the gateway when it runs (`read_note` on the writer's
 * own grant), so a scan reading more than the writer could never lets them
 * run more.
 */
export async function scanRoutines(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<RoutineScan> {
  const list = async (path: string) => {
    const listing = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      ...OWNER_CLEARANCE,
      operation: { kind: "list", path },
    });
    if (listing.kind !== "listing") throw new Error("routine listing returned an invalid result");
    return listing;
  };
  const root = await list(ROUTINES_ROOT);
  let complete = !root.truncated;
  const files: string[] = [];
  for (const folder of root.entries) {
    if (folder.kind !== "folder") continue;
    const inner = await list(folder.path);
    if (inner.truncated) complete = false;
    for (const entry of inner.entries) {
      if (entry.kind === "file" && /\.md$/i.test(entry.path)) files.push(entry.path);
    }
    if (files.length > MAX_ROUTINES_PER_WORKSPACE) {
      complete = false;
      break;
    }
  }

  const schedules: RoutineSchedule[] = [];
  let pending = files.slice(0, MAX_ROUTINES_PER_WORKSPACE).filter((path) => scheduleFromNote(path, "") !== null);
  for (let attempt = 0; pending.length > 0 && attempt < 10; attempt += 1) {
    const batch = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      ...OWNER_CLEARANCE,
      operation: { kind: "readMany", paths: pending.slice(0, 25) },
    });
    if (batch.kind !== "notes") throw new Error("routine read returned an invalid result");
    const deferred: string[] = [];
    for (const result of batch.results) {
      if (result.outcome === "deferred") {
        deferred.push(result.path);
        continue;
      }
      // Gone between listing and read: not a routine any more.
      if (result.outcome !== "read") continue;
      const schedule = scheduleFromNote(result.path, result.note.text);
      if (schedule !== null) schedules.push(schedule);
    }
    pending = [...deferred, ...pending.slice(25)];
  }
  if (pending.length > 0) complete = false;
  return { schedules, complete };
}

/**
 * Make the rows say what the scan found. Upserts every routine read, deletes
 * a row whose file is gone only when the listing was whole, keeps each row's
 * last run, and picks the writer: the signal's if they can still write, else
 * the row's if they can still write, else — only for a routine with no row
 * yet — the workspace's owner, marked `fallback` so its `to:` is ignored
 * and only the owner is texted. A row whose writer has gone is left not
 * running (`writer_gone`) until someone who can write saves it: handing it to
 * the owner would run an editor's words with the owner's private reach.
 */
export async function commitRoutinesHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    schedules: RoutineSchedule[];
    complete: boolean;
    writers: Writer[];
  },
): Promise<{ upserted: number; deleted: number }> {
  if ((await ctx.db.get(args.workspaceId)) === null) return { upserted: 0, deleted: 0 };
  const now = Date.now();
  const existing = await ctx.db
    .query("routines")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId))
    .take(MAX_ROUTINES_PER_WORKSPACE * 2);
  const byPath = new Map(existing.map((row) => [row.path, row]));
  const signalled = new Map(args.writers.map((entry) => [entry.path, entry.userId]));
  const found = new Set<string>();
  let upserted = 0;
  let owner: Id<"users"> | null | undefined;

  for (const schedule of args.schedules.slice(0, MAX_ROUTINES_PER_WORKSPACE)) {
    found.add(schedule.path);
    const row = byPath.get(schedule.path);
    let writer: Id<"users"> | null = null;
    let writerSource: "signal" | "fallback" = "fallback";
    const fromSignal = signalledWriter(signalled, schedule.path);
    if (fromSignal !== undefined && (await writingRole(ctx, args.workspaceId, fromSignal)) !== null) {
      writer = fromSignal;
      writerSource = "signal";
    } else if (row !== undefined) {
      writer = (await writingRole(ctx, args.workspaceId, row.writerUserId)) === null ? null : row.writerUserId;
      writerSource = row.writerSource;
    } else {
      if (owner === undefined) owner = await workspaceOwner(ctx, args.workspaceId);
      writer = owner;
    }

    const fields = scheduleFields(schedule);
    if (writer === null) {
      if (row === undefined) continue; // No owner at all: nothing can run it.
      await ctx.db.patch(row._id, { ...fields, nextRunAt: null, lastOutcome: WRITER_GONE, updatedAt: now });
      upserted += 1;
      continue;
    }
    const zone = effectiveTimeZone(schedule.timeZone, await accountTimeZone(ctx, writer));
    const nextRunAt = nextRunFor(schedule, zone, now);
    if (row === undefined) {
      await ctx.db.insert("routines", {
        workspaceId: args.workspaceId,
        ...fields,
        writerUserId: writer,
        writerSource,
        nextRunAt,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(row._id, {
        ...fields,
        writerUserId: writer,
        writerSource,
        nextRunAt,
        ...(row.lastOutcome === WRITER_GONE ? { lastOutcome: undefined } : {}),
        updatedAt: now,
      });
    }
    upserted += 1;
  }

  let deleted = 0;
  if (args.complete) {
    for (const row of existing) {
      if (found.has(row.path)) continue;
      await ctx.db.delete(row._id);
      deleted += 1;
    }
  }
  return { upserted, deleted };
}

/**
 * The writer a signal named for this path: the path itself, else the nearest
 * folder above it that a signal named (a folder moved or renamed by someone).
 */
function signalledWriter(signalled: Map<string, Id<"users">>, path: string): Id<"users"> | undefined {
  const exact = signalled.get(path);
  if (exact !== undefined) return exact;
  let best: { length: number; userId: Id<"users"> } | undefined;
  for (const [named, userId] of signalled) {
    const folder = named.replace(/\/+$/, "");
    if (!path.startsWith(`${folder}/`)) continue;
    if (best === undefined || folder.length > best.length) best = { length: folder.length, userId };
  }
  return best?.userId;
}

/** The stored half of a schedule: every optional field set or cleared. */
function scheduleFields(schedule: RoutineSchedule): Omit<
  Doc<"routines">,
  "_id" | "_creationTime" | "workspaceId" | "writerUserId" | "writerSource" | "nextRunAt" | "updatedAt"
> {
  return {
    path: schedule.path,
    cadence: schedule.cadence,
    at: schedule.at,
    days: schedule.days,
    monthDay: schedule.monthDay,
    timeZone: schedule.timeZone,
    paused: schedule.paused,
    send: schedule.send,
    to: schedule.to,
  };
}

/** The scan and the commit, for one workspace. Never throws: a failed scan waits for the next. */
export async function reconcileRoutinesHandler(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<null> {
  const writers: Writer[] = await ctx.runMutation(internal.functions.routines.takeRoutineWriters, args);
  let scan: RoutineScan;
  try {
    scan = await scanRoutines(ctx, args.workspaceId);
  } catch {
    // No bucket, an unreachable one, a listing that went wrong: change nothing.
    await ctx.runMutation(internal.functions.routines.restoreRoutineWriters, { ...args, writers });
    return null;
  }
  await ctx.runMutation(internal.functions.routines.commitRoutines, {
    workspaceId: args.workspaceId,
    schedules: scan.schedules,
    complete: scan.complete,
    writers,
  });
  return null;
}

/** The safety net: re-scan every workspace that has a routine or a pending scan. */
export async function sweepRoutineWorkspacesHandler(ctx: MutationCtx): Promise<number> {
  const workspaces = new Set<Id<"workspaces">>();
  for (const row of await ctx.db.query("routineReconciles").take(200)) workspaces.add(row.workspaceId);
  for (const row of await ctx.db.query("routines").withIndex("by_workspace_path").take(4000)) {
    if (workspaces.size >= 200) break;
    workspaces.add(row.workspaceId);
  }
  let index = 0;
  for (const workspaceId of workspaces) {
    // Spread out, so a sweep is not two hundred bucket listings at once.
    await ctx.scheduler.runAfter(index * 3_000, internal.functions.routines.reconcileRoutines, {
      workspaceId,
    });
    index += 1;
  }
  return workspaces.size;
}
