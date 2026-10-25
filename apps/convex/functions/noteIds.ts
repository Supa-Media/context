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

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { convexNodeTable } from "./lib/nodes/convexTable";
import { copyIsFresh, idKeyFor, newNoteId } from "./lib/nodes/noteIds";
import { applyObservation } from "./lib/nodes/observe";
import { workspaceArchived } from "./lib/archivedWorkspaces";
import { isPlumbing } from "./lib/privacy";
import { cleanupViewOf, cleanupViewValidator, type CleanupView } from "./noteIdsCleanup";
import { KEYED_RECHECKS_PER_TICK, keyedRecheckOwed } from "./lib/noteIds/keyedRecheck";
import { planGroup, renameSnapshotId, sharedGroupsPage, copyStateOf } from "./lib/noteIds/sharedIds";
import { copyRowOf, nodeAt, scheduleDiagnosis } from "./lib/noteIds/state";
import { keyedWorkspace } from "./lib/noteIds/keyedState";
import { boundWorkspaces, liveBoundWorkspaces, staffOnly } from "./nodesMigration";
import { nodePaths } from "./lib/nodes/paths";

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
  /** The last diagnosis of the workspace's id copies (`noteIdsCopy.runCheck`), or null before one ran. */
  diagnosis: v.union(v.null(), diagnosisValidator),
  /** Held by an archived account. */
  archived: v.boolean(),
  /** The old-copy cleanup: its counts, its run, and the refusal each of its buttons would get now (`noteIdsCleanup.ts`). */
  cleanup: cleanupViewValidator,
});

/** Where the id copies are diagnosed, for every workspace with storage. Counts and labels only. */
export const report = query({
  args: {},
  returns: v.object({
    workspaces: v.array(rowValidator),
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    await staffOnly(ctx);
    const { ids, truncated } = await boundWorkspaces(ctx);
    const workspaces: Array<{
      workspaceId: Id<"workspaces">;
      handle: string | null;
      diagnosis: { checkedAt: number; checked: number; missing: number; differs: number } | null;
      archived: boolean;
      cleanup: CleanupView;
    }> = [];
    for (const workspaceId of ids) {
      const workspace = await ctx.db.get(workspaceId);
      if (workspace === null) continue;
      const row = await copyRowOf(ctx.db, workspaceId);
      workspaces.push({
        workspaceId,
        handle: workspace.slug ?? null,
        diagnosis: row?.diagnosis ?? null,
        archived: await workspaceArchived(ctx.db, workspaceId),
        cleanup: await cleanupViewOf(ctx.db, workspaceId, Date.now()),
      });
    }
    return { workspaces, truncated };
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
 * The switch as `/gateway/binding` carries it: `"keys"` once the layout row says
 * so (the only mode left, `notes-by-id.md`), else null. Read-only; the row is
 * retired. INTERNAL.
 */
export const idLayout = internalQuery({
  args: {},
  returns: v.union(v.literal("keys"), v.null()),
  handler: async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    return layout?.mode === "keys" ? "keys" : null;
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
    const paths = await nodePaths(ctx.db, workspaceId);
    for (const noteId of noteIds) {
      const holders = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_noteId", (q) => q.eq("workspaceId", workspaceId).eq("noteId", noteId))
        .collect();
      const live: string[] = [];
      for (const row of holders) {
        if (row.kind !== "file" || row.goneAt !== undefined) continue;
        const path = await paths.pathOf(row);
        if (path !== null && !isPlumbing(path)) live.push(path);
      }
      if (live.length === 1) found.push({ noteId, path: live[0]! });
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
      });
      return (await nodeAt(ctx.db, workspaceId, path))?.etag === keyEtag;
    }
    if (idKeyFor(row.noteId, path) !== key) return false;
    await ctx.db.patch(row._id, { idCopy: { key, etag, copiedAt: Date.now(), ...(keyEtag === undefined ? {} : { keyEtag }) } });
    return true;
  },
});

/** Check one workspace's id copies against its bucket. Missing or differing copies are copied again. */
export const diagnose = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
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
    let started = 0;
    for (const workspaceId of await liveBoundWorkspaces(ctx)) {
      await scheduleDiagnosis(ctx, workspaceId);
      started += 1;
    }
    return { started };
  },
});

