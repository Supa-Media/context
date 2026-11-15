/**
 * LIVE TEX LAB DRAFTS (Dev2, 2026-11-15: "create config with ID whatever, and then in that session ... you can edit
 * the config. I can edit the config in the UI, the AI can edit the config there, and then we're just collaborating";
 * design https://claude.ai/artifact/1nwVCYrrvYzRzJTGLYKGvk, the recommended set).
 *
 * A draft is a saved Lab version (`texLabVersions`). Two doors change it, with the same small edits
 * (`packages/shared/src/texLabOps.cjs`):
 *
 *  - the Lab page, as a staff member (`requireAdmin`, with its second factor): `applyEdits`, `changes`;
 *  - the MCP's `tex_dev` tool, through the gateway (`lib/gatewayRoutes/texDev.ts`): `forGateway`, which takes the
 *    grant's token hash and answers only a staff member who owns or edits the pinned context (`@context-lc`, the
 *    people who edit Tex's AI setup, as `run_model`), on an AI client of their own: never one of Context's own clients, so
 *    Tex itself can never reach it.
 *
 * Every batch raises the draft's revision and records what it touched. A batch made against an older revision lands
 * unless a revision since touched one of the same pieces; then it is refused with the revision it lost to and the
 * value now there, so neither side overwrites the other without seeing it. Nothing here changes Tex: only Promote
 * does, through its pull request (`texLabPromote.ts`).
 */

