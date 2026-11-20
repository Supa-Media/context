/**
 * THE LAB'S EVALS (Dev2, 2026-11-20: "create an evals tab one of them being the LongMemEval, and build out the adapter
 * for this eval"; "LongMemEval is primarily for context, its not supposed to test tex"; chose "Save each session raw,
 * then file"; `docs/decisions/testing/lab-evals.md`).
 *
 * The Lab's Evals tab and `tex_dev` `evals`/`eval_run` start a run here, which dispatches
 * `.github/workflows/lab-eval-run.yml` at once with GH_ADMIN_TOKEN (as `texLabRuns.ts` does). The workflow downloads
 * the public benchmark, runs the slice on main's code or a same-repository pull request's or branch's
 * (`node apps/mcp/bench/evals/cli.mjs`), and reports its stage, its rows in batches and its summary through `report`
 * with the deploy key. Public data only; never a Training, Dev or Test set conversation; nothing gates CI.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalQuery, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { CODE, LAB_REPO, codeOf } from "./texLabRuns";

/** The benchmarks offered, and how many questions each holds. */
export const EVAL_BENCHES = [
  { id: "longmemeval-s", title: "LongMemEval", variant: "S", total: 500, about: "500 questions, each after about 50 past chat sessions (about 115k tokens)." },
  { id: "longmemeval-oracle", title: "LongMemEval", variant: "Oracle", total: 500, about: "The same 500 questions with only the sessions that hold the evidence." },
] as const;
export const EVAL_WORKFLOW = "lab-eval-run.yml";
/** The first slice a new benchmark is sized on (Dev2's ask: a 50-question slice first, then the full run's cost). */
export const DEFAULT_N = 50;
/** One person's runs waiting or running at once, and started in a day: a guard against a runaway loop. */
export const MAX_OPEN = 3;
export const MAX_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A run still going after this long counts as lost (the workflow's own limit is six hours). */
export const STALE_MS = 7 * 60 * 60 * 1000;
const LIST_LIMIT = 30;
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d{1,14}(\/attempts\/\d{1,3})?$/;
const COMMIT = /^[0-9a-f]{40}$/;

type Run = Doc<"labEvalRuns">;
type Who = { userId: Id<"users">; via: string };

const stageV = v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed"));

// ── What is kept ──────────────────────────────────────────────────────────

const text = (x: unknown, most: number) => (typeof x === "string" ? x.slice(0, most) : "");
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const bool = (x: unknown) => (x === true ? true : x === false ? false : null);

/** One reported row, cleaned: the fields the Lab shows, each cut to its length. */
export function cleanRow(x: unknown) {
  const r = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const usd = (r.usd && typeof r.usd === "object" ? r.usd : {}) as Record<string, unknown>;
  const calls = Array.isArray(r.calls) ? r.calls : [];
  return {
    id: text(r.id, 80),
    type: text(r.type, 40),
    ability: text(r.ability, 20),
    question: text(r.question, 2_000),
    expected: text(r.expected, 1_000),
    date: text(r.date, 40),
    answer: text(r.answer, 4_000),
    correct: bool(r.correct),
    judgeSaid: text(r.judgeSaid, 80),
    sessions: num(r.sessions),
    saved: num(r.saved),
    saveErrors: num(r.saveErrors),
    filings: num(r.filings),
    filingErrors: num(r.filingErrors),
    calls: calls.slice(0, 40).map((c) => {
      const call = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      return { tool: text(call.tool, 40), input: text(JSON.stringify(call.input ?? {}), 300), chars: num(call.chars), error: call.error === true };
    }),
    usd: { filing: num(usd.filing), reading: num(usd.reading), judging: num(usd.judging) },
    tokens: (() => {
      const t = (r.tokens && typeof r.tokens === "object" ? r.tokens : {}) as Record<string, unknown>;
      return { filing: num(t.filing), reading: num(t.reading), judging: num(t.judging) };
    })(),
    usdEstimated: r.usdEstimated === true,
    ms: num(r.ms),
    error: r.error ? text(r.error, 300) : null,
  };
}

const share = (x: unknown) => {
  const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  return { n: num(s.n), correct: num(s.correct), pct: typeof s.pct === "number" ? s.pct : null };
};

/** A number or null, kept as reported (a weekly share the usage read could not give is null, not 0). */
const numOrNull = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/**
 * A Claude Code run's spend (`apps/mcp/bench/evals/ccUsage.mjs`): measured tokens and the weekly limit's share, in
 * place of dollars it did not cost. Absent on a gateway run.
 */
export function cleanCc(x: unknown) {
  if (!x || typeof x !== "object") return undefined;
  const c = x as Record<string, unknown>;
  const byModel = Object.fromEntries(
    Object.entries(c.byModel && typeof c.byModel === "object" ? (c.byModel as Record<string, unknown>) : {})
      .slice(0, 8)
      .map(([k, v]) => {
        const m = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
        return [k.slice(0, 40), { calls: num(m.calls), input: num(m.input), output: num(m.output), cacheRead: num(m.cacheRead), cacheWrite: num(m.cacheWrite) }];
      }),
  );
  return {
    calls: num(c.calls),
    tokens: num(c.tokens),
    input: num(c.input),
    output: num(c.output),
    cacheRead: num(c.cacheRead),
    cacheWrite: num(c.cacheWrite),
    byModel,
    weeklyPct: numOrNull(c.weeklyPct),
    weeklyBefore: numOrNull(c.weeklyBefore),
    weeklyAfter: numOrNull(c.weeklyAfter),
    weeklyWhy: c.weeklyWhy ? text(c.weeklyWhy, 160) : null,
    fullRunTokens: numOrNull(c.fullRunTokens),
    fullRunWeeklyPct: numOrNull(c.fullRunWeeklyPct),
  };
}

/** The run's summary, cleaned: scores per ability and type, costs and settings. */
export function cleanSummary(x: unknown) {
  const s = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const scores = (s.scores && typeof s.scores === "object" ? s.scores : {}) as Record<string, unknown>;
  const usd = (scores.usd && typeof scores.usd === "object" ? scores.usd : {}) as Record<string, unknown>;
  const map = (m: unknown) => Object.fromEntries(Object.entries(m && typeof m === "object" ? (m as Record<string, unknown>) : {}).slice(0, 20).map(([k, val]) => [k.slice(0, 40), share(val)]));
  return {
    total: num(s.total),
    n: num(s.n),
    reader: text(s.reader, 40),
    judge: text(s.judge, 40),
    filings: num(s.filings),
    ms: num(s.ms),
    fullRunUsd: num(s.fullRunUsd),
    ...(cleanCc(s.cc) ? { cc: cleanCc(s.cc) } : {}),
    scores: {
      ...share(scores),
      asked: num(scores.asked),
      failed: num(scores.failed),
      byAbility: map(scores.byAbility),
      byType: map(scores.byType),
      usd: { filing: num(usd.filing), reading: num(usd.reading), judging: num(usd.judging), total: num(usd.total), estimated: usd.estimated === true },
    },
  };
}

// ── Reading ───────────────────────────────────────────────────────────────

async function runOf(ctx: QueryCtx, id: string): Promise<Run | null> {
  const runId = ctx.db.normalizeId("labEvalRuns", id);
  return runId ? await ctx.db.get(runId) : null;
}

const lost = (r: Run, now: number) => (r.stage === "queued" || r.stage === "running") && now - r.startedAt > STALE_MS;

function shown(r: Run, now: number) {
  return {
    id: r._id,
    bench: r.bench,
    n: r.n,
    models: r.models,
    code: r.code ?? null,
    commit: r.commit ?? null,
    stage: lost(r, now) ? "failed" : r.stage,
    ghRunUrl: r.ghRunUrl ?? null,
    via: r.via,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
    rows: r.rows ?? 0,
    summary: r.summary ?? null,
    error: lost(r, now) ? "the GitHub run never reported back" : (r.error ?? null),
  };
}

export async function listEvalRuns(ctx: QueryCtx, now: number) {
  const runs = await ctx.db.query("labEvalRuns").withIndex("by_started").order("desc").take(LIST_LIMIT);
  return runs.map((r) => shown(r, now));
}

export async function evalRun(ctx: QueryCtx, id: string, now: number) {
  const r = await runOf(ctx, id);
  if (!r) return null;
  const rows = await ctx.db
    .query("labEvalRows")
    .withIndex("by_run", (q) => q.eq("runId", r._id))
    .collect();
  return { ...shown(r, now), questions: rows.map((row) => row.row) };
}

// ── Starting ──────────────────────────────────────────────────────────────

/** Start a run, or say why not. Shared by the Lab (`start`) and `tex_dev` (`evalAction`). */
export async function startEvalRun(ctx: MutationCtx, who: Who, a: Record<string, unknown>, now: number): Promise<{ status: "ok"; runId: Id<"labEvalRuns"> } | { status: "bad_request" | "refused"; error: string }> {
  const benchId = a.bench === undefined || a.bench === null ? EVAL_BENCHES[0].id : a.bench;
  const bench = EVAL_BENCHES.find((b) => b.id === benchId);
  if (!bench) return { status: "bad_request", error: `bench is one of ${EVAL_BENCHES.map((b) => b.id).join(", ")}` };
  const n = a.n === undefined || a.n === null ? DEFAULT_N : a.n;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > bench.total) return { status: "bad_request", error: `n is 1 to ${bench.total} questions (${DEFAULT_N} by default)` };
  const models = a.models === undefined || a.models === null ? "gw" : a.models;
  if (models !== "gw" && models !== "cc") return { status: "bad_request", error: "models is gw (the AI gateway) or cc (Claude Code)" };
  const code = a.code === undefined ? null : codeOf(a.code);
  if (code === undefined) return { status: "bad_request", error: `code is main, a pull request (#3401) or a branch name (${CODE.source})` };
  const mine = await ctx.db
    .query("labEvalRuns")
    .withIndex("by_by", (q) => q.eq("by", who.userId).gte("startedAt", now - DAY_MS))
    .collect();
  const open = mine.filter((r) => (r.stage === "queued" || r.stage === "running") && !lost(r, now));
  if (open.length >= MAX_OPEN) return { status: "refused", error: `you already have ${open.length} eval runs waiting or running (at most ${MAX_OPEN}): wait for one to finish` };
  if (mine.length >= MAX_PER_DAY) return { status: "refused", error: `you have started ${MAX_PER_DAY} eval runs in the last day, the most a day allows` };
  const runId = await ctx.db.insert("labEvalRuns", {
    bench: bench.id,
    n,
    models,
    ...(code ? { code } : {}),
    stage: "queued",
    by: who.userId,
    via: who.via.slice(0, 60),
    startedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.functions.labEvals.dispatch, { runId });
  return { status: "ok", runId };
}

export async function removeEvalRun(ctx: MutationCtx, id: string, now: number): Promise<{ status: "ok" } | { status: "bad_request"; error: string }> {
  const r = await runOf(ctx, id);
  if (!r) return { status: "bad_request", error: `there is no eval run ${id}` };
  if ((r.stage === "queued" || r.stage === "running") && !lost(r, now)) return { status: "bad_request", error: "this run is still going: remove it once it has finished" };
  const rows = await ctx.db
    .query("labEvalRows")
    .withIndex("by_run", (q) => q.eq("runId", r._id))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
  await ctx.db.delete(r._id);
  return { status: "ok" };
}

export const benches = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return EVAL_BENCHES;
  },
});

