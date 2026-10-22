/**
 * Old copies: the days of mail, calendar and chat, the contact pages and the
 * mail attachments Context copied into people's notes before it stopped
 * (owner, 2026-10-21: "I'm leaning toward removing everything, and adding
 * them back as needed"; boards `remove-copies` b0–b2, "go";
 * `docs/decisions/communications/live-not-copied.md`).
 *
 * They are hidden, never deleted for the person:
 *
 *  - `catchUp` runs every ten minutes (`crons.ts`) over keyed personal
 *    workspaces and schedules `hideWorkspace` for each not yet looked through
 *    and with no pass under way. Each `hideWorkspace` is one pass, and hands
 *    on to the next at once until the end, so no run nears an action's time
 *    limit and a workspace is done in minutes, not hours. A pass reads a
 *    page of rows, tells copies from the person's own notes
 *    (`lib/oldCopies/classify.ts`), and moves each copy's row to
 *    `.context/old-copies/<its path>` (`lib/oldCopies/hiding.ts`). That name
 *    is plumbing, so the tree, search and every AI drop it, as they drop the
 *    trash. Nothing is erased, and no timer ever erases it.
 *  - Download as folders still carries them, under `Old copies/`
 *    (`listForExport`, `readForExport`).
 *  - The owner may keep them hidden or delete them from Settings (`summary`,
 *    `keepCopies`, `deleteCopies`):
 *    the rows go first, then the bucket half the trash uses removes the bytes
 *    (`trashEmptying.ts`).
 *
 * Once every workspace has been looked through, each ten-minute pass is a read
 * of one row per keyed workspace.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type QueryCtx } from "../_generated/server";
import { recordAudit } from "./lib/audit";
import { callerId, resolveFileAccess } from "./lib/filesFns/access";
import { OLD_COPIES_ROOT } from "./lib/fileOps/store";
import { defaultGoogleDestinationFolder } from "./lib/googleConnect/validation";
import { applyRowMove, type RowMoveRefusal } from "./lib/nodes/rowMove";
import { keyedWorkspace } from "./lib/noteIds/keyedState";
import { rowVerdict } from "./lib/oldCopies/classify";
import type { HidePass } from "./lib/oldCopies/hiding";
import { isPlumbing } from "./lib/privacy";
import { dropLinks, removeRow } from "./trash";

/** Rows one pass looks at. */
const ROW_PAGE = 300;
/** How long a pass under way keeps `catchUp` from starting a second one beside it. */
const PASS_LEASE_MS = 15 * 60_000;
/** Workspaces one page of the ten-minute look (`catchUp`) reads. */
const WORKSPACE_PAGE = 20;
/** Hidden rows one deleting mutation removes. */
const ERASE_PAGE = 200;
/** Hidden notes one export listing names: past it, the download says it is short rather than guess. */
const EXPORT_MAX = 8_000;
/** A refusal that is about the workspace, not the row: the pass stops, and the next look starts it again. */
const STOPPING: ReadonlySet<RowMoveRefusal> = new Set<RowMoveRefusal>(["not_keyed", "not_served", "busy"]);

const pairValidator = v.object({ from: v.string(), to: v.string() });

async function hideRecord(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("oldCopyHides")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** The folders the mail and chat passes wrote into, where each kept its `attachments/`. */
async function attachmentFolders(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<string[]> {
  const connections = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(20);
  return connections.flatMap((row) => [
    ...(row.gmail === undefined ? [] : [row.gmail.destinationFolder ?? defaultGoogleDestinationFolder("gmail", row.gmail.mailboxSlug)]),
    ...(row.chat === undefined ? [] : [row.chat.destinationFolder ?? defaultGoogleDestinationFolder("chat", undefined)]),
  ]);
}

/* -------------------------------------------------------------------------- */
/*                                   hiding                                   */
/* -------------------------------------------------------------------------- */

export const catchUp = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout?.mode !== "keys") return null;
    const page = await ctx.db.query("noteIdCopies").paginate({ cursor: cursor ?? null, numItems: WORKSPACE_PAGE });
    for (const copies of page.page) {
      if (copies.keyedAt === undefined) continue;
      const workspace = await ctx.db.get(copies.workspaceId);
      if (workspace === null || workspace.kind !== "personal") continue;
      const record = await hideRecord(ctx, copies.workspaceId);
      if (record !== null && record.state !== "hiding") continue;
      // A pass is under way and hands on to the next itself.
      if (record?.passAt !== undefined && Date.now() - record.passAt < PASS_LEASE_MS) continue;
      await ctx.scheduler.runAfter(0, internal.functions.oldCopies.hideWorkspace, { workspaceId: copies.workspaceId });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.functions.oldCopies.catchUp, { cursor: page.continueCursor });
    return null;
  },
});

