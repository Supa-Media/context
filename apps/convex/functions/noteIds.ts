/**
 * The id copy's staff surface and its cron (`lib/noteIds/`, phase "copy" of
 * the move from path keys to id keys). Shown in admin beside the tree
 * migration. Asked for in the same shape as `nodesMigration.ts`: counts,
 * times and fixed labels only, never a path or a note's name.
 *
 * Every public function checks staff first. Starting work only schedules an
 * internal function, which is what the structure tests allow a public
 * function to do with a bucket-reaching one.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx } from "../_generated/server";
import { convexNodeTable } from "./lib/nodes/convexTable";
import { copyIsFresh, idKeyFor } from "./lib/nodes/noteIds";
import { applyObservation } from "./lib/nodes/observe";
import { workspaceArchived } from "./lib/archivedWorkspaces";
import { isPlumbing } from "./lib/privacy";
import { keyedWorkspace } from "./lib/noteIds/keyedState";
import { beginCopyPass, copyRowOf, ensureCopyRow, idCopyPaused, leaseHeld, nodeAt } from "./lib/noteIds/state";
import { boundWorkspaces, liveBoundWorkspaces, staffOnly } from "./nodesMigration";

const statusValidator = v.union(v.literal("idle"), v.literal("copying"), v.literal("done"), v.literal("failed"));
const diagnosisValidator = v.object({
  checkedAt: v.number(),
  checked: v.number(),
  missing: v.number(),
  differs: v.number(),
});

const rowValidator = v.object({
  workspaceId: v.id("workspaces"),
  /** The workspace's slug, or null when it has none. */
  handle: v.union(v.string(), v.null()),
  files: v.number(),
  copied: v.number(),
  failed: v.number(),
  status: statusValidator,
  /** A fixed, path-free label. */
  error: v.union(v.string(), v.null()),
  diagnosis: v.union(v.null(), diagnosisValidator),
  /** Why files failed: a fixed reason per note id, no paths (the first few the copy kept). */
  failures: v.array(v.object({ noteId: v.string(), reason: v.string() })),
  /** Keys mode only (0 otherwise): files the last copy pass counted, and how many rows the flip has keyed (`notes/` only). */
  liveFiles: v.number(),
  keyed: v.number(),
  /** When the workspace's flip to keyed rows started, and when it found none left; null until then. */
  keyedAt: v.union(v.null(), v.number()),
  keyedDoneAt: v.union(v.null(), v.number()),
  /** Held by an archived account: not counted by the switch to keys (`setMode`), which checks live workspaces only. */
  archived: v.boolean(),
});

/** Where the id copy is, for every workspace with storage. Counts and labels only. */
export const report = query({
  args: {},
  returns: v.object({
    paused: v.boolean(),
    mode: v.union(v.literal("paths"), v.literal("ids"), v.literal("keys")),
    totals: v.object({ files: v.number(), copied: v.number(), failed: v.number(), liveFiles: v.number(), keyed: v.number() }),
    workspaces: v.array(rowValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    await staffOnly(ctx);
    const layout = await ctx.db.query("noteIdLayout").first();
    const { ids, truncated } = await boundWorkspaces(ctx);
    const totals = { files: 0, copied: 0, failed: 0, liveFiles: 0, keyed: 0 };
    const workspaces: Array<{
      workspaceId: Id<"workspaces">;
      handle: string | null;
      files: number;
      copied: number;
      failed: number;
      status: "idle" | "copying" | "done" | "failed";
      error: string | null;
      diagnosis: { checkedAt: number; checked: number; missing: number; differs: number } | null;
      failures: { noteId: string; reason: string }[];
      liveFiles: number;
      keyed: number;
      keyedAt: number | null;
      keyedDoneAt: number | null;
      archived: boolean;
    }> = [];
    for (const workspaceId of ids) {
      const workspace = await ctx.db.get(workspaceId);
      if (workspace === null) continue;
      const row = await copyRowOf(ctx.db, workspaceId);
      const counts = { files: row?.files ?? 0, copied: row?.copied ?? 0, failed: row?.failed ?? 0 };
      // Keys mode only: the copy pass's file count, and the flip's own counter (never a read of the tree).
      const keys = layout?.mode === "keys" ? { liveFiles: counts.files, keyed: row?.flipped ?? 0 } : { liveFiles: 0, keyed: 0 };
      totals.files += counts.files;
      totals.copied += counts.copied;
      totals.failed += counts.failed;
      totals.liveFiles += keys.liveFiles;
      totals.keyed += keys.keyed;
      workspaces.push({
        workspaceId,
        handle: workspace.slug ?? null,
        ...counts,
        status: row?.status ?? "idle",
        error: row?.error ?? null,
        diagnosis: row?.diagnosis ?? null,
        failures: (row?.failures ?? []).slice(0, 5).map(({ noteId, reason }) => ({ noteId, reason })),
        ...keys,
        keyedAt: row?.keyedAt ?? null,
        keyedDoneAt: row?.keyedDoneAt ?? null,
        archived: await workspaceArchived(ctx.db, workspaceId),
      });
    }
    return { paused: layout?.paused === true, mode: layout?.mode ?? "paths", totals, workspaces, truncated };
  },
});

/** Refused while paused: a paused switch stops new work, and starting is new work. */
async function refuseWhenPaused(ctx: MutationCtx): Promise<void> {
  if (await idCopyPaused(ctx.db)) {
    throw new ConvexError({ code: "NOTE_IDS_PAUSED", message: "The id copy is paused. Resume it first." });
  }
}

/** Start the id copy for every live workspace whose pass is not already running. */
export const startAll = mutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    await staffOnly(ctx);
    await refuseWhenPaused(ctx);
    let started = 0;
    for (const workspaceId of await liveBoundWorkspaces(ctx)) {
      await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.backfill, { workspaceId });
      if (await beginCopyPass(ctx, workspaceId, { force: false })) started += 1;
    }
    return { started };
  },
});