export const start = mutation({
  args: { bench: v.optional(v.string()), n: v.optional(v.number()), models: v.optional(v.string()), code: v.optional(v.string()) },
  returns: v.object({ runId: v.id("labEvalRuns") }),
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx);
    const answer = await startEvalRun(ctx, { userId: actor.userId, via: "lab" }, a, Date.now());
    if (answer.status !== "ok") throw new ConvexError(answer.error);
    return { runId: answer.runId };
  },
});

export const remove = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const answer = await removeEvalRun(ctx, id, Date.now());
    if (answer.status !== "ok") throw new ConvexError(answer.error);
    return null;
  },
});

export const list = query({
  args: {},
  returns: v.array(v.any()),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await listEvalRuns(ctx, Date.now());
  },
});

export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    return await evalRun(ctx, id, Date.now());
  },
});

// ── The MCP's door (`texLabDrafts.forGateway`, which has checked the caller) ──

/** `tex_dev` `evals` (the benchmarks and runs, or one run whole), `eval_run` and `eval_remove`; null for any other action. */
export async function evalAction(ctx: MutationCtx, who: Who, action: string, a: Record<string, unknown>, now: number): Promise<Record<string, unknown> | null> {
  if (action === "eval_run") {
    const answer = await startEvalRun(ctx, who, { bench: a.bench, n: a.n, models: a.models, code: a.code }, now);
    // "refused" is the door's own answer for a caller who may not; a cap is a bad request.
    return answer.status === "ok" ? { status: "ok", id: answer.runId } : { status: "bad_request", error: answer.error };
  }
  if (action === "eval_remove") return typeof a.id === "string" ? await removeEvalRun(ctx, a.id, now) : { status: "bad_request", error: "eval_remove takes the run's id" };
  if (action === "evals") {
    if (typeof a.id === "string") {
      const run = await evalRun(ctx, a.id, now);
      return run ? { status: "ok", run } : { status: "bad_request", error: `there is no eval run ${a.id}` };
    }
    return { status: "ok", benches: EVAL_BENCHES, runs: await listEvalRuns(ctx, now) };
  }
  return null;
}