/**
 * The cron (`crons.ts`): a keyed row whose recheck is owed gets its diagnosis
 * again (`keyedRecheck.ts`), at most `KEYED_RECHECKS_PER_TICK` a tick. Nothing
 * else is started here: every workspace is keyed at its binding (`born.ts`) or
 * by its first pass, and edits are written at their id keys as they happen.
 */
export const keepCurrent = internalMutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let started = 0;
    let rechecks = 0;
    for (const workspaceId of await liveBoundWorkspaces(ctx)) {
      const row = await copyRowOf(ctx.db, workspaceId);
      if (row === null || rechecks >= KEYED_RECHECKS_PER_TICK || !keyedRecheckOwed(row)) continue;
      await ctx.db.patch(row._id, { keyedRecheckAt: now });
      await scheduleDiagnosis(ctx, workspaceId);
      rechecks += 1;
      started += 1;
    }
    return { started };
  },
});

const sharedGroupValidator = v.object({
  noteId: v.string(),
  /** A keyed workspace's group whose repair would re-id a row at its shared key: left as it is, for a person to look at. */
  needsLook: v.boolean(),
  rows: v.array(
    v.object({
      path: v.string(),
      copy: v.union(v.literal("keyed"), v.literal("fresh"), v.literal("stale"), v.literal("none")),
    }),
  ),
});

/**
 * One page of the live file rows that share a noteId in one workspace, in noteId
 * order: each group's paths and copy states. `after` is the `next` of the page
 * before (absent for the first). Staff only; paths are shown to staff here, never
 * to anyone else. A 100k-row workspace is read a page at a time.
 */
export const sharedIdReport = query({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: v.object({ groups: v.array(sharedGroupValidator), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, after }) => {
    await staffOnly(ctx);
    const page = await sharedGroupsPage(ctx.db, workspaceId, after);
    return {
      groups: page.groups.map((group) => ({
        noteId: group.noteId,
        needsLook: planGroup(group).needsLook,
        rows: group.rows.map((row) => ({ path: row.path, copy: copyStateOf(group.noteId, row) })),
      })),
      next: page.next ?? null,
    };
  },
});

/**
 * Repair one page of shared groups (`lib/noteIds/sharedIds.ts`): the id stays on
 * the row whose copy is fresh (else the oldest), every other row gets a new id and
 * loses its copy record, and the access snapshot follows. Then schedules the next
 * page. INTERNAL.
 */
export const repairSharedIdsPage = internalMutation({
  args: { workspaceId: v.id("workspaces"), after: v.optional(v.string()) },
  returns: v.object({ repaired: v.number(), needsLook: v.number() }),
  handler: async (ctx, { workspaceId, after }) => {
    const page = await sharedGroupsPage(ctx.db, workspaceId, after);
    let repaired = 0;
    let needsLook = 0;
    for (const group of page.groups) {
      const plan = planGroup(group);
      if (plan.needsLook) {
        needsLook += 1;
        continue;
      }
      for (const row of plan.repairs) {
        const noteId = newNoteId();
        await ctx.db.patch(row._id, { noteId, idCopy: undefined, idHeals: undefined });
        await renameSnapshotId(ctx, workspaceId, row.path, group.noteId, noteId);
        repaired += 1;
      }
    }
    if (page.next !== undefined) {
      await ctx.scheduler.runAfter(0, internal.functions.noteIds.repairSharedIdsPage, { workspaceId, after: page.next });
    }
    return { repaired, needsLook };
  },
});

/**
 * Staff: repair every shared group in one workspace. Only schedules
 * `repairSharedIdsPage`, page by page; a second run finds nothing to change.
 */
export const repairSharedIds = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ started: v.number() }),
  handler: async (ctx, { workspaceId }) => {
    await staffOnly(ctx);
    await ctx.scheduler.runAfter(0, internal.functions.noteIds.repairSharedIdsPage, { workspaceId });
    return { started: 1 };
  },
});
