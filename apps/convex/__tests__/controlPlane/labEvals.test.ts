/**
 * The Lab's Evals (`functions/labEvals.ts`; Dev2, 2026-11-20: "create an evals tab one of them being the LongMemEval").
 * Two doors, one store: the Lab as a staff member (`api.functions.labEvals.*`), and `tex_dev`'s `evals`/`eval_run`/
 * `eval_remove` through `forGateway`. Pinned: who may start one, the bench and slice checks, the caps, the dispatch to
 * GitHub (and a deployment without the token failing the run), and the workflow's reports (rows in batches, cleaned;
 * a finished run stays finished).
 *
 * Sabotage record (temporary local edits to functions/labEvals.ts, restored, 2026-11-20):
 *   MAX_OPEN check removed                      "MAX_OPEN waiting runs ..." fails
 *   report without finished-stays-finished      "rows come in batches ..." fails
 *   cleanRow keeping every field                "rows come in batches ..." fails
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import { addMember, createUser, createWorkspace, drainScheduled, gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./fixtures.helpers";
import { withSession } from "../session.helpers";
import { DEFAULT_N, MAX_OPEN, MAX_PER_DAY, MAX_SEARCH_PER_DAY, cleanRow, cleanSearch, cleanSummary } from "../../functions/labEvals";

vi.setConfig({ testTimeout: 30_000 });

const STAFF = "staff@example.invalid";
const RUN_URL = "https://github.com/example/repo/actions/runs/123";
const SHA = "b".repeat(40);

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[] = [];

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`);
  vi.stubEnv("GH_ADMIN_TOKEN", "ghp_fake_for_tests");
  calls = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/dispatches")) return new Response(JSON.stringify({ workflow_run_id: 123, html_url: RUN_URL }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world(role: "editor" | "member" = "editor") {
  const tenants = await twoConnectedTenants();
  const staff = await createUser(tenants.t, STAFF);
  const pinned = await createWorkspace(tenants.t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  await addMember(tenants.t, pinned, tenants.alice, role, staff);
  const door = async (action: string, args: Record<string, unknown> = {}, token = ACCESS_A): Promise<Record<string, any>> =>
    (await tenants.t.mutation(internal.functions.texLabDrafts.forGateway, { hashedAccessToken: await hashToken(token), action, args })) as Record<string, any>;
  return { ...tenants, staff, door, lab: withSession(tenants.t, staff) };
}

const row = (i: number, correct: boolean) => ({
  id: `q${i}`,
  type: "multi-session",
  ability: "multi",
  question: "How many bikes do I own?",
  expected: "3",
  answer: "x".repeat(10_000),
  correct,
  judgeSaid: "yes",
  sessions: 40,
  saved: 40,
  filings: 4,
  calls: [{ tool: "search", input: { query: "bikes" }, chars: 900, error: false }],
  usd: { filing: 0.01, reading: 0.002, judging: 0.001 },
  ms: 60_000,
  error: null,
  secretField: "never kept",
});

describe("who may start an eval run", () => {
  test("a stranger and a plain member are refused, and nothing is stored or dispatched", async () => {
    const w = await world();
    expect(await w.door("eval_run", {}, ACCESS_B)).toEqual({ status: "refused" });
    const member = await world("member");
    expect(await member.door("eval_run", {})).toEqual({ status: "refused" });
    const stranger = withSession(w.t, await createUser(w.t, "stranger@example.invalid"));
    await expect(stranger.mutation(api.functions.labEvals.start, {})).rejects.toThrow();
    await expect(stranger.query(api.functions.labEvals.list, {})).rejects.toThrow();
    await drainScheduled(w.t);
    expect(calls).toHaveLength(0);
  });
});

describe("starting an eval run", () => {
  test("the Lab's start records a 50-question LongMemEval run and dispatches lab-eval-run.yml on main", async () => {
    const w = await world();
    const { runId } = await w.lab.mutation(api.functions.labEvals.start, {});
    await drainScheduled(w.t);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/Supa-Media/context/actions/workflows/lab-eval-run.yml/dispatches");
    expect(calls[0].body).toMatchObject({ ref: "main", inputs: { run_id: runId } });
    expect(await w.lab.query(api.functions.labEvals.get, { id: runId })).toMatchObject({ bench: "longmemeval-s", n: DEFAULT_N, models: "gw", stage: "queued", ghRunUrl: RUN_URL, via: "lab", questions: [] });
    expect(await w.t.query(internal.functions.labEvals.job, { runId })).toEqual({ id: runId, bench: "longmemeval-s", n: DEFAULT_N, models: "gw", code: null });
  });

  test("tex_dev eval_run takes a bench, a slice, models and code, and refuses what is not one", async () => {
    const { door, t } = await world();
    const ran = await door("eval_run", { bench: "longmemeval-oracle", n: 10, models: "cc", code: "#3401" });
    expect(ran).toMatchObject({ status: "ok" });
    expect(await t.query(internal.functions.labEvals.job, { runId: ran.id })).toMatchObject({ bench: "longmemeval-oracle", n: 10, models: "cc", code: "#3401" });
    expect(await door("eval_run", { bench: "locomo" })).toMatchObject({ status: "bad_request" });
    expect(await door("eval_run", { n: 0 })).toMatchObject({ status: "bad_request" });
    expect(await door("eval_run", { n: 501 })).toMatchObject({ status: "bad_request" });
    expect(await door("eval_run", { models: "api" })).toMatchObject({ status: "bad_request" });
    expect(await door("eval_run", { code: "--upload-pack" })).toMatchObject({ status: "bad_request" });
  });

  test("a day's memory runs and search runs are counted apart: a full memory day still starts a search run", async () => {
    const { door, t } = await world();
    for (let i = 0; i < MAX_PER_DAY; i += 1) {
      const { id } = await door("eval_run", { n: 1 });
      await t.mutation(internal.functions.labEvals.report, { runId: id, stage: "done", from: 0, rows: [] });
    }
    expect(await door("eval_run", { n: 1 })).toMatchObject({ error: expect.stringContaining(`${MAX_PER_DAY} memory eval runs`) });
    expect(await door("eval_run", { bench: "search-hard" })).toMatchObject({ status: "ok" });
    expect(MAX_SEARCH_PER_DAY).toBeGreaterThan(MAX_PER_DAY);
  });

  test("MAX_OPEN waiting runs is the most a person has; a finished one frees its place", async () => {
    const { door, t } = await world();
    const ids = [];
    for (let i = 0; i < MAX_OPEN; i += 1) ids.push((await door("eval_run", { n: 5 })).id);
    expect(await door("eval_run", { n: 5 })).toMatchObject({ status: "bad_request", error: expect.stringContaining(`at most ${MAX_OPEN}`) });
    await t.mutation(internal.functions.labEvals.report, { runId: ids[0], stage: "failed", error: "x" });
    expect(await door("eval_run", { n: 5 })).toMatchObject({ status: "ok" });
  });

  test("a deployment without GH_ADMIN_TOKEN fails the run, saying so", async () => {
    vi.stubEnv("GH_ADMIN_TOKEN", "");
    const { door, t } = await world();
    const { id } = await door("eval_run", {});
    await drainScheduled(t);
    expect((await door("evals", { id })).run).toMatchObject({ stage: "failed", error: expect.stringContaining("GH_ADMIN_TOKEN") });
  });
});

describe("the workflow's reports", () => {
  test("rows come in batches, cleaned and cut; the summary lands at the end; a finished run stays finished", async () => {
    const { door, t } = await world();
    const { id } = await door("eval_run", { n: 3 });
    await t.mutation(internal.functions.labEvals.report, { runId: id, stage: "running", commit: SHA });
    await t.mutation(internal.functions.labEvals.report, { runId: id, stage: "running", from: 0, rows: [row(0, true), row(1, false)] });
    await t.mutation(internal.functions.labEvals.report, { runId: id, stage: "running", from: 2, rows: [row(2, true)] });
    await expect(t.mutation(internal.functions.labEvals.report, { runId: id, stage: "running", from: 3, rows: [row(3, true)] })).rejects.toThrow();
    const summary = { total: 500, n: 3, reader: "claude-haiku-5-5", judge: "claude-sonnet-5-5", filings: 4, fullRunUsd: 2.17, scores: { n: 3, correct: 2, pct: 66.7, byAbility: { multi: { n: 3, correct: 2, pct: 66.7 } }, usd: { total: 0.039 } } };
    await t.mutation(internal.functions.labEvals.report, { runId: id, stage: "done", summary });
    await t.mutation(internal.functions.labEvals.report, { runId: id, stage: "failed", error: "late" });
    const { run } = await door("evals", { id });
    expect(run).toMatchObject({ stage: "done", commit: SHA, rows: 3, error: null, summary: { fullRunUsd: 2.17, scores: { correct: 2, byAbility: { multi: { pct: 66.7 } } } } });
    expect(run.questions).toHaveLength(3);
    expect(run.questions[0].answer).toHaveLength(4_000);
    expect(run.questions[0]).not.toHaveProperty("secretField");
    expect(run.questions[1]).toMatchObject({ id: "q1", correct: false, calls: [{ tool: "search", input: '{"query":"bikes"}' }] });
    const listed = await door("evals", {});
    expect(listed.benches.map((b: { id: string }) => b.id)).toEqual(["longmemeval-s", "longmemeval-oracle", "enterprise-rag-notes", "enterprise-rag-notes-split", "enterprise-rag-notes-full", "herb", "longmemeval-retrieval", "nanobeir", "nanobeir-gate", "search-hard", "search-real"]);
    expect(listed.runs[0]).toMatchObject({ id, stage: "done" });
    expect(listed.runs[0]).not.toHaveProperty("questions");
  });

  test("a finished run is removed with its rows; one still going is not", async () => {
    const { door, t } = await world();
    const { id } = await door("eval_run", { n: 2 });
    expect(await door("eval_remove", { id })).toMatchObject({ status: "bad_request" });
    await t.mutation(internal.functions.labEvals.report, { runId: id, stage: "done", from: 0, rows: [row(0, true)] });
    expect(await door("eval_remove", { id })).toEqual({ status: "ok" });
    expect(await t.run(async (ctx) => await ctx.db.query("labEvalRows").collect())).toHaveLength(0);
  });
});

test("POST /gateway/tex/dev passes the eval actions through to the store", async () => {
  const { t } = await world();
  const ran = await bodyOf(await gatewayPost(t, "/gateway/tex/dev", { accessToken: ACCESS_A, action: "eval_run", args: { n: 3 } }));
  expect(ran).toMatchObject({ status: "ok" });
  expect(await bodyOf(await gatewayPost(t, "/gateway/tex/dev", { accessToken: ACCESS_A, action: "evals", args: {} }))).toMatchObject({ status: "ok", runs: [{ id: ran.id, n: 3 }] });
  expect(await bodyOf(await gatewayPost(t, "/gateway/tex/dev", { accessToken: ACCESS_A, action: "eval_remove", args: { id: ran.id } }))).toMatchObject({ status: "bad_request" });
});

test("a Claude Code run's summary keeps its measured tokens and weekly share; an unread share stays null, never 0", () => {
  const cc = { calls: 9, tokens: 1234, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, byModel: { haiku: { calls: 9, input: 1 } }, weeklyPct: null, weeklyWhy: "the usage read answered 403", fullRunTokens: 12340, fullRunWeeklyPct: null, extra: "dropped" };
  const kept = cleanSummary({ n: 50, total: 500, cc }) as { cc?: Record<string, unknown> };
  expect(kept.cc).toMatchObject({ calls: 9, tokens: 1234, weeklyPct: null, weeklyWhy: "the usage read answered 403", fullRunTokens: 12340, fullRunWeeklyPct: null });
  expect(kept.cc).not.toHaveProperty("extra");
  expect(cleanSummary({ n: 1, total: 2 })).not.toHaveProperty("cc");
});

// ── The Search suite (`apps/mcp/bench/evals/searchSuite.mjs` rowOf and searchScores) ──

const searchRow = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  type: "bikes",
  ability: "search",
  question: "where did I put the spare key?",
  expected: "@seyi/home/keys.md",
  date: "",
  answer: "@seyi/home/keys.md\n@seyi/home/drawer.md",
  correct: true,
  rank: 1,
  hits: 2,
  sessions: 0,
  ms: 812,
  error: null,
  ...over,
});

describe("the Search suite's rows and scores", () => {
  test("a search row keeps its rank and hit count; a privacy row keeps a null rank; a Claude row has no rank", () => {
    expect(cleanRow(searchRow())).toMatchObject({ rank: 1, hits: 2, correct: true, ms: 812 });
    expect(cleanRow(searchRow({ rank: null, hits: 0, correct: false }))).toMatchObject({ rank: null, hits: 0 });
    expect(cleanRow(searchRow({ rank: "3", hits: "x" }))).toMatchObject({ rank: null, hits: 0 });
    expect(cleanRow(row(0, true))).toMatchObject({ rank: null, hits: 0 });
  });

  test("a search summary keeps its block, cleaned; per-kind and per-ability maps are capped at 20 keys", () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`kind${i}-${"k".repeat(60)}`, { n: 2, firstPct: 50, extra: 1 }]));
    const summary = cleanSummary({
      total: 40,
      n: 40,
      ms: 9000,
      scores: { n: 40, correct: 30, pct: 75, usd: { total: 0, filing: 0, reading: 0, judging: 0 } },
      search: { n: 40, first: 30, top5: 36, found: 38, firstPct: 75, top5Pct: 90, foundPct: 95, mrr: 0.84, p50Ms: 120, p95Ms: 480, errors: 0, leaks: ["x"], byKind: many, byAbility: { update: { n: 3, recallAny5Pct: null, extra: 2 } } },
    }) as { search?: Record<string, any> };
    expect(summary.search).toMatchObject({ n: 40, first: 30, top5: 36, found: 38, firstPct: 75, top5Pct: 90, foundPct: 95, mrr: 0.84, p50Ms: 120, p95Ms: 480, errors: 0 });
    expect(summary.search).not.toHaveProperty("leaks");
    expect(summary.search).not.toHaveProperty("recallAny5Pct");
    expect(Object.keys(summary.search?.byKind ?? {})).toHaveLength(20);
    expect(Object.keys(Object.values(summary.search?.byKind ?? {})[0] ?? {}).sort()).toEqual(["firstPct", "n"]);
    expect(summary.search?.byAbility).toEqual({ update: { n: 3, recallAny5Pct: null } });
  });

  test("a retrieval summary keeps Recall@5 any and all; an unread share and a missing block stay null or absent", () => {
    expect(cleanSearch({ n: 470, first: 1, top5: 2, found: 3, firstPct: null, top5Pct: 1.5, foundPct: 2, mrr: 0.1, p50Ms: 1, p95Ms: 2, errors: 0, recallAny5Pct: 91.2, recallAll5Pct: 80 })).toMatchObject({ recallAny5Pct: 91.2, recallAll5Pct: 80, firstPct: null });
    expect(cleanSearch({ n: 1 })).not.toHaveProperty("recallAny5Pct");
    expect(cleanSearch(undefined)).toBeUndefined();
    expect(cleanSummary({ n: 1, total: 2 })).not.toHaveProperty("search");
  });

  test("a NanoBEIR summary keeps nDCG@10, BM25's reference and each set's scores; another search run has none", () => {
    const s = cleanSearch({ n: 200, first: 120, ndcg10: 0.61, recall10: 0.72, mrr10: 0.58, bm25Ndcg10: 0.55, objectNdcg10: 0.63, bySet: { nq: { n: 50, ndcg10: 0.5, bm25Ndcg10: 0.4, firstPct: 44, objectNdcg10: 0.52, extra: "x" } } });
    expect(s).toMatchObject({ ndcg10: 0.61, bm25Ndcg10: 0.55, objectNdcg10: 0.63, bySet: { nq: { n: 50, ndcg10: 0.5, bm25Ndcg10: 0.4, firstPct: 44 } } });
    expect(s?.bySet?.nq).not.toHaveProperty("extra");
    expect(cleanSearch({ n: 40, first: 27 })).not.toHaveProperty("ndcg10");
  });

  test("the Lab starts a search set on gateway embeddings only: its models choice is dropped, its default slice is the whole set, and search-real runs its 16 Dev cases", async () => {
    const w = await world();
    const hard = await w.door("eval_run", { bench: "search-hard", models: "cc" });
    expect(hard).toMatchObject({ status: "ok" });
    expect(await w.t.query(internal.functions.labEvals.job, { runId: hard.id })).toMatchObject({ bench: "search-hard", n: 44, models: "gw" });
    expect(await w.door("eval_run", { bench: "search-hard", n: 45 })).toMatchObject({ status: "bad_request" });
    const real = await w.door("eval_run", { bench: "search-real" });
    expect(real).toMatchObject({ status: "ok" });
    expect(await w.t.query(internal.functions.labEvals.job, { runId: real.id })).toMatchObject({ bench: "search-real", n: 16, models: "gw" });
    expect(await w.door("eval_run", { bench: "search-real", n: 17 })).toMatchObject({ status: "bad_request" });
    expect(await w.door("eval_run", { bench: "longmemeval-retrieval", n: 470 })).toMatchObject({ status: "ok" });
  });

  test("NanoBEIR runs on gateway embeddings: all 13 sets are 649 queries, the gate's four 200", async () => {
    const w = await world();
    const all = await w.door("eval_run", { bench: "nanobeir", n: 649 });
    expect(await w.t.query(internal.functions.labEvals.job, { runId: all.id })).toMatchObject({ bench: "nanobeir", n: 649, models: "gw" });
    const gate = await w.door("eval_run", { bench: "nanobeir-gate", n: 200, models: "cc" });
    expect(await w.t.query(internal.functions.labEvals.job, { runId: gate.id })).toMatchObject({ bench: "nanobeir-gate", n: 200, models: "gw" });
    expect(await w.door("eval_run", { bench: "nanobeir-gate", n: 201 })).toMatchObject({ status: "bad_request" });
  });

  test("HERB runs on gateway embeddings, all 815 questions at most, and keeps its per-type scores with no BM25 row", async () => {
    const w = await world();
    const all = await w.door("eval_run", { bench: "herb", n: 815, models: "cc" });
    expect(await w.t.query(internal.functions.labEvals.job, { runId: all.id })).toMatchObject({ bench: "herb", n: 815, models: "gw" });
    expect(await w.door("eval_run", { bench: "herb", n: 816 })).toMatchObject({ status: "bad_request" });
    const s = cleanSearch({ n: 815, first: 100, ndcg10: 0.2, recall10: 0.02, mrr10: 0.3, bm25Ndcg10: null, objectNdcg10: 0.18, bySet: { person: { n: 260, ndcg10: 0.15, bm25Ndcg10: null, firstPct: 12 } } });
    expect(s).toMatchObject({ ndcg10: 0.2, bm25Ndcg10: null, bySet: { person: { n: 260, ndcg10: 0.15, bm25Ndcg10: null } } });
  });
});
