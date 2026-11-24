/**
 * Sheet sources: a key that adds rows to one sheet, for anything that can
 * send an HTTP request (decided by the owner, 2026-11-24: "shouldnt we have a
 * generic way for people to setup a webhook or data end point"). A CI job
 * posts its timing, a script posts a reading, and the sheet gains a row, with
 * no model in between. See `docs/decisions/app-and-console/sheet-sources.md`.
 *
 * ## What a key can do, stated plainly
 *
 * Add rows to the one sheet it was made for. Nothing else: it cannot read the
 * sheet or any other note, update or delete a row, or name another path. The
 * path comes from the key's row, never from the request.
 *
 * ## Whose authority it carries
 *
 * The member who made it, at their live role, every time it is used: the
 * write runs at the clearance `authorizeFileAccess` gives them *now*, at
 * `editor` or above. So a key stops working when its maker leaves the
 * workspace, is demoted, or loses sight of the sheet, without anybody
 * remembering to revoke it. Its maker or an owner revoking it stops it at once.
 *
 * ## The key
 *
 * `ctxs_` and 32 random bytes, shown once when it is made. Only its SHA-256 is
 * stored. It is sent in the `Authorization` header and never in a URL
 * (credentials never live in URLs: non-negotiable 1).
 *
 * ## One refusal for everything about the key
 *
 * An unknown key, a revoked one, one whose maker can no longer edit, one whose
 * workspace is gone: all `KEY_REFUSED`, one sentence, so a caller cannot tell
 * a key that was taken back from one that never existed. Rows that do not fit
 * the sheet and a spent rate limit each say so: those are facts about the
 * request, and say nothing about the workspace.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, internalAction, internalQuery, query } from "../_generated/server";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { hashToken } from "./lib/crypto";
import { newSourceKey } from "./lib/sheetSourceKeys";
import { normalizePath } from "./lib/fileOps";
import { callerId, resolveFileAccess } from "./lib/filesFns/access";
import { tryConsumeRateLimit } from "./lib/rateLimit";

const MAX_NAME = 60;
const MAX_PER_SHEET = 20;
/** Rows a key may add in an hour: readings, not an import. */
export const ROWS_PER_HOUR = 1000;
const HOUR = 60 * 60 * 1000;

function keyRefused(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "KEY_REFUSED", message: "This key cannot add rows." });
}

function sourceName(name: string): string {
  const line = name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim();
  if (line === "") throw new ConvexError({ code: "NAME_REQUIRED", message: "Name the source, such as \"GitHub speed budgets\"." });
  if (line.length > MAX_NAME) throw new ConvexError({ code: "NAME_TOO_LONG", message: `A source's name is at most ${MAX_NAME} characters.` });
  // It is written into the workspace's activity as "<maker> via <name>", so nothing Markdown reads as syntax.
  if (!/^[\p{L}\p{N} .,'&+-]+$/u.test(line)) {
    throw new ConvexError({ code: "NAME_INVALID", message: "Use letters, numbers, spaces and - . , ' & + in a source's name." });
  }
  return line;
}

function sheetPath(path: string): string {
  const normal = normalizePath(path);
  if (normal === null || !normal.toLowerCase().endsWith(".csv")) {
    throw new ConvexError({ code: "NOT_A_SHEET", message: "A source adds rows to a sheet: a .csv file." });
  }
  return normal;
}

const sourceView = v.object({
  sourceId: v.id("sheetSources"),
  name: v.string(),
  createdAt: v.number(),
  lastUsedAt: v.union(v.number(), v.null()),
  rowsAdded: v.number(),
});

function viewOf(row: Doc<"sheetSources">) {
  return { sourceId: row._id, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt ?? null, rowsAdded: row.rowsAdded };
}

/* --------------------------------- making --------------------------------- */

/**
 * Make a key for one sheet. An editor who can open the sheet; the key is
 * returned here once and never again.
 */
export const create = action({
  args: { workspaceId: v.id("workspaces"), path: v.string(), name: v.string() },
  returns: v.object({ sourceId: v.id("sheetSources"), key: v.string() }),
  handler: async (ctx, args): Promise<{ sourceId: Id<"sheetSources">; key: string }> => {
    const userId = await callerId(ctx);
    const name = sourceName(args.name);
    const path = sheetPath(args.path);
    const access = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId: userId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    // The sheet exists and this editor can see it: the same read the app's sheet view makes.
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope: access.scope,
      grantedNames: access.grantedNames,
      operation: { kind: "read", path },
    });
    const key = newSourceKey();
    const sourceId = await ctx.runMutation(internal.functions.sheetSources.insertSource, {
      workspaceId: args.workspaceId,
      path,
      name,
      keyHash: await hashToken(key),
      createdBy: userId,
    });
    return { sourceId, key };
  },
});

export const insertSource = internalMutation({
  args: { workspaceId: v.id("workspaces"), path: v.string(), name: v.string(), keyHash: v.string(), createdBy: v.id("users") },
  returns: v.id("sheetSources"),
  handler: async (ctx, args) => {
    const live = (
      await ctx.db
        .query("sheetSources")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId).eq("path", args.path))
        .collect()
    ).filter((row) => row.revokedAt === undefined);
    if (live.length >= MAX_PER_SHEET) {
      throw new ConvexError({ code: "TOO_MANY_SOURCES", message: `A sheet takes at most ${MAX_PER_SHEET} sources. Revoke one first.` });
    }
    return await ctx.db.insert("sheetSources", { ...args, createdAt: Date.now(), rowsAdded: 0 });
  },
});

