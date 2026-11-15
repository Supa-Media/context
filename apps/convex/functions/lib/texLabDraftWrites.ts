/**
 * EVERYTHING ELSE THE LAB WRITES TO A DRAFT (Dev2, 2026-11-15: "anything that can be done inside of the lab should be
 * able to be done inside of the MCP"): its name, its Run tab's test picks and areas, the results kept from a run,
 * deleting it, and undoing a change. The graph's own edits are `texLabDrafts.ts` `applyToDraft`; these are the rest,
 * each one revision with what it changed, so the Lab and an AI over `tex_dev` read the same change list either way.
 *
 * Every change keeps its undo (`Undo`): the edits back to the graph before it, and the name, picks and areas it
 * replaced. `revert` applies one as a new revision, refused when a later revision touched the same piece, so undoing
 * never silently drops someone else's work. Kept run results are a record of a run and are never undone.
 */

import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { applyOps, conflicts, diffGraphs, OpError } from "@context/shared/src/texLabOps.cjs";
import type { LabGraphJson, LabOp } from "@context/shared/src/texLabOps.d.cts";
import { keptPart, parseReport } from "@context/shared/src/texLabReport.cjs";
import { MAX_JSON } from "../texLab";

type Row = Doc<"texLabVersions">;
type Picks = Record<string, string[]>;
/** A draft's state as one change sees it: its graph, name, test picks (by area; an area left out runs every case) and run areas (null: the areas its changes touch). */
export type DraftState = { graph: LabGraphJson; name: string; picks: Picks; areas: string[] | null };
/** What undoes a change: edits back, and each name, area's picks and areas it replaced (null: there was none). */
export type Undo = { ops?: LabOp[]; name?: string; picks?: Record<string, string[] | null>; areas?: string[] | null };
export type Described = { keys: string[]; said: string[]; full: string[]; undo: Undo };
type Answer = Record<string, unknown> & { status: string };

