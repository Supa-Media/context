/**
 * A workspace's small data in the control plane (`lib/schema/smallData.ts`):
 * folder and note icons, the names of its own emoji, and the forwarding
 * ledger. Internal only. People reach the icons and emoji through
 * `folderIcons.ts` and `emoji.ts`, which decide who may see what; the
 * gateway reaches the ledger through `/gateway/tree/facts` and records
 * through `/gateway/tree/touch`; the console's file operations through the
 * store the credential barrier opens (`lib/smallData/attach.ts`).
 *
 * Every change asks for a sync (`lib/smallData/sync.ts`), which imports the
 * workspace's bucket files once and then writes the files from these rows,
 * never reading them back. See
 * `docs/decisions/app-and-console/convex-small-data.md`.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { forwardPath } from "../../mcp/src/forwarding.js";
import { ledgerOf, ledgerRows, recordForwardingMoves } from "./lib/smallData/forwarding";
import { dropIconRows, iconRows, iconsOf, remapIconRows, setIconRow } from "./lib/smallData/icons";
import { importSmallData } from "./lib/smallData/importing";
import { emojiRows } from "./lib/smallData/emoji";
import { exportOwed, requestSmallDataSync, smallDataStateOf } from "./lib/smallData/state";

const kind = v.union(v.literal("note"), v.literal("folder"));
const entry = v.object({ from: v.string(), to: v.string(), kind, at: v.number() });
const move = v.object({ from: v.string(), to: v.string(), kind });
const emoji = v.object({ name: v.string(), leaf: v.string() });
const icon = v.object({ path: v.string(), icon: v.string() });

/* --------------------------------- reads --------------------------------- */

/** The whole ledger, oldest first. Unfiltered: a caller decides who may see each end. */
export const ledger = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(entry),
  handler: async (ctx, { workspaceId }) => ledgerOf(await ledgerRows(ctx.db, workspaceId)).entries,
});

/**
 * Where each path is now. Unfiltered, like `ledger`: the one caller (a share
 * read, `shares/readPath.ts`) reads each answer again at `team` scope.
 */
export const forward = internalQuery({
  args: { workspaceId: v.id("workspaces"), paths: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { workspaceId, paths }) => {
    const held = ledgerOf(await ledgerRows(ctx.db, workspaceId));
    return paths.map((path) => forwardPath(held, path) ?? path);
  },
});

/** Every icon held, removals left out. Unfiltered: `folderIcons.list` filters. */
export const icons = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(icon),
  handler: async (ctx, { workspaceId }) =>
    Object.entries(iconsOf(await iconRows(ctx.db, workspaceId))).map(([path, glyph]) => ({ path, icon: glyph })),
});

/** Every emoji, by name. Every member sees every emoji (`emoji.ts`). */
export const emojiList = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(emoji),
  handler: async (ctx, { workspaceId }) =>
    (await emojiRows(ctx.db, workspaceId)).map((row) => ({ name: row.name, leaf: row.leaf })),
});

/** The leaf one emoji is stored under, or `null` for a name the workspace has none of. */
export const emojiLeaf = internalQuery({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { workspaceId, name }) => {
    const row = await ctx.db
      .query("customEmoji")
      .withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId).eq("name", name))
      .unique();
    return row?.leaf ?? null;
  },
});

/* --------------------------------- writes -------------------------------- */

/** Moves recorded in the ledger, collapsed and capped by the engine. */
export const recordForwarding = internalMutation({
  args: { workspaceId: v.id("workspaces"), moves: v.array(move), now: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, moves, now }): Promise<null> => {
    await recordForwardingMoves(ctx, workspaceId, moves, now);
    return null;
  },
});

/** One icon set, or removed with `null`. The caller has decided the caller may. */
export const setIcon = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string(), icon: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await setIconRow(ctx, args.workspaceId, args.path, args.icon);
    return null;
  },
});

/** Icons carried along with moves. */
export const remapIcons = internalMutation({
  args: { workspaceId: v.id("workspaces"), moves: v.array(v.object({ from: v.string(), to: v.string() })) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, moves }): Promise<null> => {
    await remapIconRows(ctx, workspaceId, moves);
    return null;
  },
});

