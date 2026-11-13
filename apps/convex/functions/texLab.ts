/**
 * THE TEX ARCHITECTURE LAB'S SAVING (tex.lc/admin/lab; Dev2, 2026-11-13: build
 * the Lab artifact for real, "EXACTLY like the artifact"). The artifact kept
 * versions and case edits in its page database, shared by whoever opened it;
 * here they are two tables every staff member reads and writes, and nobody
 * else can reach. Every handler starts with `requireAdmin`.
 *
 * What is stored is the Lab's own JSON (a graph of steps and wires, the cases'
 * edits), cut to `MAX_JSON` so one save cannot fill a row.
 */

import { ConvexError, v } from "convex/values";
import { query } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { handleForUser } from "./lib/identities";
import { mutation } from "./lib/rowWatch/mutations";

/** A version's JSON fields and a case edit must each fit well inside a row. */
export const MAX_JSON = 400_000;
const VERSION_ID = /^(v[0-9a-z]{1,16}|main)$/;
const CASE_KEY = /^[\w-]{1,40}\/[\w.-]{1,80}$/;

const tooBig = (s: string | undefined) => s !== undefined && s.length > MAX_JSON;

const versionRow = v.object({
  versionId: v.string(),
  name: v.string(),
  authorId: v.union(v.string(), v.null()),
  graph: v.string(),
  picks: v.string(),
  areas: v.union(v.string(), v.null()),
  results: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

/** Every saved version and every case edit, who made each version, and who is asking (for "yours" in the list). */
export const list = query({
  args: {},
  returns: v.object({ me: v.string(), names: v.record(v.string(), v.string()), versions: v.array(versionRow), caseEdits: v.array(v.object({ key: v.string(), data: v.string() })) }),
  handler: async (ctx) => {
    const actor = await requireAdmin(ctx);
    const versions = await ctx.db.query("texLabVersions").collect();
    const caseEdits = await ctx.db.query("texLabCaseEdits").collect();
    // Each author as the console names staff: their handle, else "Someone" (never an address).
    const names: Record<string, string> = {};
    for (const id of new Set(versions.flatMap((r) => (r.authorId ? [r.authorId] : [])))) names[id] = (await handleForUser(ctx, id).then((h) => (h ? "@" + h : null))) ?? "Someone";
    return {
      me: actor.userId,
      names,
      versions: versions.map((r) => ({ versionId: r.versionId, name: r.name, authorId: r.authorId ?? null, graph: r.graph, picks: r.picks, areas: r.areas ?? null, results: r.results, createdAt: r.createdAt, updatedAt: r.updatedAt })),
      caseEdits: caseEdits.map((r) => ({ key: r.key, data: r.data })),
    };
  },
});

/** Save a version (a new one or over itself). `main` keeps only its run results. */
export const saveVersion = mutation({
  args: { versionId: v.string(), name: v.string(), graph: v.string(), picks: v.string(), areas: v.optional(v.string()), results: v.string(), createdAt: v.number() },
  returns: v.null(),
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx);
    if (!VERSION_ID.test(a.versionId)) throw new ConvexError("Not a Lab version id");
    if ([a.graph, a.picks, a.areas, a.results].some(tooBig) || a.name.length > 120) throw new ConvexError("This version is too big to save");
    const now = Date.now();
    const row = await ctx.db
      .query("texLabVersions")
      .withIndex("by_version", (q) => q.eq("versionId", a.versionId))
      .unique();
    const fields = { name: a.name.trim() || "Untitled", graph: a.graph, picks: a.picks, areas: a.areas, results: a.results, updatedAt: now };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("texLabVersions", { versionId: a.versionId, authorId: actor.userId, createdAt: a.createdAt || now, ...fields });
    return null;
  },
});

export const deleteVersion = mutation({
  args: { versionId: v.string() },
  returns: v.null(),
  handler: async (ctx, { versionId }) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("texLabVersions")
      .withIndex("by_version", (q) => q.eq("versionId", versionId))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/** Keep a case edit (or a new case) for every staff member, or drop it with `data: null`. */
export const saveCase = mutation({
  args: { key: v.string(), data: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { key, data }) => {
    await requireAdmin(ctx);
    if (!CASE_KEY.test(key)) throw new ConvexError("Not a case key");
    if (tooBig(data ?? undefined)) throw new ConvexError("This case is too big to save");
    const row = await ctx.db
      .query("texLabCaseEdits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (data === null) {
      if (row) await ctx.db.delete(row._id);
    } else if (row) await ctx.db.patch(row._id, { data, updatedAt: Date.now() });
    else await ctx.db.insert("texLabCaseEdits", { key, data, updatedAt: Date.now() });
    return null;
  },
});