const NAME_MAX = 120;
const AREA = /^[\w-]{1,40}$/;
const CASE_ID = /^[\w.-]{1,80}$/;
const MAX_PICKS = 500;
const SHORT = 120;
const FULL = 1000;
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + "…" : s);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const read = <T,>(text: string | undefined | null, fallback: T): T => {
  try {
    return typeof text === "string" && text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

export const stateOf = (row: Row): DraftState | null => {
  const graph = read<LabGraphJson | null>(row.graph, null);
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
  return { graph, name: row.name, picks: read<Picks>(row.picks, {}) ?? {}, areas: read<string[] | null>(row.areas, null) };
};

/**
 * What turned state `a` into state `b`: the pieces touched, a line each (short for the Lab, whole for `tex_dev`), and
 * the undo back to `a`. A graph the edits cannot express is one whole-graph change.
 */
export function describeChange(a: DraftState, b: DraftState): Described {
  const out: Described = { keys: [], said: [], full: [], undo: {} };
  const line = (text: string) => {
    out.said.push(cut(text, SHORT));
    out.full.push(cut(text, FULL));
  };
  const ops = diffGraphs(a.graph, b.graph);
  if (ops.length) {
    try {
      const applied = applyOps(a.graph, ops);
      out.keys.push(...applied.keys);
      out.said.push(...applied.said);
      out.full.push(...applied.full);
    } catch {
      out.keys.push("*");
      line("saved the whole draft");
    }
    out.undo.ops = diffGraphs(b.graph, a.graph);
  }
  if (a.name !== b.name) {
    out.keys.push("name");
    line(`renamed ${a.name} → ${b.name}`);
    out.undo.name = a.name;
  }
  for (const area of new Set([...Object.keys(a.picks), ...Object.keys(b.picks)])) {
    if (same(a.picks[area], b.picks[area])) continue;
    out.keys.push(`run:picks:${area}`);
    const ids = b.picks[area];
    line(ids ? `set the run's ${area} cases to ${ids.length ? ids.join(", ") : "none"}` : `set the run to every ${area} case`);
    (out.undo.picks ??= {})[area] = a.picks[area] ?? null;
  }
  if (!same(a.areas, b.areas)) {
    out.keys.push("run:areas");
    line(b.areas ? `set the run's areas to ${b.areas.join(", ") || "none"}` : "set the run's areas back to the ones its changes touch");
    out.undo.areas = a.areas;
  }
  return out;
}

/** The undo kept on a change row, or nothing when it would not fit in one. */
export const undoText = (undo: Undo) => {
  const text = JSON.stringify(undo);
  return text.length <= MAX_JSON ? text : undefined;
};

/** Write state `b` over the row as one revision, if it changed anything; answers the revision and what it said. Throws `OpError` when it would not fit. */
async function commit(ctx: MutationCtx, row: Row, a: DraftState, b: DraftState, by: Id<"users">, via: string, now: number, prefix = "") {
  const d = describeChange(a, b);
  const rev = row.rev ?? 0;
  if (d.keys.length === 0) return { rev, said: [] as string[], full: [] as string[] };
  const graph = JSON.stringify(b.graph);
  const picks = JSON.stringify(b.picks);
  if (graph.length > MAX_JSON || picks.length > MAX_JSON) throw new OpError("the draft would be too big to save");
  const said = d.said.map((s) => prefix + s);
  const full = d.full.map((s) => prefix + s);
  await ctx.db.patch(row._id, { graph, name: b.name, picks, areas: b.areas === null ? undefined : JSON.stringify(b.areas), rev: rev + 1, updatedAt: now });
  await ctx.db.insert("texLabChanges", { versionId: row.versionId, rev: rev + 1, by, via, keys: d.keys, said, full, undo: undoText(d.undo), at: now });
  return { rev: rev + 1, said, full };
}

const bad = (error: string): Answer => ({ status: "bad_request", error });

/** Rename a draft: the Lab's version name, a revision of its own. */
export async function renameDraft(ctx: MutationCtx, row: Row, name: unknown, by: Id<"users">, via: string, now = Date.now()): Promise<Answer> {
  const next = typeof name === "string" ? name.trim().slice(0, NAME_MAX) : "";
  if (!next) return bad("rename takes a name");
  const a = stateOf(row);
  if (a === null) return bad("this draft's graph could not be read");
  const done = await commit(ctx, row, a, { ...a, name: next }, by, via, now);
  return { status: "ok", rev: done.rev, name: next, said: done.full };
}

/** `commit`, with a draft too big to save answered as a refusal. */
async function tried(run: () => Promise<Answer>): Promise<Answer> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OpError) return bad(error.message);
    throw error;
  }
}

/** A list of area names, or null. */
function areasOf(value: unknown): string[] | null | "bad" {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 60 || !value.every((x) => typeof x === "string" && AREA.test(x))) return "bad";
  return [...new Set(value as string[])];
}

/**
 * The Run tab's setup, as the Lab keeps it: `picks` by area (the cases ticked; an area left out runs every case) and
 * `areas` (the areas the run covers; null: the ones its changes touch). `picks` here merges by area: an area's list
 * replaces that area's, and null for an area ticks every case again. `whole` replaces the picks outright (the Lab's
 * own save, which sends them all).
 */
export async function setRunSetup(ctx: MutationCtx, row: Row, input: { picks?: unknown; areas?: unknown; whole?: boolean }, by: Id<"users">, via: string, now = Date.now()): Promise<Answer> {
  const a = stateOf(row);
  if (a === null) return bad("this draft's graph could not be read");
  if (input.picks === undefined && input.areas === undefined) return bad("run_setup takes picks ({ <area>: [case ids] | null }) or areas ([areas] | null), or both");
  const picks: Picks = input.whole ? {} : { ...a.picks };
  if (input.picks !== undefined) {
    if (!input.picks || typeof input.picks !== "object" || Array.isArray(input.picks)) return bad("picks is { <area>: [case ids] | null }");
    for (const [area, ids] of Object.entries(input.picks as Record<string, unknown>)) {
      if (!AREA.test(area)) return bad(`"${area}" is not an area`);
      if (ids === null) delete picks[area];
      else if (Array.isArray(ids) && ids.length <= MAX_PICKS && ids.every((x) => typeof x === "string" && CASE_ID.test(x))) picks[area] = [...new Set(ids as string[])];
      else return bad(`picks for ${area} must be a list of case ids (at most ${MAX_PICKS}), or null for every case`);
    }
  }
  let areas = a.areas;
  if (input.areas !== undefined) {
    const got = areasOf(input.areas);
    if (got === "bad") return bad("areas is a list of area names, or null for the ones its changes touch");
    areas = got;
  }
  return await tried(async () => {
    const done = await commit(ctx, row, a, { ...a, picks, areas }, by, via, now);
    return { status: "ok", rev: done.rev, picks, areas, said: done.full };
  });
}