/** Start the id copy for one workspace (archived ones too: one's own button reaches them). */
export const start = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
    await refuseWhenPaused(ctx);
    await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.backfill, { workspaceId });
    return { started: (await beginCopyPass(ctx, workspaceId, { force: false })) ? 1 : 0 };
  },
});

/** Start the id copy again from the beginning, whatever it was doing: a new run, the failures cleared. */
export const restart = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
    await refuseWhenPaused(ctx);
    await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.backfill, { workspaceId });
    return { started: (await beginCopyPass(ctx, workspaceId, { force: true })) ? 1 : 0 };
  },
});

/**
 * Stop or resume the id copy. Stopping takes effect at each page's next
 * record. Resuming starts a fresh pass for every workspace whose pass was
 * stopped, so nothing left half-way is missed.
 */
export const setPaused = mutation({
  args: { paused: v.boolean() },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { paused }) => {
    const userId = await staffOnly(ctx);
    const existing = await ctx.db.query("noteIdLayout").first();
    const fields = { paused, updatedAt: Date.now(), updatedBy: String(userId) };
    if (existing === null) await ctx.db.insert("noteIdLayout", { mode: "paths", ...fields });
    else await ctx.db.patch(existing._id, fields);
    if (paused) return { started: 0 };
    let started = 0;
    for (const workspaceId of await liveBoundWorkspaces(ctx)) {
      const row = await copyRowOf(ctx.db, workspaceId);
      if (row?.status === "copying" && (await beginCopyPass(ctx, workspaceId, { force: false }))) started += 1;
    }
    return { started };
  },
});

/** Whether a copy row says its workspace is fully copied: the pass done, every file copied, none failed. */
function copyComplete(row: { status: string; files: number; copied: number; failed: number } | null): boolean {
  return row !== null && row.status === "done" && row.failed === 0 && row.copied === row.files;
}

/**
 * The gate to keys: every live bound workspace must be fully copied. Archived
 * ones are left out, as the rest of the id copy leaves them out. `truncated`
 * means the bindings were more than one read covers, so the gate cannot see them all.
 */
async function copyGate(ctx: MutationCtx): Promise<{ notReady: number; truncated: boolean; live: Id<"workspaces">[] }> {
  const { ids, truncated } = await boundWorkspaces(ctx);
  const live: Id<"workspaces">[] = [];
  let notReady = 0;
  for (const workspaceId of ids) {
    if (await workspaceArchived(ctx.db, workspaceId)) continue;
    live.push(workspaceId);
    if (!copyComplete(await copyRowOf(ctx.db, workspaceId))) notReady += 1;
  }
  return { notReady, truncated, live };
}