/** One pass over the next page of a workspace, handing on to the next until the end. */
export const hideWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, { workspaceId }): Promise<{ done: boolean }> => {
    const cursor = await ctx.runMutation(internal.functions.oldCopies.beginPass, { workspaceId, now: Date.now() });
    if (cursor === false) return { done: true };
    const pass = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "hideOldCopies", ...(cursor === null ? {} : { cursor }) },
    })) as HidePass;
    await ctx.runMutation(internal.functions.oldCopies.recordPass, {
      workspaceId,
      cursor: pass.cursor,
      stopped: pass.stopped !== undefined,
      days: pass.days,
      contacts: pass.contacts,
      files: pass.files,
      ...(pass.firstDay === undefined ? {} : { firstDay: pass.firstDay }),
      ...(pass.lastDay === undefined ? {} : { lastDay: pass.lastDay }),
      now: Date.now(),
    });
    // Counts only, never a path.
    console.log(JSON.stringify({
      event: "oldCopies.pass",
      workspaceId,
      hidden: { days: pass.days, contacts: pass.contacts, files: pass.files },
      looked: pass.looked ?? null,
      stopped: pass.stopped ?? null,
      done: pass.cursor === null && pass.stopped === undefined,
    }));
    if (pass.stopped !== undefined || pass.cursor === null) return { done: pass.stopped === undefined };
    await ctx.scheduler.runAfter(0, internal.functions.oldCopies.hideWorkspace, { workspaceId });
    return { done: false };
  },
});

/** Where the next pass starts (`null` from the top), or `false` when this workspace was already looked through. */
export const beginPass = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.union(v.string(), v.null(), v.literal(false)),
  handler: async (ctx, { workspaceId, now }) => {
    if (!(await keyedWorkspace(ctx.db, workspaceId))) return false;
    const record = await hideRecord(ctx, workspaceId);
    if (record === null) {
      await ctx.db.insert("oldCopyHides", { workspaceId, state: "hiding", days: 0, contacts: 0, files: 0, startedAt: now, passAt: now });
      return null;
    }
    if (record.state !== "hiding") return false;
    await ctx.db.patch(record._id, { passAt: now });
    return record.cursor ?? null;
  },
});

export const recordPass = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    cursor: v.union(v.string(), v.null()),
    stopped: v.boolean(),
    days: v.number(),
    contacts: v.number(),
    files: v.number(),
    firstDay: v.optional(v.string()),
    lastDay: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = await hideRecord(ctx, args.workspaceId);
    if (record === null || record.state !== "hiding") return null;
    const firstDay = [record.firstDay, args.firstDay].filter((day): day is string => day !== undefined).sort()[0];
    const lastDay = [record.lastDay, args.lastDay].filter((day): day is string => day !== undefined).sort().at(-1);
    const finished = args.cursor === null && !args.stopped;
    await ctx.db.patch(record._id, {
      days: record.days + args.days,
      contacts: record.contacts + args.contacts,
      files: record.files + args.files,
      ...(firstDay === undefined ? {} : { firstDay }),
      ...(lastDay === undefined ? {} : { lastDay }),
      cursor: args.cursor ?? undefined,
      // Still held while the next pass is handed on; let go at the end, or when a pass stopped.
      passAt: args.cursor !== null && !args.stopped ? args.now : undefined,
      ...(finished ? { state: "hidden" as const, hiddenAt: args.now } : {}),
    });
    return null;
  },
});

/** One page of the workspace's live rows, and what each copy among them is (`classify.ts`). */
export const candidatePage = internalQuery({
  args: { workspaceId: v.id("workspaces"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    rows: v.array(
      v.object({
        path: v.string(),
        verdict: v.union(v.literal("day"), v.literal("attachment"), v.literal("read")),
        /** Where a keyed note's bytes are, for a note whose text decides. */
        key: v.optional(v.string()),
      }),
    ),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { workspaceId, cursor }) => {
    const folders = await attachmentFolders(ctx, workspaceId);
    const page = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId))
      .paginate({ cursor, numItems: ROW_PAGE });
    const rows = [];
    for (const row of page.page) {
      if (row.goneAt !== undefined || isPlumbing(row.path)) continue;
      const verdict = rowVerdict(row, folders);
      if (verdict === null) continue;
      rows.push({ path: row.path, verdict, ...(verdict === "read" && row.storageKey !== undefined ? { key: row.storageKey } : {}) });
    }
    return { rows, cursor: page.continueCursor, done: page.isDone };
  },
});