/** The icons of a path deleted for good, and of everything beneath it. */
export const dropIcons = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, path }): Promise<null> => {
    await dropIconRows(ctx, workspaceId, path);
    return null;
  },
});

/** An emoji's name now stored under `leaf` (added, or replaced). */
export const putEmoji = internalMutation({
  args: { workspaceId: v.id("workspaces"), name: v.string(), leaf: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, name, leaf }): Promise<null> => {
    const row = await ctx.db
      .query("customEmoji")
      .withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId).eq("name", name))
      .unique();
    if (row === null) await ctx.db.insert("customEmoji", { workspaceId, name, leaf });
    else if (row.leaf !== leaf) await ctx.db.patch(row._id, { leaf });
    return null;
  },
});

/** An emoji's name gone. */
export const removeEmoji = internalMutation({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, name }): Promise<null> => {
    const rows = await ctx.db
      .query("customEmoji")
      .withIndex("by_workspace_name", (q) => q.eq("workspaceId", workspaceId).eq("name", name))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

/* ------------------------------- the sync -------------------------------- */

/** What the sync needs: whether the import ran, and the rows with their versions when a file is owed. */
export const snapshot = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    imported: v.boolean(),
    forwarding: v.union(v.null(), v.object({ version: v.number(), entries: v.array(entry) })),
    icons: v.union(v.null(), v.object({ version: v.number(), icons: v.array(icon) })),
  }),
  handler: async (ctx, { workspaceId }) => {
    const state = await smallDataStateOf(ctx.db, workspaceId);
    const owedForwarding = state !== null && state.forwardingExported < state.forwardingVersion;
    const owedIcons = state !== null && state.iconsExported < state.iconsVersion;
    return {
      imported: state?.importedAt !== undefined,
      forwarding: owedForwarding
        ? { version: state.forwardingVersion, entries: ledgerOf(await ledgerRows(ctx.db, workspaceId)).entries }
        : null,
      icons: owedIcons
        ? {
            version: state.iconsVersion,
            icons: Object.entries(iconsOf(await iconRows(ctx.db, workspaceId))).map(([path, glyph]) => ({ path, icon: glyph })),
          }
        : null,
    };
  },
});

/** The bucket's files, read once, merged in (`lib/smallData/importing.ts`). */
export const imported = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    forwarding: v.array(entry),
    icons: v.array(icon),
    emoji: v.array(emoji),
    now: v.number(),
  },
  returns: v.object({ imported: v.boolean() }),
  handler: async (ctx, { workspaceId, now, ...found }) => await importSmallData(ctx, workspaceId, found, now),
});

/**
 * The files were written from these versions. Releases the lease, or, when a
 * change moved a version since, keeps it and schedules the next round.
 */
export const exported = internalMutation({
  args: { workspaceId: v.id("workspaces"), forwarding: v.optional(v.number()), icons: v.optional(v.number()) },
  returns: v.object({ again: v.boolean() }),
  handler: async (ctx, { workspaceId, forwarding, icons }) => {
    const state = await smallDataStateOf(ctx.db, workspaceId);
    if (state === null) return { again: false };
    const next = {
      ...state,
      forwardingExported: Math.max(state.forwardingExported, forwarding ?? 0),
      iconsExported: Math.max(state.iconsExported, icons ?? 0),
    };
    await ctx.db.patch(state._id, {
      forwardingExported: next.forwardingExported,
      iconsExported: next.iconsExported,
      syncAt: undefined,
    });
    if (!exportOwed(next) || next.importedAt === undefined) return { again: false };
    return { again: await requestSmallDataSync(ctx, workspaceId) };
  },
});

/** A sync that failed: the lease goes, and the next change or the cron tries again. */
export const released = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    const state = await smallDataStateOf(ctx.db, workspaceId);
    if (state !== null) await ctx.db.patch(state._id, { syncAt: undefined });
    return null;
  },
});

/** Ask for a sync if one is wanted (a reader whose workspace has not been imported). */
export const request = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    await requestSmallDataSync(ctx, workspaceId);
    return null;
  },
});