/**
 * The switch between path keys, id keys and keyed rows: which keys reads use.
 * Staff only, and allowed while the copy is paused, since choosing the keys is
 * not new copy work. The gateway learns it from `/gateway/binding`'s `idLayout`.
 *
 * `keys` is the final switch: it is reached only from `ids`, and only once every
 * live bound workspace is fully copied (`copyGate`). It schedules the flip for
 * each live workspace at once. Once the switch is at `keys` it is one-way: any
 * other mode is refused, and the row stays as it was.
 */
export const setMode = mutation({
  args: { mode: v.union(v.literal("paths"), v.literal("ids"), v.literal("keys")) },
  returns: v.object({ mode: v.union(v.literal("paths"), v.literal("ids"), v.literal("keys")) }),
  handler: async (ctx, { mode }) => {
    const userId = await staffOnly(ctx);
    const existing = await ctx.db.query("noteIdLayout").first();
    if (existing?.mode === "keys") {
      throw new ConvexError({ code: "NOTE_IDS_KEYED", message: "The id keys are final once notes are keyed." });
    }
    let flipAt: Id<"workspaces">[] = [];
    if (mode === "keys") {
      if (existing?.mode !== "ids") {
        throw new ConvexError({
          code: "NOTE_IDS_NOT_IDS",
          message: "Switch to notes/ first. The copy has to be read from its ids before notes/ becomes the only copy.",
        });
      }
      const gate = await copyGate(ctx);
      if (gate.truncated) {
        throw new ConvexError({ code: "NOTE_IDS_TOO_MANY", message: "There are too many workspaces to check at once." });
      }
      if (gate.notReady > 0) {
        const count = gate.notReady;
        throw new ConvexError({
          code: "NOTE_IDS_NOT_READY",
          message: `${count} ${count === 1 ? "workspace is" : "workspaces are"} not fully copied to notes/ yet. Every copy must finish with no failures first.`,
        });
      }
      flipAt = gate.live;
    }
    const fields = { mode, updatedAt: Date.now(), updatedBy: String(userId) };
    if (existing === null) await ctx.db.insert("noteIdLayout", { paused: false, ...fields });
    else await ctx.db.patch(existing._id, fields);
    for (const workspaceId of flipAt) await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.flip, { workspaceId });
    return { mode };
  },
});

/**
 * Whether a workspace is keyed (`keyedWorkspace`): its notes' bytes live at their
 * id keys. The ingest binding route sends it so the email worker can refuse mail
 * it cannot write. INTERNAL.
 */
export const keyedFor = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId }) => await keyedWorkspace(ctx.db, workspaceId),
});

/**
 * The switch as `/gateway/binding` carries it: `"ids"` or `"keys"` (the
 * gateway reads a note through its id key in both), else null. INTERNAL.
 */
export const idLayout = internalQuery({
  args: {},
  returns: v.union(v.literal("ids"), v.literal("keys"), v.null()),
  handler: async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout?.mode === "ids") return "ids";
    if (layout?.mode === "keys") return "keys";
    return null;
  },
});

/**
 * For each path, the live file's id key and copy, as the gateway's lookup
 * answers them. A path with no row, a trashed row or a row with no id is left
 * out. INTERNAL.
 */
export const copiesFor = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(
    v.object({
      path: v.string(),
      key: v.string(),
      etag: v.union(v.string(), v.null()),
      keyEtag: v.union(v.string(), v.null()),
      fresh: v.boolean(),
    }),
  ),
  handler: async (ctx, { workspaceId, paths }) => {
    const found = [];
    for (const path of paths) {
      const row = await nodeAt(ctx.db, workspaceId, path);
      if (row === null || row.kind !== "file" || row.goneAt !== undefined || row.noteId === undefined) continue;
      found.push({
        path,
        key: idKeyFor(row.noteId, path),
        etag: row.idCopy?.etag ?? null,
        keyEtag: row.idCopy?.keyEtag ?? null,
        fresh: copyIsFresh(row),
      });
    }
    return found;
  },
});

/**
 * The path each note id's live row sits at now, for `/gateway/note-ids/resolve`.
 *
 * Scoped by `workspaceId` through the index, so an id held by another
 * workspace's row is not found here. A trashed row (`goneAt`) is not live, and
 * neither is one a queued trash parked under a dot folder: the tree never lists
 * those, so a note in the trash has no current path a search may name. An id
 * that matches more than one live row is answered as no row, since no single
 * path is its path. INTERNAL.
 */