/**
 * A sheet's live sources: the caller's own, or every one for an owner. Names
 * and counts only, never a key or its hash. Not every editor's, because a
 * query cannot open the sheet, and an editor naming a path held back from
 * them must learn nothing about it.
 */
export const list = query({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: v.array(sourceView),
  handler: async (ctx, args) => {
    const userId = await callerId(ctx);
    const access = await resolveFileAccess(ctx, { actorUserId: userId, workspaceId: args.workspaceId, minimum: "editor" });
    const path = normalizePath(args.path);
    if (path === null) return [];
    const rows = await ctx.db
      .query("sheetSources")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", args.workspaceId).eq("path", path))
      .collect();
    return rows
      .filter((row) => row.revokedAt === undefined && (access.role === "owner" || row.createdBy === userId))
      .map(viewOf);
  },
});

/** Stop a key at once: its maker, or an owner of the workspace. */
export const revoke = mutation({
  args: { sourceId: v.id("sheetSources") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await callerId(ctx);
    const row = await ctx.db.get(args.sourceId);
    if (row === null) return null;
    const access = await resolveFileAccess(ctx, { actorUserId: userId, workspaceId: row.workspaceId, minimum: "editor" });
    if (access.role !== "owner" && row.createdBy !== userId) {
      throw new ConvexError({ code: "NOT_YOURS", message: "Only the person who made this key, or an owner, can revoke it." });
    }
    if (row.revokedAt === undefined) await ctx.db.patch(row._id, { revokedAt: Date.now() });
    return null;
  },
});

/* --------------------------------- using ---------------------------------- */

export const sourceByKeyHash = internalQuery({
  args: { keyHash: v.string() },
  returns: v.union(
    v.object({ sourceId: v.id("sheetSources"), workspaceId: v.id("workspaces"), path: v.string(), name: v.string(), createdBy: v.id("users") }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("sheetSources").withIndex("by_key_hash", (q) => q.eq("keyHash", args.keyHash)).unique();
    if (row === null || row.revokedAt !== undefined) return null;
    return { sourceId: row._id, workspaceId: row.workspaceId, path: row.path, name: row.name, createdBy: row.createdBy };
  },
});

/**
 * Spend this key's hourly allowance for `rows` rows. Throws rather than
 * returning, so a call that would only partly fit spends nothing: the throw
 * rolls the whole mutation back.
 */
export const spendSourceRows = internalMutation({
  args: { sourceId: v.id("sheetSources"), rows: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sourceId);
    if (row === null || row.revokedAt !== undefined) throw keyRefused();
    for (let i = 0; i < args.rows; i += 1) {
      if (!(await tryConsumeRateLimit(ctx, { key: `sheet-source:${args.sourceId}`, limit: ROWS_PER_HOUR, windowMs: HOUR }))) {
        throw new ConvexError({ code: "RATE_LIMITED", message: `A key adds at most ${ROWS_PER_HOUR} rows an hour. Try again later.` });
      }
    }
    return null;
  },
});

export const noteSourceUse = internalMutation({
  args: { sourceId: v.id("sheetSources"), rows: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sourceId);
    if (row === null) return null;
    await ctx.db.patch(row._id, { lastUsedAt: Date.now(), rowsAdded: row.rowsAdded + args.rows });
    return null;
  },
});

/**
 * Add rows through a key. Called by the HTTP route with the key's hash, never
 * the key; the rows are already one level of text.
 *
 * Cheap refusals first and the workspace's storage opened last, as a collect
 * link does: somebody posting garbage at the endpoint must not make us read a
 * customer's sheet.
 */
export const appendThroughSource = internalAction({
  args: { keyHash: v.string(), rows: v.array(v.record(v.string(), v.string())) },
  returns: v.object({ appended: v.number() }),
  handler: async (ctx, args): Promise<{ appended: number }> => {
    const source = await ctx.runQuery(internal.functions.sheetSources.sourceByKeyHash, { keyHash: args.keyHash });
    if (source === null) throw keyRefused();

    let access: { scope: "private" | "team"; grantedNames: string[]; actorName: string | null };
    try {
      access = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
        actorUserId: source.createdBy,
        workspaceId: source.workspaceId,
        minimum: "editor",
      });
    } catch {
      // Its maker left, was demoted, or the workspace is gone: the key's authority went with them.
      throw keyRefused();
    }

    await ctx.runMutation(internal.functions.sheetSources.spendSourceRows, { sourceId: source.sourceId, rows: args.rows.length });

    let result;
    try {
      result = await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: source.workspaceId,
        scope: access.scope,
        grantedNames: access.grantedNames,
        actorName: `${access.actorName ?? "someone"} via ${source.name}`,
        // The path is the key's own, never the caller's.
        operation: { kind: "sheetAppend", path: source.path, rows: args.rows },
      });
    } catch (error) {
      // The sheet is gone, or its maker can no longer see it: the same refusal as a key taken back.
      if (error instanceof ConvexError && (error.data as { code?: string } | null)?.code === "FILE_NOT_FOUND") throw keyRefused();
      throw error;
    }
    const appended = result.kind === "sheetAppended" ? result.appended : 0;
    await ctx.runMutation(internal.functions.sheetSources.noteSourceUse, { sourceId: source.sourceId, rows: appended });
    return { appended };
  },
});