// ── The workflow's door (deploy key) ──────────────────────────────────────

/** What the workflow runs. */
export const job = internalQuery({
  args: { runId: v.string() },
  returns: v.any(),
  handler: async (ctx, { runId }) => {
    const r = await runOf(ctx, runId);
    if (!r) return null;
    return { id: r._id, bench: r.bench, n: r.n, models: r.models, code: r.code ?? null };
  },
});

/**
 * The workflow's stage; its rows, a batch at a time, numbered from `from`; and, at the end, its summary or why it
 * failed. A finished run stays finished.
 */
export const report = internalMutation({
  args: {
    runId: v.string(),
    stage: stageV,
    ghRunUrl: v.optional(v.string()),
    commit: v.optional(v.string()),
    from: v.optional(v.number()),
    rows: v.optional(v.array(v.any())),
    summary: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, a) => {
    const r = await runOf(ctx, a.runId);
    if (!r) throw new ConvexError("No such run");
    if (r.stage === "done" || r.stage === "failed") return null;
    if (a.ghRunUrl !== undefined && !RUN_URL.test(a.ghRunUrl)) throw new ConvexError("Not a GitHub run address");
    if (a.commit !== undefined && !COMMIT.test(a.commit)) throw new ConvexError("Not a commit");
    if (a.rows !== undefined) {
      const from = a.from ?? 0;
      if (!Number.isSafeInteger(from) || from < 0 || a.rows.length > 50 || from + a.rows.length > r.n) throw new ConvexError("Rows out of range");
      for (const [k, row] of a.rows.entries()) {
        const i = from + k;
        const kept = await ctx.db
          .query("labEvalRows")
          .withIndex("by_run", (q) => q.eq("runId", r._id).eq("i", i))
          .unique();
        if (kept) await ctx.db.patch(kept._id, { row: cleanRow(row) });
        else await ctx.db.insert("labEvalRows", { runId: r._id, i, row: cleanRow(row) });
      }
    }
    const finished = a.stage === "done" || a.stage === "failed";
    const stage = a.stage === "queued" && r.stage === "running" ? "running" : a.stage;
    const summary = a.summary !== undefined ? cleanSummary(a.summary) : undefined;
    const counted =
      a.rows !== undefined
        ? (
            await ctx.db
              .query("labEvalRows")
              .withIndex("by_run", (q) => q.eq("runId", r._id))
              .collect()
          ).length
        : undefined;
    await ctx.db.patch(r._id, {
      stage,
      ...(a.ghRunUrl !== undefined ? { ghRunUrl: a.ghRunUrl } : {}),
      ...(a.commit !== undefined ? { commit: a.commit } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(counted !== undefined ? { rows: counted } : {}),
      ...(a.error !== undefined ? { error: a.error.slice(0, 300) } : {}),
      ...(finished ? { finishedAt: Date.now() } : {}),
    });
    return null;
  },
});

export const dispatch = internalAction({
  args: { runId: v.id("labEvalRuns") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const token = process.env.GH_ADMIN_TOKEN;
    const fail = (error: string) => ctx.runMutation(internal.functions.labEvals.report, { runId, stage: "failed", error });
    if (!token) {
      await fail("this deployment cannot start GitHub runs (GH_ADMIN_TOKEN is not set)");
      return null;
    }
    let res: Response;
    try {
      res = await fetch(`https://api.github.com/repos/${LAB_REPO}/actions/workflows/${EVAL_WORKFLOW}/dispatches`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "context-tex-lab" },
        body: JSON.stringify({ ref: "main", inputs: { run_id: runId } }),
      });
    } catch {
      await fail("GitHub could not be reached to start the run");
      return null;
    }
    if (res.status !== 200 && res.status !== 204) {
      const said = ((await res.json().catch(() => null)) as { message?: unknown } | null)?.message;
      await fail(`GitHub refused to start the run (${res.status}${typeof said === "string" ? `: ${said.slice(0, 160)}` : ""})`);
      return null;
    }
    const body = res.status === 200 ? ((await res.json().catch(() => null)) as { html_url?: unknown } | null) : null;
    if (typeof body?.html_url === "string" && RUN_URL.test(body.html_url)) await ctx.runMutation(internal.functions.labEvals.report, { runId, stage: "queued", ghRunUrl: body.html_url });
    return null;
  },
});