import { ConvexError, v } from "convex/values";
import { query, type MutationCtx, type QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { applyOps, conflicts, diffGraphs, keysOf, OpError } from "@context/shared/src/texLabOps.cjs";
import { requireAdmin, userIsStaff } from "./lib/admin";
import { handleForUser } from "./lib/identities";
import { resolveLiveGrant } from "./lib/controlPlane/liveGrants";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { getMembership } from "./lib/workspaceAuth";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { MAX_JSON } from "./texLab";
import { pageForUser } from "./texPage";
import { clampDays } from "./texLabToolStats";
import { toolStatsReport } from "./lib/adminFns/texToolStats";
import { deleteDraftRows, describeChange, keepResults, renameDraft, revertDraft, savedState, setRunSetup as writeRunSetup, undoText } from "./lib/texLabDraftWrites";

/** At most this many change rows answered at once; an AI further behind reads the draft again. */
export const MAX_CHANGES = 100;
/** An AI client counts as in a draft this long after its last call. */
export const LIVE_MS = 10 * 60_000;
const NAME_MAX = 120;

type Row = Doc<"texLabVersions">;
type Change = { rev: number; who: string; via: string; said: string[]; at: number };

const parseGraph = (s: string) => {
  try {
    return JSON.parse(s) as { nodes: Array<{ id: string } & Record<string, unknown>>; edges: Array<{ from: string; to: string; mode: string; when: string[] }> };
  } catch {
    return null;
  }
};

async function rowOf(ctx: QueryCtx, versionId: string): Promise<Row | null> {
  if (versionId === "main" || !/^v[0-9a-z]{1,16}$/.test(versionId)) return null;
  return await ctx.db
    .query("texLabVersions")
    .withIndex("by_version", (q) => q.eq("versionId", versionId))
    .unique();
}

async function whoIs(ctx: QueryCtx, cache: Map<string, string>, id: Id<"users">) {
  let name = cache.get(id);
  if (name === undefined) {
    name = (await handleForUser(ctx, id).then((h) => (h ? "@" + h : null))) ?? "Someone";
    cache.set(id, name);
  }
  return name;
}

/** The changes after revision `since`, oldest first, each with who made it; `full`, each line uncut (for `tex_dev`). */
async function changesAfter(ctx: QueryCtx, versionId: string, since: number, full = false): Promise<Change[]> {
  const rows = await ctx.db
    .query("texLabChanges")
    .withIndex("by_version_rev", (q) => q.eq("versionId", versionId).gt("rev", since))
    .take(MAX_CHANGES);
  const names = new Map<string, string>();
  const out: Change[] = [];
  for (const r of rows) out.push({ rev: r.rev, who: await whoIs(ctx, names, r.by), via: r.via, said: full ? (r.full ?? r.said) : r.said, at: r.at });
  return out;
}

export type EditAnswer =
  | { status: "ok"; rev: number; said: string[]; others: Change[] }
  | { status: "conflict"; rev: number; keys: string[]; now: Record<string, unknown>; others: Change[] }
  | { status: "bad_request"; error: string };

/**
 * One batch of edits from either door. `baseRev` is the revision the editor last saw; `via` is "lab" or the AI
 * client's name. `others` is what anyone else changed since `baseRev`, so an editor is never working blind.
 */
export async function applyToDraft(ctx: MutationCtx, row: Row, baseRev: number, ops: unknown, by: Id<"users">, via: string, now = Date.now()): Promise<EditAnswer> {
  const rev = row.rev ?? 0;
  if (!Number.isSafeInteger(baseRev) || baseRev < 0 || baseRev > rev) return { status: "bad_request", error: `revision ${baseRev} is not one this draft has had (it is at ${rev})` };
  const graph = parseGraph(row.graph);
  if (graph === null) return { status: "bad_request", error: "this draft's graph could not be read" };
  const since = baseRev < rev ? await changesAfter(ctx, row.versionId, baseRev) : [];
  const others = since.filter((c) => c.via !== via);
  if (!Array.isArray(ops)) return { status: "bad_request", error: "ops must be a list of edits" };
  const keys = [...new Set(ops.flatMap((op) => keysOf(op)))];
  if (baseRev < rev) {
    const touched = (
      await ctx.db
        .query("texLabChanges")
        .withIndex("by_version_rev", (q) => q.eq("versionId", row.versionId).gt("rev", baseRev))
        .collect()
    ).flatMap((c) => c.keys);
    const lost = conflicts(keys, touched);
    if (lost.length > 0) return { status: "conflict", rev, keys: lost, now: valuesAt(graph, lost), others };
  }
  let applied;
  try {
    applied = applyOps(graph, ops);
  } catch (error) {
    if (error instanceof OpError) return { status: "bad_request", error: error.message };
    throw error;
  }
  const text = JSON.stringify(applied.graph);
  if (text.length > MAX_JSON) return { status: "bad_request", error: "the draft would be too big to save" };
  await ctx.db.patch(row._id, { graph: text, rev: rev + 1, updatedAt: now });
  // The undo is the edits back to the graph before (`tex_dev` `revert`).
  await ctx.db.insert("texLabChanges", { versionId: row.versionId, rev: rev + 1, by, via, keys: applied.keys, said: applied.said, full: applied.full, undo: undoText({ ops: diffGraphs(applied.graph, graph) }), at: now });
  return { status: "ok", rev: rev + 1, said: applied.said, others };
}

/** What a draft holds now at each refused piece: a field's value, a whole step, a wire or null when it is gone. */
function valuesAt(graph: NonNullable<ReturnType<typeof parseGraph>>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const field = /^n:([^:]+):(.+)$/.exec(k);
    const step = /^n:([^:]+)$/.exec(k);
    const wire = /^e:([^>]+)>([^>]+)>(.+)$/.exec(k);
    if (field) out[k] = graph.nodes.find((n) => n.id === field[1])?.[field[2]] ?? null;
    else if (step) out[k] = graph.nodes.find((n) => n.id === step[1]) ?? null;
    else if (wire) out[k] = graph.edges.filter((e) => e.from === wire[1] && e.to === wire[2] && (wire[3] === "*" || e.mode === wire[3]));
    else out[k] = "the whole graph changed";
  }
  return out;
}

const countOf = (text: string | undefined) => {
  try {
    const list = text ? (JSON.parse(text) as unknown) : [];
    return Array.isArray(list) ? list.length : 0;
  } catch {
    return 0;
  }
};

/**
 * A whole save from the Lab (`texLab.saveVersion`) as a change: the edits it made over what was there, a rename, the
 * Run tab's picks and areas, and a run's kept results, so an AI in the draft reads "set fd effort high → medium", not
 * "something changed". It keeps its undo like every change (`lib/texLabDraftWrites.ts`).
 */