/**
 * Move each of these rows to its name under `.context/old-copies/`, as a
 * trash moves one (`rowMove.ts`, `trash: true`): no rules are written, its
 * links and pins stay at its old name, and it keeps its id and bytes. A row
 * that cannot move is left where it is; a refusal about the whole workspace
 * stops here and says why.
 */
export const hideRows = internalMutation({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()), now: v.number() },
  returns: v.object({ moved: v.array(pairValidator), stopped: v.union(v.string(), v.null()) }),
  handler: async (ctx, { workspaceId, paths, now }) => {
    const moved: { from: string; to: string }[] = [];
    for (const path of paths) {
      if (isPlumbing(path)) continue;
      const answer = await applyRowMove(ctx, { workspaceId, from: path, to: `${OLD_COPIES_ROOT}/${path}`, privacyEtag: null, now, trash: true });
      if (answer.ok) moved.push(...answer.files);
      else if (STOPPING.has(answer.reason)) return { moved, stopped: answer.reason };
    }
    return { moved, stopped: null };
  },
});

/* -------------------------------------------------------------------------- */
/*                             the Settings page                              */
/* -------------------------------------------------------------------------- */

const summaryValidator = v.union(
  v.null(),
  v.object({
    state: v.union(v.literal("hiding"), v.literal("hidden"), v.literal("deleting"), v.literal("deleted")),
    days: v.number(),
    contacts: v.number(),
    files: v.number(),
    firstDay: v.union(v.string(), v.null()),
    lastDay: v.union(v.string(), v.null()),
    /** When copying stopped and the hiding began: "Copied before" this day. */
    since: v.number(),
    /** The Google accounts the copies came from, for "From a and b". */
    addresses: v.array(v.string()),
  }),
);

/** Whether the caller owns the workspace: only an owner is told about, downloads or deletes old copies. */
async function ownerOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Id<"users"> | null> {
  const actorUserId = await callerId(ctx);
  try {
    await resolveFileAccess(ctx, { actorUserId, workspaceId, minimum: "owner" });
    return actorUserId;
  } catch {
    return null;
  }
}

/**
 * What the Old copies row and page say, for the owner; `null` when there is
 * nothing to say: no copies were found, or the owner already kept them hidden
 * or deleted them (board b1: "one row, gone once kept or deleted").
 */
export const summary = query({
  args: { workspaceId: v.id("workspaces") },
  returns: summaryValidator,
  handler: async (ctx, { workspaceId }) => {
    if ((await ownerOf(ctx, workspaceId)) === null) return null;
    const record = await hideRecord(ctx, workspaceId);
    if (record === null || record.keptAt !== undefined || record.state === "deleted") return null;
    if (record.days + record.contacts + record.files === 0) return null;
    const connections = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .take(20);
    return {
      state: record.state,
      days: record.days,
      contacts: record.contacts,
      files: record.files,
      firstDay: record.firstDay ?? null,
      lastDay: record.lastDay ?? null,
      since: record.startedAt,
      addresses: [...new Set(connections.map((row) => row.address.toLowerCase()))].sort(),
    };
  },
});

/** Keep them hidden: the owner's answer, so the row goes. Nothing about the copies changes. */
export const keepCopies = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    if ((await ownerOf(ctx, workspaceId)) === null) throw new ConvexError({ code: "FORBIDDEN", message: "Only an owner can choose this." });
    const record = await hideRecord(ctx, workspaceId);
    if (record !== null && record.keptAt === undefined) await ctx.db.patch(record._id, { keptAt: Date.now() });
    return null;
  },
});

/**
 * Delete the old copies, for good. The owner's own press, twice, on a page
 * that said how many and that it cannot be undone. Refused until every copy
 * was hidden, so what is deleted is what the page counted.
 */
export const deleteCopies = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const actorUserId = await ownerOf(ctx, workspaceId);
    if (actorUserId === null) throw new ConvexError({ code: "FORBIDDEN", message: "Only an owner can delete old copies." });
    const record = await hideRecord(ctx, workspaceId);
    if (record === null || record.state !== "hidden") {
      throw new ConvexError({ code: "NOT_READY", message: "There are no hidden copies to delete right now." });
    }
    const now = Date.now();
    await ctx.db.patch(record._id, { state: "deleting", deleteAskedAt: now });
    await recordAudit(ctx, {
      workspaceId,
      actorUserId,
      action: "file.delete",
      paths: [],
      details: { oldCopies: true, days: record.days, contacts: record.contacts, files: record.files },
    });
    await ctx.scheduler.runAfter(0, internal.functions.oldCopies.erasePage, { workspaceId });
    return null;
  },
});

/**
 * One page of the deleting: the hidden rows go, and what the bucket must still
 * remove is handed to the trash's bucket half (`trashErasures`). The last page
 * marks the workspace's old copies deleted and starts that half.
 */