export const pathsForNoteIds = internalQuery({
  args: { workspaceId: v.id("workspaces"), noteIds: v.array(v.string()) },
  returns: v.array(v.object({ noteId: v.string(), path: v.string() })),
  handler: async (ctx, { workspaceId, noteIds }) => {
    const found: Array<{ noteId: string; path: string }> = [];
    for (const noteId of noteIds) {
      const holders = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_noteId", (q) => q.eq("workspaceId", workspaceId).eq("noteId", noteId))
        .collect();
      const live = holders.filter((row) => row.kind === "file" && row.goneAt === undefined && !isPlumbing(row.path));
      if (live.length === 1) found.push({ noteId, path: live[0]!.path });
    }
    return found;
  },
});

/**
 * Record that the gateway wrote this path's bytes to its id key, at `etag`.
 * Recorded only when the row is a live file with an id and `key` is that id's
 * key for the path; anything else records nothing. The row's own etag may
 * catch up later, and `copyIsFresh` judges it then. INTERNAL.
 */
export const recordCopy = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string(), key: v.string(), etag: v.string(), keyEtag: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, path, key, etag, keyEtag }) => {
    const row = await nodeAt(ctx.db, workspaceId, path);
    if (row === null || row.kind !== "file" || row.goneAt !== undefined || row.noteId === undefined) return false;
    // A row the flip keyed after the gateway's lookup: its path write was mirrored to the key, which is now the row's
    // bytes. The row takes the key's version; nothing else about it changes (no `keyedFrom`: the bytes did not move).
    if (row.storageKey !== undefined) {
      if (row.storageKey !== key || keyEtag === undefined) return false;
      // A seam observation, so the new bytes are logged as a change like any keyed write.
      await applyObservation(convexNodeTable(ctx, workspaceId), {
        at: Date.now(),
        rows: [{ path, etag: keyEtag, keyed: { noteId: row.noteId, storageKey: key } }],
        gone: [],
        vanishedUnder: [],
        source: "seam",
      });
      return (await nodeAt(ctx.db, workspaceId, path))?.etag === keyEtag;
    }
    if (idKeyFor(row.noteId, path) !== key) return false;
    await ctx.db.patch(row._id, { idCopy: { key, etag, copiedAt: Date.now(), ...(keyEtag === undefined ? {} : { keyEtag }) } });
    return true;
  },
});

/** Schedule the diagnosis for one workspace: every copy it holds is compared with its bucket. */
async function scheduleDiagnosis(ctx: MutationCtx, workspaceId: Id<"workspaces">): Promise<void> {
  const row = await ensureCopyRow(ctx, workspaceId);
  await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.runCheck, {
    workspaceId,
    runId: row.runId,
    checkedAt: Date.now(),
    checked: 0,
    missing: 0,
    differs: 0,
  });
}

/** Check one workspace's id copies against its bucket. Missing or differing copies are copied again. */
export const diagnose = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
    await refuseWhenPaused(ctx);
    await scheduleDiagnosis(ctx, workspaceId);
    return { started: 1 };
  },
});

/** Check every live workspace's id copies. */
export const diagnoseAll = mutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    await staffOnly(ctx);
    await refuseWhenPaused(ctx);
    let started = 0;
    for (const workspaceId of await liveBoundWorkspaces(ctx)) {
      await scheduleDiagnosis(ctx, workspaceId);
      started += 1;
    }
    return { started };
  },
});

/**
 * The cron (`crons.ts`): a finished pass starts again, so edits are caught,
 * and a pass whose chain stopped is picked up once its lease has lapsed. A
 * failed pass is not retried here; staff restart it. Does nothing while paused.
 */
export const keepCurrent = internalMutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    if (await idCopyPaused(ctx.db)) return { started: 0 };
    const now = Date.now();
    let started = 0;
    for (const workspaceId of await liveBoundWorkspaces(ctx)) {
      const row = await copyRowOf(ctx.db, workspaceId);
      if (row?.status === "done") {
        if (await beginCopyPass(ctx, workspaceId, { force: false })) started += 1;
      } else if (row?.status === "copying" && !leaseHeld(row, now)) {
        await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.run, { workspaceId, runId: row.runId });
        started += 1;
      }
    }
    return { started };
  },
});