export async function recordSave(ctx: MutationCtx, row: Row, newGraph: string, by: Id<"users">, now = Date.now(), next?: { name: string; picks: string; areas?: string; results: string }) {
  const states = savedState(row, { graph: newGraph, name: next?.name ?? row.name, picks: next?.picks ?? row.picks, areas: next ? next.areas : row.areas });
  let keys = ["*"];
  let said = ["saved the whole draft"];
  let full = said;
  let undo: string | undefined;
  if (states) {
    const d = describeChange(states.a, states.b);
    [keys, said, full, undo] = [d.keys, d.said, d.full, d.keys.length ? undoText(d.undo) : undefined];
  }
  if (next !== undefined && countOf(next.results) > countOf(row.results)) {
    keys = [...keys, "results"];
    said = [...said, "kept a run's results"];
    full = [...full, "kept a run's results"];
  }
  if (keys.length === 0) return row.rev ?? 0;
  const rev = (row.rev ?? 0) + 1;
  await ctx.db.insert("texLabChanges", { versionId: row.versionId, rev, by, via: "lab", keys, said, full, undo, at: now });
  return rev;
}

// ── The Lab's door ─────────────────────────────────────────────────────────

/** A batch of edits from the Lab page, as a staff member. `ops` is the edits as JSON. */
export const applyEdits = mutation({
  args: { versionId: v.string(), baseRev: v.number(), ops: v.string() },
  returns: v.any(),
  handler: async (ctx, a): Promise<EditAnswer> => {
    const actor = await requireAdmin(ctx);
    if (a.ops.length > MAX_JSON) throw new ConvexError("These edits are too big to save");
    const row = await rowOf(ctx, a.versionId);
    if (row === null) throw new ConvexError("Save this version before editing it live");
    let ops: unknown;
    try {
      ops = JSON.parse(a.ops);
    } catch {
      return { status: "bad_request", error: "the edits are not JSON" };
    }
    return await applyToDraft(ctx, row, a.baseRev, ops, actor.userId, "lab");
  },
});

/**
 * The Run tab's test picks and areas from the Lab, saved on a live draft as a revision of their own (the Lab sends
 * them whole; `tex_dev`'s `run_setup` is the same write, merged by area).
 */
export const setRunSetup = mutation({
  args: { versionId: v.string(), picks: v.string(), areas: v.union(v.string(), v.null()) },
  returns: v.any(),
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx);
    if (a.picks.length > MAX_JSON || (a.areas ?? "").length > MAX_JSON) throw new ConvexError("This setup is too big to save");
    const row = await rowOf(ctx, a.versionId);
    if (row === null) throw new ConvexError("Save this version before editing it live");
    let picks: unknown;
    let areas: unknown;
    try {
      picks = JSON.parse(a.picks);
      areas = a.areas === null ? null : JSON.parse(a.areas);
    } catch {
      return { status: "bad_request", error: "the setup is not JSON" };
    }
    return await writeRunSetup(ctx, row, { picks, areas, whole: true }, actor.userId, "lab");
  },
});

/** The Lab's change list for a draft: every change after `since`, and the AI client in it now, if any. */
export const changes = query({
  args: { versionId: v.string(), since: v.number() },
  returns: v.object({ rev: v.number(), live: v.union(v.null(), v.object({ client: v.string(), who: v.string(), at: v.number() })), changes: v.array(v.object({ rev: v.number(), who: v.string(), via: v.string(), said: v.array(v.string()), at: v.number() })) }),
  handler: async (ctx, { versionId, since }) => {
    await requireAdmin(ctx);
    const row = await rowOf(ctx, versionId);
    if (row === null) return { rev: 0, live: null, changes: [] };
    const live = row.live ? { client: row.live.client, who: await whoIs(ctx, new Map(), row.live.by), at: row.live.at } : null;
    return { rev: row.rev ?? 0, live, changes: await changesAfter(ctx, versionId, Math.max(0, since)) };
  },
});

// ── The MCP's door (through the gateway) ───────────────────────────────────

/**
 * The person an AI client's grant speaks for, when they may develop on Tex: a live grant of an AI client of their own
 * (never one of Context's `context_*` clients, which include Tex's), whose person owns or edits the pinned context.
 */