/**
 * Keep a pasted run report with a draft, or with main, as the Run tab's "Keep these results" does: read with the
 * Lab's own reader, never with its "## Lab replay" part (that is the person's own chat, and every staff member reads
 * a version). A draft's kept result is a revision with a line saying so; main keeps only results.
 */
export async function keepResults(ctx: MutationCtx, row: Row | null, input: { report?: unknown; link?: unknown }, by: Id<"users">, via: string, now = Date.now()): Promise<Answer> {
  if (typeof input.report !== "string" || !input.report.trim()) return bad("keep_results takes report: the run's \"## Lab run\" block as it printed");
  if (input.report.length > MAX_JSON) return bad("that report is too big to keep");
  const kept = keptPart(input.report);
  if (!kept) return bad("that report is only a Lab replay, which is the person's own chat and is never kept with a version");
  const result = { ...parseReport(kept, now), link: typeof input.link === "string" ? input.link.trim().slice(0, 500) : "", by };
  const summary = { pass: result.pass ?? null, headline: result.headline ?? null, regressed: result.regressed ?? null, areas: result.areas };
  if (row === null) {
    // Main's results row, as `saveMainResults` keeps it: no graph, only results.
    const main = await ctx.db
      .query("texLabVersions")
      .withIndex("by_version", (q) => q.eq("versionId", "main"))
      .unique();
    const results = [...read<unknown[]>(main?.results, []), result];
    const text = JSON.stringify(results);
    if (text.length > MAX_JSON) return bad("main's kept results are full");
    if (main) await ctx.db.patch(main._id, { results: text, updatedAt: now });
    else await ctx.db.insert("texLabVersions", { versionId: "main", name: "main", graph: JSON.stringify({ nodes: [], edges: [] }), picks: "{}", results: text, createdAt: now, updatedAt: now, rev: 0 });
    return { status: "ok", kept: summary, results: results.length, noted: Object.keys(result.areas).length ? null : "no \"**area:** practice x/y\" lines found; kept the text" };
  }
  const results = [...read<unknown[]>(row.results, []), result];
  const text = JSON.stringify(results);
  if (text.length > MAX_JSON) return bad("this draft's kept results are full");
  const rev = (row.rev ?? 0) + 1;
  const said = `kept a run's results${result.headline ? ": " + result.headline : ""}`;
  await ctx.db.patch(row._id, { results: text, rev, updatedAt: now });
  // Kept results are a record of a run: the change has no undo, and a revert leaves them.
  await ctx.db.insert("texLabChanges", { versionId: row.versionId, rev, by, via, keys: ["results"], said: [cut(said, SHORT)], full: [cut(said, FULL)], at: now });
  return { status: "ok", rev, kept: summary, results: results.length, noted: Object.keys(result.areas).length ? null : "no \"**area:** practice x/y\" lines found; kept the text" };
}

/** A draft row and every change it recorded: `texLab.deleteVersion`'s body, for both doors. Main is never deleted. */
export async function deleteDraftRows(ctx: MutationCtx, versionId: string) {
  if (versionId === "main") return false;
  const row = await ctx.db
    .query("texLabVersions")
    .withIndex("by_version", (q) => q.eq("versionId", versionId))
    .unique();
  if (row) await ctx.db.delete(row._id);
  for (const change of await ctx.db
    .query("texLabChanges")
    .withIndex("by_version_rev", (q) => q.eq("versionId", versionId))
    .collect())
    await ctx.db.delete(change._id);
  return row !== null;
}

/** A change nothing undoes and a revert passes over: asking to promote (no pieces) and kept results. */
const passOver = (c: Doc<"texLabChanges">) => c.undo === undefined && c.keys.every((k) => k === "results");

