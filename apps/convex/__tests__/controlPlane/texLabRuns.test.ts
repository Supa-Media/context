/**
 * Lab runs on GitHub (`functions/texLabRuns.ts`; Dev2, 2026-11-16: "Ok go ahead and build everything"). Two doors, one
 * store: the Lab as a staff member (`api.functions.texLabRuns.*`), and `tex_dev`'s `run`/`runs` through `forGateway`.
 * Pinned: who may start one, the caps, the dispatch to GitHub (and a deployment without the token failing the run
 * rather than leaving it waiting), the workflow's reports (a finished run stays finished, a stage never goes back),
 * what the workflow is handed (the draft's graph and the Dev drafts only), and Promote's gate run following its pull
 * request's "Tex test set" status.
 *
 * Sabotage record (temporary local edits to functions/texLabRuns.ts, restored, 2026-11-16):
 *   MAX_QUEUED check removed                     "MAX_QUEUED waiting runs is the most ..." fails
 *   report without the finished-stays-finished   "a finished run stays finished ..." fails
 *   job handing Training drafts' words           "the workflow is handed ..." fails
 *   followGate ignoring the status state         "Promote makes a gate run ..." fails
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import { addMember, createUser, createWorkspace, drainScheduled, gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./fixtures.helpers";
import { withSession } from "../session.helpers";
import { MAX_PER_DAY, MAX_QUEUED, cleanResults, gateCounts } from "../../functions/texLabRuns";

vi.setConfig({ testTimeout: 30_000 });

const STAFF = "staff@example.invalid";
const RUN_URL = "https://github.com/example/repo/actions/runs/123";
const PR = "https://github.com/example/repo/pull/12";
const SHA = "a".repeat(40);

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let testSet: { state: string; description: string } | null = null;
let replayCheck: { status: string; conclusion: string | null } | null = null;
let prState: { state: string; merged_at: string | null } = { state: "open", merged_at: null };

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`);
  vi.stubEnv("GH_ADMIN_TOKEN", "ghp_fake_for_tests");
  calls = [];
  testSet = null;
  replayCheck = null;
  prState = { state: "open", merged_at: null };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/dispatches")) return new Response(JSON.stringify({ workflow_run_id: 123, html_url: RUN_URL }), { status: 200 });
    if (url.includes("/pulls/12")) return new Response(JSON.stringify({ head: { sha: SHA }, ...prState }), { status: 200 });
    if (url.includes(`/commits/${SHA}/check-runs`)) return new Response(JSON.stringify({ check_runs: replayCheck ? [replayCheck] : [] }), { status: 200 });
    if (url.includes(`/commits/${SHA}/statuses`)) return new Response(JSON.stringify(testSet ? [{ context: "Tex test set", ...testSet }] : []), { status: 200 });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

const runsOf = async (t: Awaited<ReturnType<typeof world>>["t"]) => await t.run(async (ctx) => await ctx.db.query("texLabRuns").collect());

describe("who may start a run", () => {
  test("a stranger and a plain member are refused, and nothing is stored or dispatched", async () => {
    const w = await world();
    expect(await w.door("run", { draft: "main", kind: "dev" }, ACCESS_B)).toEqual({ status: "refused" });
    const member = await world("member");
    expect(await member.door("run", { draft: "main", kind: "dev" })).toEqual({ status: "refused" });
    const stranger = withSession(w.t, await createUser(w.t, "stranger@example.invalid"));
    await expect(stranger.mutation(api.functions.texLabRuns.start, { versionId: "main", kind: "dev" })).rejects.toThrow();
    await expect(stranger.query(api.functions.texLabRuns.list, {})).rejects.toThrow();
    expect(await runsOf(w.t)).toHaveLength(0);
    await drainScheduled(w.t);
    expect(calls).toHaveLength(0);
  });
});

describe("starting a run", () => {
  test("the Lab's start records the run and dispatches tex-lab-run.yml on main with the run's id; its address comes back", async () => {
    const w = await world();
    const { runId } = await w.lab.mutation(api.functions.texLabRuns.start, { versionId: "main", kind: "dev", models: "cc" });
    await drainScheduled(w.t);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/Supa-Media/context/actions/workflows/tex-lab-run.yml/dispatches");
    expect(calls[0].body).toMatchObject({ ref: "main", inputs: { run_id: runId } });
    expect(await w.lab.query(api.functions.texLabRuns.get, { id: runId })).toMatchObject({ versionId: "main", kind: "dev", models: "cc", stage: "queued", ghRunUrl: RUN_URL, via: "lab" });
  });

  test("tex_dev run takes a chat or a node, refuses a gate run, a bad kind and a draft that is not there", async () => {
    const { door } = await world();
    expect(await door("run", { draft: "main", kind: "chat", conv: "maya-and-tex" })).toMatchObject({ status: "ok" });
    expect(await door("run", { draft: "main", kind: "node", node: "decide", models: "gw" })).toMatchObject({ status: "ok" });
    expect(await door("run", { draft: "main", kind: "gate" })).toMatchObject({ status: "bad_request" });
    expect(await door("run", { draft: "main", kind: "chat" })).toMatchObject({ status: "bad_request" });
    expect(await door("run", { draft: "main", kind: "dev", models: "api" })).toMatchObject({ status: "bad_request" });
    expect(await door("run", { draft: "vnothere", kind: "dev" })).toEqual({ status: "not_found" });
  });

  test("a run may name the Training set; the workflow is told it, and any other set is refused", async () => {
    const { door, t } = await world();
    const ran = await door("run", { draft: "main", kind: "node", node: "fd", set: "training" });
    expect(ran).toMatchObject({ status: "ok" });
    expect(await t.query(internal.functions.texLabRuns.job, { runId: ran.id })).toMatchObject({ set: "training", nodeId: "fd" });
    const dev = await door("run", { draft: "main", kind: "dev" });
    expect(await t.query(internal.functions.texLabRuns.job, { runId: dev.id })).toMatchObject({ set: "dev" });
    expect(await door("run", { draft: "main", kind: "dev", set: "test" })).toMatchObject({ status: "bad_request", error: expect.stringContaining("training") });
  });

  test("MAX_QUEUED waiting runs is the most a person has; a finished one frees its place", async () => {
    const { door, t } = await world();
    const ids = [];
    for (let i = 0; i < MAX_QUEUED; i += 1) ids.push((await door("run", { draft: "main", kind: "dev" })).id);
    expect(await door("run", { draft: "main", kind: "dev" })).toMatchObject({ status: "bad_request", error: expect.stringContaining(`at most ${MAX_QUEUED}`) });
    await t.mutation(internal.functions.texLabRuns.report, { runId: ids[0], stage: "done", results: { pass: 1, total: 1 } });
    expect(await door("run", { draft: "main", kind: "dev" })).toMatchObject({ status: "ok" });
  });

  test("MAX_PER_DAY runs a day is the most a person starts", async () => {
    const { door, t } = await world();
    for (let i = 0; i < MAX_PER_DAY; i += 1) {
      const { id } = await door("run", { draft: "main", kind: "dev" });
      await t.mutation(internal.functions.texLabRuns.report, { runId: id, stage: "failed", error: "x" });
    }
    expect(await door("run", { draft: "main", kind: "dev" })).toMatchObject({ status: "bad_request", error: expect.stringContaining(`${MAX_PER_DAY} runs`) });
  });

  test("a deployment without GH_ADMIN_TOKEN fails the run, saying so, rather than leaving it waiting", async () => {
    vi.stubEnv("GH_ADMIN_TOKEN", "");
    const { door, t } = await world();
    const { id } = await door("run", { draft: "main", kind: "dev" });
    await drainScheduled(t);
    expect(calls).toHaveLength(0);
    expect((await door("runs", { id })).run).toMatchObject({ stage: "failed", error: expect.stringContaining("GH_ADMIN_TOKEN") });
  });
});

test("a dispatch GitHub refuses fails the run with GitHub's reason", async () => {
  const { door, t } = await world();
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }));
  const { id } = await door("run", { draft: "main", kind: "dev" });
  await drainScheduled(t);
  expect((await door("runs", { id })).run).toMatchObject({ stage: "failed", error: "GitHub refused to start the run (403: Resource not accessible by personal access token)" });
});

test("a run GitHub refused is marked fixed once a later run got to GitHub; a finished run can be removed, a running one can't", async () => {
  const { door, t, lab } = await world();
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }));
  const { id: refused } = await door("run", { draft: "main", kind: "dev" });
  await drainScheduled(t);
  expect((await door("runs", { id: refused })).run).toMatchObject({ stage: "failed", fixedSince: false });
  // The token fixed: GitHub accepts the next dispatch.
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  const { id: later } = await door("run", { draft: "main", kind: "dev" });
  await drainScheduled(t);
  await t.mutation(internal.functions.texLabRuns.report, { runId: later, stage: "running", ghRunUrl: RUN_URL });
  expect((await door("runs", { id: refused })).run.fixedSince).toBe(true);
  expect((await door("runs", {})).runs.find((r: { id: string }) => r.id === refused).fixedSince).toBe(true);
  expect(await door("run_remove", { id: later })).toMatchObject({ status: "bad_request" });
  expect(await door("run_remove", { id: refused })).toEqual({ status: "ok" });
  await expect(lab.mutation(api.functions.texLabRuns.remove, { id: refused })).rejects.toThrow();
  await t.mutation(internal.functions.texLabRuns.report, { runId: later, stage: "done", results: { pass: 1, total: 1 } });
  await lab.mutation(api.functions.texLabRuns.remove, { id: later });
  expect((await door("runs", {})).runs).toEqual([]);
  const stranger = withSession(t, await createUser(t, "stranger2@example.invalid"));
  await expect(stranger.mutation(api.functions.texLabRuns.remove, { id: later })).rejects.toThrow();
});

describe("the workflow's reports", () => {
  test("running, then done with the results kept clean; a finished run stays finished; a stage never goes back", async () => {
    const { door, t } = await world();
    const { id } = await door("run", { draft: "main", kind: "dev" });
    await t.mutation(internal.functions.texLabRuns.report, { runId: id, stage: "running", ghRunUrl: RUN_URL });
    await t.mutation(internal.functions.texLabRuns.report, { runId: id, stage: "queued", ghRunUrl: RUN_URL });
    expect((await door("runs", { id })).run.stage).toBe("running");
    await expect(t.mutation(internal.functions.texLabRuns.report, { runId: id, stage: "running", ghRunUrl: "https://example.invalid/x" })).rejects.toThrow();
    const results = { pass: 1, total: 2, costUsd: 0.00123456, ms: 900, perConv: [{ id: "group-4", pass: 1, total: 2 }], perNode: [{ node: "decide", pass: 1, total: 2 }], rows: [{ convId: "group-4", msgIndex: 3, node: "decide", ok: true, got: "respond", want: "respond", secret: "dropped" }, { convId: "group-4", msgIndex: 9, node: "decide", ok: false, got: "quiet", want: "respond" }] };
    await t.mutation(internal.functions.texLabRuns.report, { runId: id, stage: "done", results });
    await t.mutation(internal.functions.texLabRuns.report, { runId: id, stage: "failed", error: "late" });
    const run = (await door("runs", { id })).run;
    expect(run).toMatchObject({ stage: "done", error: null, results: { pass: 1, total: 2, costUsd: 0.0012 } });
    expect(run.results.rows[0]).toEqual({ convId: "group-4", msgIndex: 3, node: "decide", ok: true, got: "respond", want: "respond" });
    expect(run.finishedAt).toBeGreaterThan(0);
    // The list leaves each run's rows out; one run whole has them.
    const listed = (await door("runs", {})).runs.find((r: { id: string }) => r.id === id);
    expect(listed.results.rows).toBeUndefined();
    expect(listed.results.perNode).toEqual([{ node: "decide", pass: 1, total: 2 }]);
  });

  test("the workflow is handed the draft's graph and the Dev drafts' words, never a Training draft's", async () => {
    const { door, t, lab } = await world();
    const { id: draft } = await door("create", { name: "Try", graph: JSON.stringify({ nodes: [{ id: "text" }], edges: [] }) });
    const conv = (id: string, set: string) => ({ id, title: id, set, kind: "one", members: ["Jo"], msgs: [{ id: "m1", who: "Jo", text: "hi" }] });
    await lab.mutation(api.functions.texSets.create, { conv: conv("dev-a", "dev") });
    await lab.mutation(api.functions.texSets.create, { conv: conv("train-a", "training") });
    const { id } = await door("run", { draft, kind: "dev" });
    const job = (await t.query(internal.functions.texLabRuns.job, { runId: id })) as Record<string, any>;
    expect(job).toMatchObject({ versionId: draft, kind: "dev", models: "gw" });
    expect(JSON.parse(job.graph).nodes).toEqual([{ id: "text" }]);
    expect(job.drafts.find((d: { id: string }) => d.id === "dev-a").conv).toContain('"hi"');
    expect(job.drafts.find((d: { id: string }) => d.id === "train-a")).toEqual({ id: "train-a", set: "training", removed: false });
  });
});

describe("the code a run checks out (Dev2: \"it should run on the PRs code instead of main\")", () => {
  test("a draft names a pull request or branch; its runs carry it to the workflow; a run may name its own; main is none", async () => {
    const { door, t, lab } = await world();
    const { id: draft } = await door("create", { name: "Simpler", graph: JSON.stringify({ nodes: [{ id: "text" }], edges: [] }) });
    expect(await door("code", { draft, code: "https://github.com/Supa-Media/context/pull/3401" })).toEqual({ status: "ok", code: "#3401" });
    expect((await door("get", { draft })).code).toBe("#3401");
    expect((await door("list", {})).drafts[0].code).toBe("#3401");
    expect(await lab.query(api.functions.texLabRuns.codeFor, { versionId: draft })).toBe("#3401");
    const { id } = await door("run", { draft, kind: "dev" });
    expect((await t.query(internal.functions.texLabRuns.job, { runId: id })) as Record<string, unknown>).toMatchObject({ code: "#3401" });
    expect((await door("runs", { id })).run).toMatchObject({ code: "#3401", commit: null });
    // A run's own code wins, main included; main's own runs can name a branch.
    const own = await door("run", { draft, kind: "dev", code: "claude/some-branch" });
    expect((await door("runs", { id: own.id })).run.code).toBe("claude/some-branch");
    const onMain = await door("run", { draft, kind: "dev", code: "main" });
    expect((await door("runs", { id: onMain.id })).run.code).toBeNull();
    // The Lab's field: empty is main again.
    expect(await lab.mutation(api.functions.texLabRuns.setCode, { versionId: draft, code: "" })).toEqual({ code: null });
    expect(await lab.query(api.functions.texLabRuns.codeFor, { versionId: draft })).toBeNull();
  });

  test("never an option, a path climb, a fork's address or main itself; a stranger can't set it", async () => {
    const w = await world();
    const { id: draft } = await w.door("create", { name: "Simpler", graph: JSON.stringify({ nodes: [{ id: "text" }], edges: [] }) });
    for (const code of ["--upload-pack=x", "a..b", "a//b", "x.lock", "has space", "$(id)", "#0", "a;b", "https://github.com/someone/fork/tree/x", "https://github.com/someone/fork/pull/5"]) {
      expect(await w.door("code", { draft, code })).toMatchObject({ status: "bad_request" });
      expect(await w.door("run", { draft, kind: "dev", code })).toMatchObject({ status: "bad_request" });
    }
    expect(await w.door("code", { draft: "main", code: "#3401" })).toMatchObject({ status: "bad_request" });
    expect(await w.door("code", { draft: "vnothere1", code: "#3401" })).toMatchObject({ status: "not_found" });
    expect(await w.door("code", { draft, code: "#3401" }, ACCESS_B)).toEqual({ status: "refused" });
    const stranger = withSession(w.t, await createUser(w.t, "stranger@example.invalid"));
    await expect(stranger.mutation(api.functions.texLabRuns.setCode, { versionId: draft, code: "#3401" })).rejects.toThrow();
    await expect(stranger.query(api.functions.texLabRuns.codeFor, { versionId: draft })).rejects.toThrow();
  });

  test("the workflow reports the commit it checked out, and only a commit", async () => {
    const { door, t } = await world();
    const { id } = await door("run", { draft: "main", kind: "dev" });
    await expect(t.mutation(internal.functions.texLabRuns.report, { runId: id, stage: "running", commit: "main" })).rejects.toThrow();
    await t.mutation(internal.functions.texLabRuns.report, { runId: id, stage: "running", commit: SHA });
    expect((await door("runs", { id })).run).toMatchObject({ stage: "running", commit: SHA, code: null });
  });
});

describe("Promote", () => {
  test("Promote makes a gate run, starts the promote workflow at once, and the run follows its pull request's Test set status", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { door, t } = await world();
    const { id: draft } = await door("create", { name: "Ship", graph: JSON.stringify({ nodes: [{ id: "text" }], edges: [] }) });
    expect(await door("promote", { draft })).toMatchObject({ status: "ok", promote: "asked" });
    await drainScheduled(t);
    // (An earlier test's run dispatch can land here too: only Promote's is this test's.)
    expect(calls.filter((c) => c.url.includes("tex-lab-promote.yml"))).toHaveLength(1);
    let [gate] = (await door("runs", { draft })).runs;
    expect(gate).toMatchObject({ kind: "gate", stage: "queued", pr: null });
    const at = (await t.query(internal.functions.texLabPromote.asked, {}))[0].at;
    await t.mutation(internal.functions.texLabPromote.answered, { versionId: draft, at, pr: PR });
    [gate] = (await door("runs", { draft })).runs;
    expect(gate).toMatchObject({ stage: "running", pr: PR });
    // Still pending: the run keeps waiting.
    testSet = { state: "pending", description: "Running the Test Set on the change and on main" };
    vi.advanceTimersByTime(3 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    expect((await door("runs", { draft })).runs[0].stage).toBe("running");
    testSet = { state: "success", description: "Test Set 12/14 right, main 11/14: no step worse" };
    vi.advanceTimersByTime(3 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    expect((await door("runs", { draft })).runs[0]).toMatchObject({ stage: "done", results: { pass: 12, total: 14 } });
  });

  test("a promotion that reaches no Test set area is done at 0 of 0 once the replay rule passes; a closed pull request fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { door, t } = await world();
    const promoted = async (name: string) => {
      const { id: draft } = await door("create", { name, graph: JSON.stringify({ nodes: [{ id: "text" }], edges: [] }) });
      await door("promote", { draft });
      const at = (await t.query(internal.functions.texLabPromote.asked, {})).find((a) => a.versionId === draft)!.at;
      await t.mutation(internal.functions.texLabPromote.answered, { versionId: draft, at, pr: PR });
      return draft;
    };
    const quiet = await promoted("Moves a step");
    replayCheck = { status: "in_progress", conclusion: null };
    vi.advanceTimersByTime(3 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    expect((await door("runs", { draft: quiet })).runs[0].stage).toBe("running");
    replayCheck = { status: "completed", conclusion: "success" };
    vi.advanceTimersByTime(3 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    expect((await door("runs", { draft: quiet })).runs[0]).toMatchObject({ stage: "done", error: null, results: { pass: 0, total: 0 } });
    replayCheck = null;
    prState = { state: "closed", merged_at: null };
    const closed = await promoted("Closed");
    vi.advanceTimersByTime(3 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();
    expect((await door("runs", { draft: closed })).runs[0]).toMatchObject({ stage: "failed", error: "the pull request was closed without merging" });
  });

  test("a version the promote workflow refuses fails its gate run with why", async () => {
    const { door, t } = await world();
    const { id: draft } = await door("create", { name: "Bad", graph: JSON.stringify({ nodes: [{ id: "text" }], edges: [] }) });
    await door("promote", { draft });
    const at = (await t.query(internal.functions.texLabPromote.asked, {}))[0].at;
    await t.mutation(internal.functions.texLabPromote.answered, { versionId: draft, at, why: "a step the gateway has no code for" });
    expect((await door("runs", { draft })).runs[0]).toMatchObject({ kind: "gate", stage: "failed", error: "a step the gateway has no code for" });
  });
});

test("gateCounts and cleanResults read only counts", () => {
  expect(gateCounts("Test Set 3/9, main 4/9; worse on decide")).toEqual({ pass: 3, total: 9 });
  expect(gateCounts("The Test Set run failed before a verdict: read the run")).toBeNull();
  expect(cleanResults({ pass: "x", rows: [{ convId: 5, ok: "yes" }] })).toMatchObject({ pass: 0, rows: [{ convId: "", ok: false }] });
  expect(cleanResults({ rows: [{ convId: "w", ok: false, detail: "must: a (b)\nTex: c" }] }).rows[0]).toMatchObject({ detail: "must: a (b)\nTex: c" });
  expect(cleanResults({ rows: [{ convId: "w", ok: false, detail: "x".repeat(5_000) }] }).rows[0].detail).toHaveLength(1_500);
  expect(cleanResults({ rows: [{ convId: "w", ok: true }] }).rows[0]).not.toHaveProperty("detail");
  // What handed-off jobs added (Dev2, 2026-11-18, for Finance): numbers only, anything else zero.
  expect(cleanResults({ handoff: { jobs: 2, parts: 4, advisorCalls: 3, usd: 0.040049, perJobUsd: 0.02, advisorCallsPerJob: 1.5, title: "secret" } }).handoff).toEqual({ jobs: 2, parts: 4, advisorCalls: 3, usd: 0.04, perJobUsd: 0.02, advisorCallsPerJob: 1.5 });
  expect(cleanResults({}).handoff).toEqual({ jobs: 0, parts: 0, advisorCalls: 0, usd: 0, perJobUsd: 0, advisorCallsPerJob: 0 });
  // A run that fell back is kept invalid, even when the workflow's own flag is missing.
  expect(cleanResults({})).toMatchObject({ fallbacks: 0, valid: true });
  expect(cleanResults({})).not.toHaveProperty("invalid");
  expect(cleanResults({ fallbacks: 3, valid: false, invalid: "3 Claude call(s) fell back" })).toMatchObject({ fallbacks: 3, valid: false, invalid: "3 Claude call(s) fell back" });
  expect(cleanResults({ fallbacks: 1 })).toMatchObject({ fallbacks: 1, valid: false, invalid: "a Claude call fell back to another model" });
  expect(cleanResults({ rows: [{ convId: "w", ok: true, fallbacks: 2 }] }).rows[0]).toMatchObject({ fallbacks: 2 });
  // A row's route and cost (Dev2, 2026-11-18): pick and door cut to 10, fellBack to 120, sure a number; the rest dropped.
  expect(cleanResults({ rows: [{ convId: "w", ok: true, usd: 0.0123456, route: { pick: "read", sure: 0.9, door: "read", fellBack: "x".repeat(300), secret: "no" } }] }).rows[0]).toMatchObject({
    usd: 0.0123456,
    route: { pick: "read", sure: 0.9, door: "read", fellBack: "x".repeat(120) },
  });
  expect(cleanResults({ rows: [{ convId: "w", ok: true, route: { pick: "quickly-quickly", door: "fd" } }] }).rows[0].route).toEqual({ pick: "quickly-qu", door: "fd" });
  expect(cleanResults({ rows: [{ convId: "w", ok: true, route: { door: 3 }, usd: "x" }] }).rows[0]).not.toHaveProperty("route");
  expect(cleanResults({ rows: [{ convId: "w", ok: true, usd: "x" }] }).rows[0]).not.toHaveProperty("usd");
  // Rows that could not run, and ambiguous rows (labels whose own gold reply fails), are out of the score and listed
  // beside it (Dev2, 2026-11-18); the gold count is kept apart from the score.
  const cleaned = cleanResults({
    pass: 1,
    total: 2,
    couldNotRun: [{ convId: "a", msgIndex: 3, node: "fd", why: "w".repeat(300), title: "secret" }, { convId: 7 }],
    ambiguous: [{ convId: "b", msgIndex: 0, node: "fd", why: "its label's own gold reply fails: must y (z)" }],
    goldFails: 2,
    rows: [{ convId: "b", msgIndex: 0, node: "fd", ok: false, got: "x", want: "y", ambiguous: true }, { convId: "c", ok: true, ambiguous: "yes" }],
  });
  expect(cleaned.couldNotRun).toEqual([
    { convId: "a", msgIndex: 3, node: "fd", why: "w".repeat(200) },
    { convId: "", msgIndex: 0, node: "", why: "" },
  ]);
  expect(cleaned.ambiguous).toEqual([{ convId: "b", msgIndex: 0, node: "fd", why: "its label's own gold reply fails: must y (z)" }]);
  expect(cleaned.goldFails).toBe(2);
  expect(cleaned.rows[0]).toMatchObject({ ambiguous: true });
  expect(cleaned.rows[1]).not.toHaveProperty("ambiguous");
  expect(cleanResults({})).toMatchObject({ couldNotRun: [], ambiguous: [], goldFails: null });
  expect(cleanResults({ goldFails: "many" }).goldFails).toBeNull();
});

test("POST /gateway/tex/dev passes run and runs on", async () => {
  const { t } = await world();
  expect(await bodyOf(await gatewayPost(t, "/gateway/tex/dev", { accessToken: ACCESS_A, action: "runs", args: {} }))).toMatchObject({ status: "ok", runs: [] });
  expect(await bodyOf(await gatewayPost(t, "/gateway/tex/dev", { accessToken: ACCESS_A, action: "run", args: { draft: "main", kind: "dev" } }))).toMatchObject({ status: "ok" });
});

test("cleanResults keeps a failing row's known failure tags, at most six, and drops the rest", () => {
  const tagsOfRow = (tags: unknown) => cleanResults({ rows: [{ convId: "w", ok: false, tags }] }).rows[0];
  expect(tagsOfRow(["facts", "nonsense", "didnt_act", 3])).toMatchObject({ tags: ["facts", "didnt_act"] });
  expect(tagsOfRow(Array(10).fill("too_long")).tags).toHaveLength(6);
  expect(tagsOfRow([]).tags).toEqual([]);
  expect(tagsOfRow("facts")).not.toHaveProperty("tags");
  expect(tagsOfRow(undefined)).not.toHaveProperty("tags");
});