export async function texDeveloper(ctx: QueryCtx, hashedAccessToken: string): Promise<{ userId: Id<"users">; client: string } | null> {
  const live = await resolveLiveGrant(ctx, hashedAccessToken);
  if (live === null || live.grant.clientId.startsWith("context_")) return null;
  const userId = live.grant.userId;
  if (!userId) return null;
  const pinned = await pinnedContextWorkspace(ctx);
  if (pinned === null) return null;
  const membership = await getMembership(ctx, pinned._id, userId);
  if (membership === null || (membership.role !== "owner" && membership.role !== "editor")) return null;
  // And staff, as the Lab itself is (`requireAdmin`): the drafts, case edits and tool stats are the Lab's, so this door
  // is never wider than the Lab's own. (An MCP grant has no second-factor step; its OAuth sign-in stands for it.)
  if (!(await userIsStaff(ctx, userId))) return null;
  const client = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", live.grant.clientId))
    .unique();
  return { userId, client: (client?.clientName ?? "").trim().slice(0, 60) || "An AI client" };
}

const draftOf = async (ctx: QueryCtx, row: Row) => ({
  id: row.versionId,
  name: row.name,
  by: row.authorId ? await whoIs(ctx, new Map(), row.authorId) : "Someone",
  rev: row.rev ?? 0,
  updatedAt: row.updatedAt,
  live: row.live && Date.now() - row.live.at < LIVE_MS ? { client: row.live.client, at: row.live.at } : null,
  promote: row.promote ? { state: row.promote.state, pr: row.promote.pr ?? null, why: row.promote.why ?? null } : null,
});

/**
 * The Lab's other writes over `tex_dev` (`lib/texLabDraftWrites.ts`): rename, delete, the Run tab's setup, keeping a
 * run's results (on a draft or on main), revert; and `get` of main, which answers main's kept results. Null for any
 * other action. Main is Tex as it runs: only its results are written here.
 */
async function draftWrite(ctx: MutationCtx, dev: { userId: Id<"users">; client: string }, action: string, a: Record<string, unknown>, now: number): Promise<Record<string, unknown> | null> {
  if (!["rename", "delete", "run_setup", "keep_results", "revert", "get"].includes(action)) return null;
  if (a.draft === "main") {
    if (action === "keep_results") return await keepResults(ctx, null, a, dev.userId, dev.client, now);
    if (action === "get") {
      const main = await ctx.db
        .query("texLabVersions")
        .withIndex("by_version", (q) => q.eq("versionId", "main"))
        .unique();
      return { status: "ok", id: "main", name: "main", results: main?.results ?? "[]" };
    }
    return { status: "bad_request", error: "main is Tex as it runs: make a draft (create) to change it. Main keeps only its run results (keep_results)." };
  }
  if (action === "get") return null;
  const row = typeof a.draft === "string" ? await rowOf(ctx, a.draft) : null;
  if (row === null) return { status: "not_found" };
  if (action === "delete") {
    await deleteDraftRows(ctx, row.versionId);
    return { status: "ok", deleted: row.versionId, name: row.name };
  }
  await ctx.db.patch(row._id, { live: { client: dev.client, by: dev.userId, at: now } });
  if (action === "rename") return await renameDraft(ctx, row, a.name, dev.userId, dev.client, now);
  if (action === "run_setup") return await writeRunSetup(ctx, row, { picks: a.picks, areas: a.areas }, dev.userId, dev.client, now);
  if (action === "keep_results") return await keepResults(ctx, row, a, dev.userId, dev.client, now);
  return await revertDraft(ctx, row, { rev: a.rev, to: a.to }, dev.userId, dev.client, now);
}

const newId = () => "v" + Date.now().toString(36) + Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, "0");

/**
 * Every `tex_dev` call that reads or changes a draft, and the Tex page data its probing reads. Always an answer with
 * a `status`: `refused` for anyone who may not, `not_found` for a draft that is not there.
 */