export const erasePage = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const record = await hideRecord(ctx, workspaceId);
    if (record === null || record.state !== "deleting") return null;
    const rows = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gt("path", `${OLD_COPIES_ROOT}/`).lt("path", `${OLD_COPIES_ROOT}0`))
      .take(ERASE_PAGE);
    const files = rows.filter((row) => row.kind === "file" && row.goneAt === undefined);
    const keys = files.flatMap((row) => (row.storageKey === undefined ? [] : [row.storageKey]));
    const histories = files.filter((row) => row.path.endsWith(".md")).map((row) => row.path);
    for (const row of rows) await removeRow(ctx, row);
    for (const row of files) await dropLinks(ctx, workspaceId, row.path.slice(OLD_COPIES_ROOT.length + 1));
    if (keys.length > 0 || histories.length > 0) {
      await ctx.db.insert("trashErasures", {
        workspaceId,
        folder: OLD_COPIES_ROOT,
        path: OLD_COPIES_ROOT,
        keys,
        histories,
        claimedAt: Date.now(),
        attempts: 0,
      });
    }
    if (rows.length === ERASE_PAGE) {
      await ctx.scheduler.runAfter(0, internal.functions.oldCopies.erasePage, { workspaceId });
      return null;
    }
    const root = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", OLD_COPIES_ROOT))
      .unique();
    if (root !== null) await removeRow(ctx, root);
    await ctx.db.patch(record._id, { state: "deleted", deletedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.functions.trashEmptying.eraseWorkspace, { workspaceId });
    return null;
  },
});

/* -------------------------------------------------------------------------- */
/*                             Download as folders                            */
/* -------------------------------------------------------------------------- */

/** The hidden notes' names, under `.context/old-copies/`; `null` past `EXPORT_MAX`. */
export const exportPaths = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.array(v.string())),
  handler: async (ctx, { workspaceId }) => {
    const paths: string[] = [];
    const rows = ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gt("path", `${OLD_COPIES_ROOT}/`).lt("path", `${OLD_COPIES_ROOT}0`));
    for await (const row of rows) {
      if (row.kind !== "file" || row.goneAt !== undefined || !row.path.endsWith(".md")) continue;
      if (paths.length >= EXPORT_MAX) return null;
      paths.push(row.path.slice(OLD_COPIES_ROOT.length + 1));
    }
    return paths;
  },
});

/**
 * The hidden notes' names, for the owner's Download as folders: none for
 * anyone else, so their download is the one it always was. `null` when the
 * list would be cut short, so the download says so rather than leaving some
 * out unsaid.
 */
export const listForExport = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.array(v.string())),
  handler: async (ctx, { workspaceId }): Promise<string[] | null> => {
    const actorUserId = await callerId(ctx);
    try {
      await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId, workspaceId, minimum: "owner" });
    } catch {
      return [];
    }
    return await ctx.runQuery(internal.functions.oldCopies.exportPaths, { workspaceId });
  },
});

/** Which of these names the tree holds a live hidden note at, and the key its bytes are at. */
export const heldRows = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(v.object({ path: v.string(), key: v.string() })),
  handler: async (ctx, { workspaceId, paths }) => {
    const held: { path: string; key: string }[] = [];
    for (const path of paths) {
      if (!path.startsWith(`${OLD_COPIES_ROOT}/`)) continue;
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
        .unique();
      if (row !== null && row.kind === "file" && row.goneAt === undefined && row.storageKey !== undefined) {
        held.push({ path, key: row.storageKey });
      }
    }
    return held;
  },
});

const readResultValidator = v.union(
  v.object({ path: v.string(), outcome: v.literal("read"), note: v.object({ text: v.string() }) }),
  v.object({ path: v.string(), outcome: v.literal("error"), code: v.string(), message: v.string() }),
);

/** The text of up to fifty hidden notes, by the names `listForExport` gave, answered as `files.readNotes` answers. */
export const readForExport = action({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.object({ results: v.array(readResultValidator) }),
  handler: async (ctx, { workspaceId, paths }): Promise<{ results: (typeof readResultValidator.type)[] }> => {
    if (paths.length > 50) throw new ConvexError({ code: "TOO_MANY", message: "Ask for at most 50 at a time." });
    // Refuses anyone but an owner, as every owner-only file action is refused.
    await ctx.runQuery(internal.functions.files.authorizeFileAccess, { actorUserId: await callerId(ctx), workspaceId, minimum: "owner" });
    const answer = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "readOldCopies", paths },
    })) as { kind: "oldCopyTexts"; results: (typeof readResultValidator.type)[] };
    return { results: answer.results };
  },
});