/** Apply one change's undo to a state. Throws `OpError` when its edits no longer apply. */
function undone(s: DraftState, u: Undo): DraftState {
  const graph = u.ops?.length ? applyOps(s.graph, u.ops).graph : s.graph;
  const picks = { ...s.picks };
  for (const [area, ids] of Object.entries(u.picks ?? {})) {
    if (ids === null) delete picks[area];
    else picks[area] = ids;
  }
  return { graph, name: u.name ?? s.name, picks, areas: "areas" in u ? (u.areas ?? null) : s.areas };
}

/**
 * Undo, as a new revision (itself undoable): `{ rev }` undoes the one change recorded at that revision, refused when a
 * later revision touched one of the same pieces (undo that one first, or go back with `to`); `{ to }` undoes every
 * change after revision `to`, newest first, back to how the draft was then. Kept run results stay either way.
 */
export async function revertDraft(ctx: MutationCtx, row: Row, input: { rev?: unknown; to?: unknown }, by: Id<"users">, via: string, now = Date.now()): Promise<Answer> {
  const cur = row.rev ?? 0;
  const one = typeof input.rev === "number" && Number.isSafeInteger(input.rev);
  const to = typeof input.to === "number" && Number.isSafeInteger(input.to);
  if (one === to) return bad("revert takes rev (undo the change made at that revision) or to (undo every change after that revision)");
  const from = one ? (input.rev as number) - 1 : (input.to as number);
  if (from < 0 || from >= cur) return bad(`this draft is at revision ${cur}; ${one ? `rev ${input.rev}` : `to ${input.to}`} is not a change it can undo`);
  const rows = await ctx.db
    .query("texLabChanges")
    .withIndex("by_version_rev", (q) => q.eq("versionId", row.versionId).gt("rev", from))
    .collect();
  let chain: Doc<"texLabChanges">[];
  if (one) {
    const target = rows.find((c) => c.rev === input.rev);
    if (!target || target.undo === undefined) return bad(target && target.keys.includes("results") ? "kept run results are a record of a run; they stay" : `the change at revision ${input.rev} cannot be undone (it was made before undo was kept, or it changed nothing a revert undoes)`);
    const later = rows.filter((c) => c.rev > target.rev);
    const lost = conflicts(target.keys, later.flatMap((c) => c.keys));
    if (lost.length) {
      const by_ = later.filter((c) => conflicts(c.keys, target.keys).length);
      return { status: "conflict", rev: cur, keys: lost, later: by_.map((c) => ({ rev: c.rev, via: c.via, said: c.full ?? c.said })), next: `revert those first (newest first), or revert { to: ${target.rev - 1} }` };
    }
    chain = [target];
  } else {
    chain = rows.filter((c) => !passOver(c)).reverse();
    const stuck = chain.find((c) => c.undo === undefined);
    if (stuck) return bad(`the change at revision ${stuck.rev} cannot be undone (it was made before undo was kept), so the draft cannot go back past it; revert { to: ${stuck.rev} } is as far as it goes`);
  }
  const a = stateOf(row);
  if (a === null) return bad("this draft's graph could not be read");
  let b = a;
  try {
    for (const c of chain) b = undone(b, read<Undo>(c.undo, {}));
  } catch (error) {
    if (error instanceof OpError) return bad(`the undo no longer applies: ${error.message}`);
    throw error;
  }
  const label = one ? `undid rev ${input.rev}: ` : `went back to rev ${input.to}: `;
  return await tried(async () => {
    const done = await commit(ctx, row, a, b, by, via, now, label);
    if (done.said.length === 0) return { status: "ok", rev: cur, said: [], note: "nothing to undo: the draft already is that way" };
    return { status: "ok", rev: done.rev, said: done.full };
  });
}

/** The state a whole save from the Lab writes (`texLab.saveVersion`), for its change line and undo. */
export function savedState(row: Row, next: { graph: string; name: string; picks: string; areas?: string }): { a: DraftState; b: DraftState } | null {
  const a = stateOf(row);
  const graph = read<LabGraphJson | null>(next.graph, null);
  if (a === null || !graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null;
  return { a, b: { graph, name: next.name, picks: read<Picks>(next.picks, {}) ?? {}, areas: read<string[] | null>(next.areas, null) } };
}