export const forGateway = internalMutation({
  args: { hashedAccessToken: v.string(), action: v.string(), args: v.any() },
  returns: v.any(),
  handler: async (ctx, { hashedAccessToken, action, args }) => {
    const dev = await texDeveloper(ctx, hashedAccessToken);
    if (dev === null) return { status: "refused" };
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const now = Date.now();
    const written = await draftWrite(ctx, dev, action, a, now);
    if (written !== null) return written;
    if (action === "page") return await pageForUser(ctx, dev.userId);
    if (action === "list") {
      const rows = (await ctx.db.query("texLabVersions").collect()).filter((r) => r.versionId !== "main").sort((x, y) => y.updatedAt - x.updatedAt);
      return { status: "ok", drafts: await Promise.all(rows.map((r) => draftOf(ctx, r))) };
    }
    // The Lab's other tabs, so whatever the Lab shows a developer sees too (Dev2, 2026-11-15): its Tools tab, and the
    // bench cases' shared edits (`texLab.saveCase`).
    if (action === "tool_stats") return { status: "ok", stats: await toolStatsReport(ctx, clampDays(typeof a.days === "number" ? a.days : undefined), now) };
    if (action === "cases") return { status: "ok", caseEdits: (await ctx.db.query("texLabCaseEdits").collect()).map((r) => ({ key: r.key, data: r.data, updatedAt: r.updatedAt })) };
    if (action === "case") {
      const key = typeof a.key === "string" ? a.key : "";
      const data = a.data === null ? null : typeof a.data === "string" ? a.data : undefined;
      if (!/^[\w-]{1,40}\/[\w.-]{1,80}$/.test(key) || data === undefined) return { status: "bad_request", error: "case takes key <area>/<case id> and data (the case as JSON text, or null to drop the edit)" };
      if (data !== null && data.length > MAX_JSON) return { status: "bad_request", error: "this case is too big to save" };
      const row = await ctx.db
        .query("texLabCaseEdits")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      if (data === null) {
        if (row) await ctx.db.delete(row._id);
      } else if (row) await ctx.db.patch(row._id, { data, updatedAt: now });
      else await ctx.db.insert("texLabCaseEdits", { key, data, updatedAt: now });
      return { status: "ok" };
    }
    if (action === "create") {
      const name = typeof a.name === "string" ? a.name.trim().slice(0, NAME_MAX) : "";
      if (!name) return { status: "bad_request", error: "a draft needs a name" };
      let graph: string | null = null;
      if (typeof a.from === "string" && a.from !== "main") {
        const from = await rowOf(ctx, a.from);
        if (from === null) return { status: "not_found" };
        graph = from.graph;
      } else if (typeof a.graph === "string") graph = a.graph;
      const parsed = graph === null ? null : parseGraph(graph);
      if (parsed === null || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return { status: "bad_request", error: "the draft has no steps and wires" };
      if (graph!.length > MAX_JSON) return { status: "bad_request", error: "the draft would be too big to save" };
      const versionId = newId();
      await ctx.db.insert("texLabVersions", { versionId, name, authorId: dev.userId, graph: graph!, picks: "{}", results: "[]", createdAt: now, updatedAt: now, rev: 1, live: { client: dev.client, by: dev.userId, at: now } });
      await ctx.db.insert("texLabChanges", { versionId, rev: 1, by: dev.userId, via: dev.client, keys: ["*"], said: [`made this draft from ${typeof a.from === "string" ? a.from : "a config"}`], at: now });
      return { status: "ok", id: versionId, rev: 1, name };
    }
    const row = typeof a.draft === "string" ? await rowOf(ctx, a.draft) : null;
    if (row === null) return { status: "not_found" };
    await ctx.db.patch(row._id, { live: { client: dev.client, by: dev.userId, at: now } });
    if (action === "get") return { status: "ok", ...(await draftOf(ctx, row)), graph: row.graph, picks: row.picks, areas: row.areas ?? null, results: row.results };
    if (action === "changes") {
      const since = typeof a.since === "number" && Number.isSafeInteger(a.since) ? a.since : 0;
      return { status: "ok", rev: row.rev ?? 0, changes: await changesAfter(ctx, row.versionId, since, true) };
    }
    if (action === "edit") {
      const baseRev = typeof a.rev === "number" ? a.rev : -1;
      return await applyToDraft(ctx, row, baseRev, a.ops, dev.userId, dev.client, now);
    }
    if (action === "promote") {
      if (row.promote?.state === "asked") return { status: "ok", promote: "asked" };
      await ctx.db.patch(row._id, { promote: { state: "asked", by: dev.userId, at: now } });
      await ctx.db.insert("texLabChanges", { versionId: row.versionId, rev: (row.rev ?? 0) + 1, by: dev.userId, via: dev.client, keys: [], said: ["asked to promote this draft"], at: now });
      await ctx.db.patch(row._id, { rev: (row.rev ?? 0) + 1 });
      return { status: "ok", promote: "asked" };
    }
    return { status: "bad_request", error: `no action "${action}"` };
  },
});
