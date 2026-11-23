/**
 * LAB RUNS ON GITHUB (Dev2, 2026-11-16: "Ok go ahead and build everything", the Lab runs mockup
 * https://claude.ai/artifact/P2vQtigdvALrSWyb5CqQ3E; Dev2 picked "Convex dispatches directly", 2026-11-16).
 *
 * Run Dev set, Run this chat and Run node in the Lab, and `tex_dev` `run`, record a run here and dispatch
 * `.github/workflows/tex-lab-run.yml` straight away with GH_ADMIN_TOKEN (the token the promote workflow already
 * opens pull requests with). The workflow checks out main, writes the draft's graph into the config, runs the Dev
 * set's unit tests (`node apps/mcp/bench/run.mjs sets run`; never Training, never the Test set, which lives in the
 * eval service) on the AI gateway or on Claude Code (`CLAUDE_CODE_OAUTH_TOKEN`, which never leaves GitHub Actions),
 * and reports its stage and results back through `report` with the deploy key. The Lab subscribes to `list`/`get`.
 *
 * The code (Dev2, 2026-11-16: "when we run things it should run on the PRs code instead of main"): a draft may name a
 * same-repository pull request or branch (`setCode`, `tex_dev` `code`), and a run may name its own; the workflow checks
 * that code out instead of main, runs it without the deploy key, and reports the commit it ran. A pull request from a
 * fork is refused in the workflow: only code someone with write access pushed here runs with the run's model keys.
 *
 * A "gate" run is not started here: Promote makes one (`texLabPromote.ask`, `tex_dev` `promote`), the promote
 * workflow is dispatched at once, and once its pull request is open the run follows that pull request's
 * "Tex test set" commit status, counts only.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, internalQuery, query, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireAdmin } from "./lib/admin";
import { DEFAULT_REPEATS, fidelityOf, repeatsOf } from "@context/lab/src/texRunBand.cjs";
import { compareRuns, runStats } from "@context/lab/src/texRunStats.cjs";
import { FAILURE_TAGS } from "@context/lab/src/texFailures.cjs";
import { handleForUser } from "./lib/identities";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";
import { quickBase, quickRefusal } from "./lib/texLabQuick";

/**
 * At most this many of one person's runs waiting or running at once, and this many started in a day: guards against a
 * runaway loop, set well above what people and their Claude threads use (Dev2, 2026-11-17: "increase the caps if they
 * keep getting hit"; "why only 6 Dev sets at a time?"). No outside limit sets them: each run is one GitHub job at a
 * time, and runs past the account's concurrent-job limit wait in GitHub's queue rather than fail. A Dev run costs
 * about a dollar at most.
 */
export const MAX_QUEUED = 20;
export const MAX_PER_DAY = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A run still waiting or running after this long counts as lost: it no longer holds a place in the queue. */
export const STALE_MS = 3 * 60 * 60 * 1000;
/** A gate run checks its pull request's status this often, for at most this many checks (six hours). */
const GATE_EVERY_MS = 2 * 60 * 1000;
const GATE_TRIES = 180;
const MAX_ROWS = 2_000;
const LIST_LIMIT = 50;

/** Where the workflows live (a self-hosted deployment edits this to its own fork). Not a secret. */
export const LAB_REPO = "Supa-Media/context";
const repo = () => LAB_REPO;
export const RUN_WORKFLOW = "tex-lab-run.yml";
export const PROMOTE_WORKFLOW = "tex-lab-promote.yml";

const VERSION = /^(main|v[0-9a-z]{1,16})$/;
const CONVO_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const NODE_ID = /^[a-z][A-Za-z0-9_-]{0,30}$/;
const RUN_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d{1,14}(\/attempts\/\d{1,3})?$/;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})$/;
const KINDS = ["dev", "chat", "node"] as const;
/** A same-repository pull request (`#3401`) or a branch name git would take; never an option or a path climb. */
export const CODE = /^(#[1-9]\d{0,6}|(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._/-]{1,120})$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * What someone typed for the code: main (or nothing) is none, a pull request's address or `#n` or a bare number is
 * `#n`, anything else is a branch name. Undefined means it is not a name the workflow would take.
 */
export function codeOf(x: unknown): string | null | undefined {
  if (x === null || x === undefined) return null;
  if (typeof x === "number") return Number.isSafeInteger(x) && x > 0 && x < 1e7 ? `#${x}` : undefined;
  if (typeof x !== "string") return undefined;
  const t = x.trim();
  if (t === "" || t === "main") return null;
  // A pull request's address is this repository's only: another's (a fork's) is not ours to run.
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d{0,6})\/?$/i.exec(t);
  if (url) return url[1].toLowerCase() === LAB_REPO.toLowerCase() ? `#${url[2]}` : undefined;
  const pr = /^#?([1-9]\d{0,6})$/.exec(t);
  const out = pr ? `#${pr[1]}` : t;
  return CODE.test(out) ? out : undefined;
}
const CODE_WORDS = "code is a pull request (#3401 or its address) or a branch of this repository, or main";

/**
 * Where a run aims: `pr<N>`, a pull request's preview deployment (its name, `pr` and the pull request's number, the
 * same as `previewName` in `lib/previewDeployment.ts`), or `staging`. Unset is the Lab's own path, as before.
 */
export const TARGET = /^(staging|pr[1-9][0-9]{0,6})$/;
/** Undefined: not a target this function takes; null: none asked for. */
export function targetOf(x: unknown): string | null | undefined {
  if (x === undefined || x === null || x === "") return null;
  return typeof x === "string" && TARGET.test(x) ? x : undefined;
}
/** A preview run is replay only (the workflow refuses record and refresh) and repeats each Front door test once. */
export const PREVIEW_REPEATS = 1;

type Run = Doc<"texLabRuns">;
type Who = { userId: Id<"users">; via: string };
type Kind = (typeof KINDS)[number];

const stageV = v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed"));

// ── Results ───────────────────────────────────────────────────────────────

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const str = (x: unknown, n = 80) => (typeof x === "string" ? x.slice(0, n) : "");

/** A run's score as the band reads it (`texRunBand.cjs` bandOf), cleaned to numbers; absent when it has none. */
function scoreOf(x: unknown) {
  if (!x || typeof x !== "object" || typeof (x as { mean?: unknown }).mean !== "number") return undefined;
  const s = x as Record<string, unknown>;
  return { mean: num(s.mean), min: num(s.min), max: num(s.max), lo: num(s.lo), hi: num(s.hi), repeats: num(s.repeats), total: num(s.total) };
}

/** A perNode or perConv entry's min and max repeat, when it has them. */
function bandOfEntry(c: Record<string, unknown>) {
  return {
    ...(typeof c.min === "number" && Number.isFinite(c.min) ? { min: num(c.min) } : {}),
    ...(typeof c.max === "number" && Number.isFinite(c.max) ? { max: num(c.max) } : {}),
  };
}

/** A workflow's results as the Lab reads them: numbers, ids, each verdict's short got/want and a miss's detail, nothing else. */
/** A run's hand-off spend, cleaned (`cleanResults`). */
function handoffOf(x: unknown) {
  const h = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const usd = (v: unknown) => Math.round(num(v) * 10_000) / 10_000;
  return { jobs: num(h.jobs), parts: num(h.parts), advisorCalls: num(h.advisorCalls), usd: usd(h.usd), perJobUsd: usd(h.perJobUsd), advisorCallsPerJob: num(h.advisorCallsPerJob) };
}

/** A row's route, cleaned (`cleanResults`): the router's pick and sure, its door, a fallback's reason; only what is there. */
function routeOf(x: unknown) {
  const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const pick = str(o.pick, 10);
  const door = str(o.door, 10);
  const fellBack = str(o.fellBack, 120);
  const sure = typeof o.sure === "number" && Number.isFinite(o.sure) ? o.sure : undefined;
  if (!pick && !door && !fellBack && sure === undefined) return undefined;
  return { ...(pick ? { pick } : {}), ...(sure !== undefined ? { sure } : {}), ...(door ? { door } : {}), ...(fellBack ? { fellBack } : {}) };
}

/** A run's world, cleaned (`cleanResults`): the simulated calls no fixture answered (`scripts/tex-lab-run.mjs` worldOf). */
function worldOf(x: unknown) {
  if (!x || typeof x !== "object") return undefined;
  const w = x as Record<string, unknown>;
  const byKind = (w.byKind && typeof w.byKind === "object" ? w.byKind : {}) as Record<string, unknown>;
  const calls = (Array.isArray(w.calls) ? w.calls.slice(0, 40) : []) as Record<string, unknown>[];
  return {
    misses: num(w.misses),
    byKind: Object.fromEntries(Object.entries(byKind).slice(0, 12).map(([k, n]) => [str(k, 40), num(n)])),
    calls: calls.map((c) => ({ chat: str(c.chat), kind: str(c.kind, 40), call: str(c.call, 300) })),
  };
}

export function cleanResults(r: unknown) {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.slice(0, MAX_ROWS) : []) as Record<string, unknown>[];
  return {
    // `pass` is the mean over the repeats when a run repeated its tests, so it may be fractional (num keeps it).
    pass: num(o.pass),
    total: num(o.total),
    // Repeats of each Front door test, and the score as a mean with its min..max band (`texRunBand.cjs`).
    ...(typeof o.repeats === "number" && Number.isFinite(o.repeats) ? { repeats: num(o.repeats) } : {}),
    ...(scoreOf(o.score) !== undefined ? { score: scoreOf(o.score) } : {}),
    // The run's fidelity label (`texRunBand.cjs` fidelityOf): a cc run is only the model family's.
    ...(typeof o.fidelity === "string" ? { fidelity: str(o.fidelity, 40) } : {}),
    ...(typeof o.fidelityWhy === "string" ? { fidelityWhy: str(o.fidelityWhy, 300) } : {}),
    costUsd: Math.round(num(o.costUsd) * 10_000) / 10_000,
    // The handed-off jobs' share of the run (`scripts/tex-lab-run.mjs` handoffOf): jobs, parts, advisor calls, spend.
    handoff: handoffOf(o.handoff),
    // The simulated world's misses: which calls no recorded fixture answered, so a run says what was invented.
    world: worldOf(o.world),
    // Claude calls the fallback model answered (`apps/mcp/bench/fallbacks.mjs`): any makes the run's score not Tex's.
    fallbacks: num(o.fallbacks),
    valid: o.valid !== false && num(o.fallbacks) === 0,
    ...(o.valid === false || num(o.fallbacks) > 0 ? { invalid: str(o.invalid, 200) || "a Claude call fell back to another model" } : {}),
    ms: num(o.ms),
    perConv: list(o.perConv).map((c) => ({ id: str(c.id), pass: num(c.pass), total: num(c.total), ...bandOfEntry(c) })),
    perNode: list(o.perNode).map((c) => ({ node: str(c.node, 40), pass: num(c.pass), total: num(c.total), ...bandOfEntry(c) })),
    // Rows that could not run, and ambiguous rows (an fd label whose own gold reply fails), each beside the score and out of
    // it (`scripts/tex-lab-run.mjs` resultsOf). goldFails is the count of such labels, null when the run had no gold report.
    couldNotRun: list(o.couldNotRun).map((c) => ({ convId: str(c.convId), msgIndex: num(c.msgIndex), node: str(c.node, 40), why: str(c.why, 200) })),
    ambiguous: list(o.ambiguous).map((c) => ({ convId: str(c.convId), msgIndex: num(c.msgIndex), node: str(c.node, 40), why: str(c.why, 200) })),
    goldFails: typeof o.goldFails === "number" && Number.isFinite(o.goldFails) ? o.goldFails : null,
    rows: list(o.rows).map((x) => ({
      convId: str(x.convId),
      msgIndex: num(x.msgIndex),
      node: str(x.node, 40),
      ok: x.ok === true,
      got: str(x.got, 200),
      want: str(x.want, 200),
      ...(x.ran === false ? { ran: false } : {}),
      ...(x.ambiguous === true ? { ambiguous: true } : {}),
      ...(num(x.fallbacks) > 0 ? { fallbacks: num(x.fallbacks) } : {}),
      // A miss's failed lines with the judge's reasons and Tex's texts (`scripts/tex-lab-run.mjs` detailOf).
      ...(typeof x.detail === "string" && x.detail !== "" ? { detail: str(x.detail, 1_500) } : {}),
      // The row's route (`scripts/tex-lab-run.mjs` routeOf) and its cost, so cost per turn and the route summary read it.
      ...(routeOf(x.route) !== undefined ? { route: routeOf(x.route) } : {}),
      ...(typeof x.usd === "number" && Number.isFinite(x.usd) ? { usd: num(x.usd) } : {}),
      // A row's repeats: how many runs it had and how many passed (passes may be 0: a row that failed every repeat).
      ...(num(x.runs) > 0 && typeof x.passes === "number" && Number.isFinite(x.passes) ? { runs: num(x.runs), passes: num(x.passes) } : {}),
      // A failing row's failure tags, in priority order (`texFailures.cjs` tagsOf): known names only, at most six.
      ...(Array.isArray(x.tags) ? { tags: x.tags.filter((t): t is string => typeof t === "string" && (FAILURE_TAGS as readonly string[]).includes(t)).slice(0, 6) } : {}),
    })),
  };
}

// ── Reading ───────────────────────────────────────────────────────────────

const shown = async (ctx: QueryCtx, r: Run, names = new Map<string, string>()) => {
  let by = names.get(r.by);
  if (by === undefined) {
    by = (await handleForUser(ctx, r.by).then((h) => (h ? "@" + h : null))) ?? "Someone";
    names.set(r.by, by);
  }
  return {
    id: r._id,
    versionId: r.versionId,
    kind: r.kind,
    set: r.set ?? "dev",
    convId: r.convId ?? null,
    nodeId: r.nodeId ?? null,
    models: r.models,
    // Old runs ran once (no repeats stored); a run's fidelity follows its models (`texRunBand.cjs` fidelityOf).
    repeats: r.repeats ?? 1,
    fidelity: fidelityOf(r.models),
    stage: r.stage,
    ghRunUrl: r.ghRunUrl ?? null,
    pr: r.pr ?? null,
    code: r.code ?? null,
    commit: r.commit ?? null,
    by,
    via: r.via,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt ?? null,
    results: r.results ?? null,
    error: r.error ?? null,
  };
};

/** The fields `vsBase` reads: a run as `shown` gives it (`id`, `set` defaulting to "dev"). */
type RunLike = { id: string; versionId: string; kind: string; set?: string | null; models: string; stage: string; startedAt: number; results?: unknown };

/**
 * A draft's finished Dev run against main's newest finished Dev run on the same models and set. The verdict is the
 * paired rule (`compareRuns`, texRunStats.cjs): the two runs are scored on the rows both counted, clustered by
 * conversation, and a draft "wins" only when the 95% interval of its per-row difference lies above 0. The min..max
 * noise band (`band`) sits beside it and is the verdict only when a run has no rows. `paired` drops its per-row
 * differences unless `full` (the one-run read asks for them). Null for main's runs and for runs that are not finished
 * Dev runs (a chat or node run is a part of the set, never compared with the whole).
 */
export function vsBase(run: RunLike, baseRuns: RunLike[], full = false) {
  if (run.versionId === "main" || run.kind !== "dev" || run.stage !== "done") return null;
  const set = run.set ?? "dev";
  const base = baseRuns
    .filter((b) => b.versionId === "main" && b.kind === "dev" && b.stage === "done" && b.models === run.models && (b.set ?? "dev") === set)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  if (!base) return { verdict: "no base", why: `main has no finished Dev run on ${run.models} for the ${set} set`, baseRunId: null };
  const cmp = compareRuns(run.results ?? null, base.results ?? null);
  const paired = cmp.paired && !full && "perRow" in cmp.paired ? withoutPerRow(cmp.paired) : cmp.paired;
  return { verdict: cmp.verdict, why: cmp.why, baseRunId: base.id, band: cmp.band.verdict, paired };
}

/** A paired comparison without its per-row differences (the list keeps the summary; `runs { id }` gives the rows). */
function withoutPerRow<T extends { perRow: unknown }>(p: T): Omit<T, "perRow"> {
  const { perRow: _perRow, ...rest } = p;
  return rest;
}

export async function listRuns(ctx: QueryCtx, versionId: string | null) {
  const rows =
    versionId === null
      ? await ctx.db.query("texLabRuns").withIndex("by_started").order("desc").take(LIST_LIMIT)
      : await ctx.db
          .query("texLabRuns")
          .withIndex("by_version", (q) => q.eq("versionId", versionId))
          .order("desc")
          .take(LIST_LIMIT);
  const names = new Map<string, string>();
  const fixedAfter = await dispatchWorkedSince(ctx);
  return await Promise.all(rows.map(async (r) => ({ ...(await shown(ctx, r, names)), fixedSince: fixedSince(r, fixedAfter) })));
}

/** When a run last got as far as GitHub (it has a run address): GitHub accepted that dispatch. */
async function dispatchWorkedSince(ctx: QueryCtx): Promise<number> {
  const recent = await ctx.db.query("texLabRuns").withIndex("by_started").order("desc").take(LIST_LIMIT);
  return recent.find((r) => r.ghRunUrl)?.startedAt ?? 0;
}

/**
 * A run GitHub refused to start (a token without the permission, 2026-11-16) is history once a later run started:
 * the Lab says so rather than showing it as a current failure.
 */
export const fixedSince = (r: Run, workedAt: number) => r.stage === "failed" && !r.ghRunUrl && (r.error ?? "").startsWith("GitHub refused to start the run") && workedAt > r.startedAt;

/** Remove a finished run from the list (the Lab's Remove; `tex_dev` `run_remove`). A run still going stays. */
export async function removeRun(ctx: MutationCtx, id: string): Promise<{ status: "ok" } | { status: "bad_request"; error: string }> {
  const r = await runOf(ctx, id);
  if (!r) return { status: "bad_request", error: `there is no run ${id}` };
  if (r.stage === "queued" || r.stage === "running") return { status: "bad_request", error: "this run is still going: remove it once it has finished" };
  await ctx.db.delete(r._id);
  return { status: "ok" };
}

async function runOf(ctx: QueryCtx, id: string): Promise<Run | null> {
  const runId = ctx.db.normalizeId("texLabRuns", id);
  return runId ? await ctx.db.get(runId) : null;
}

// ── Starting ──────────────────────────────────────────────────────────────

/** Start a run, or say why not. Shared by the Lab (`start`) and `tex_dev` (`runAction`). */
export async function startRun(ctx: MutationCtx, who: Who, a: Record<string, unknown>, now: number): Promise<{ status: "ok"; runId: Id<"texLabRuns">; baseRunId?: Id<"texLabRuns"> } | { status: "bad_request" | "not_found" | "refused"; error: string }> {
  const versionId = typeof a.versionId === "string" ? a.versionId : "";
  const kind = a.kind as Kind;
  const models = a.models === undefined ? "gw" : a.models;
  const repeats = repeatsOf(a.repeats);
  if (!VERSION.test(versionId)) return { status: "bad_request", error: "versionId is main or a draft's id (v…)" };
  if (a.kind === "gate") return { status: "bad_request", error: "a gate run starts with Promote, never on its own" };
  if (!KINDS.includes(kind)) return { status: "bad_request", error: "kind is dev, chat or node" };
  if (models !== "gw" && models !== "cc") return { status: "bad_request", error: "models is gw (the AI gateway) or cc (Claude Code)" };
  if (repeats === null) return { status: "bad_request", error: "repeats is 1 to 5 (each Front door test runs that many times; 3 by default)" };
  const convId = kind === "chat" ? a.convId : undefined;
  const nodeId = kind === "node" ? a.nodeId : undefined;
  // Training is the repo's Training set (Dev2, 2026-11-18: "prove it on Training ... a scored Lab Training run").
  const set = a.set === undefined || a.set === null || a.set === "dev" ? undefined : a.set === "training" ? "training" : null;
  if (set === null) return { status: "bad_request", error: "set is dev (default) or training" };
  if (kind === "chat" && (typeof convId !== "string" || !CONVO_ID.test(convId))) return { status: "bad_request", error: "a chat run names the Dev conversation (convId)" };
  if (kind === "node" && (typeof nodeId !== "string" || !NODE_ID.test(nodeId))) return { status: "bad_request", error: "a node run names the step (nodeId)" };
  if (quickRefusal(a, kind, versionId, models) !== null) return { status: "bad_request", error: String(quickRefusal(a, kind, versionId, models)) };
  const target = targetOf(a.target);
  if (target === undefined) return { status: "bad_request", error: "target is pr<N> (a pull request's preview, its number) or unset" };
  if (target === "staging") return { status: "bad_request", error: "a run aims at a pull request's preview (pr<N>) or nothing: staging runs are not wired" };
  let code = a.code === undefined ? null : codeOf(a.code);
  if (code === undefined) return { status: "bad_request", error: CODE_WORDS };
  if (versionId !== "main") {
    const draft = await ctx.db
      .query("texLabVersions")
      .withIndex("by_version", (q) => q.eq("versionId", versionId))
      .unique();
    if (!draft) return { status: "not_found", error: `there is no draft ${versionId}` };
    // The draft's own code unless the run names some (main included).
    if (a.code === undefined) code = draft.code ?? null;
  }
  if (target) {
    // A preview runs its own pull request's code and nothing else: the preview is that pull request's copy.
    const want = `#${target.slice(2)}`;
    if (code !== null && code !== want) return { status: "bad_request", error: `${target} runs pull request ${want}'s code, not ${code}` };
    code = want;
  }
  const mine = await ctx.db
    .query("texLabRuns")
    .withIndex("by_by", (q) => q.eq("by", who.userId).gte("startedAt", now - DAY_MS))
    .collect();
  const open = mine.filter((r) => (r.stage === "queued" || r.stage === "running") && r.kind !== "gate" && now - r.startedAt < STALE_MS);
  if (open.length >= MAX_QUEUED) return { status: "refused", error: `you already have ${open.length} runs waiting or running (at most ${MAX_QUEUED}): wait for one to finish` };
  if (mine.filter((r) => r.kind !== "gate").length >= MAX_PER_DAY) return { status: "refused", error: `you have started ${MAX_PER_DAY} runs in the last day, the most a day allows` };
  const runId = await ctx.db.insert("texLabRuns", {
    versionId,
    kind,
    ...(typeof convId === "string" ? { convId } : {}),
    ...(typeof nodeId === "string" ? { nodeId } : {}),
    ...(set ? { set } : {}),
    models,
    // The target is not stored yet: the run table (functions/lib/schema/texLab.ts) has no field for it. It travels with
    // the scheduled dispatch instead, so a preview run is aimed at its preview and recorded with its code.
    repeats: target ? PREVIEW_REPEATS : repeats,
    ...(code ? { code } : {}),
    ...(a.quick === true ? { quick: true } : {}),
    stage: "queued",
    by: who.userId,
    via: who.via.slice(0, 60),
    startedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.functions.texLabRuns.dispatch, { runId, ...(target ? { target } : {}) });
  return { status: "ok", runId, ...(a.quick === true ? await quickBase(ctx, who, set, repeats, now) : {}) };
}

/** Point a draft at a pull request's or branch's code, or back at main (`setCode`; `tex_dev` `code`). */
export async function setDraftCode(ctx: MutationCtx, versionId: unknown, raw: unknown, now: number): Promise<{ status: "ok"; code: string | null } | { status: "bad_request" | "not_found"; error: string }> {
  if (typeof versionId !== "string" || !/^v[0-9a-z]{1,16}$/.test(versionId)) return { status: "bad_request", error: "code takes a draft (main always runs main's code)" };
  const code = codeOf(raw);
  if (code === undefined) return { status: "bad_request", error: CODE_WORDS };
  const draft = await ctx.db
    .query("texLabVersions")
    .withIndex("by_version", (q) => q.eq("versionId", versionId))
    .unique();
  if (!draft) return { status: "not_found", error: `there is no draft ${versionId}` };
  await ctx.db.patch(draft._id, { code: code ?? undefined, updatedAt: now });
  return { status: "ok", code };
}

/** Promote's gate run, made with the ask: it follows the pull request once the promote workflow opens one. */
export async function startGateRun(ctx: MutationCtx, who: Who, versionId: string, now: number) {
  const waiting = await ctx.db
    .query("texLabRuns")
    .withIndex("by_version", (q) => q.eq("versionId", versionId))
    .order("desc")
    .take(10);
  if (!waiting.some((r) => r.kind === "gate" && r.stage === "queued" && !r.pr)) {
    await ctx.db.insert("texLabRuns", { versionId, kind: "gate", models: "gw", stage: "queued", by: who.userId, via: who.via.slice(0, 60), startedAt: now });
  }
  await ctx.scheduler.runAfter(0, internal.functions.texLabRuns.dispatchPromote, {});
}

/** The promote workflow answered: its pull request (the gate run follows it), or why the version was refused. */
export async function promoteAnswered(ctx: MutationCtx, versionId: string, pr: string | undefined, why: string | undefined, now: number) {
  const gates = (await ctx.db
    .query("texLabRuns")
    .withIndex("by_version", (q) => q.eq("versionId", versionId))
    .order("desc")
    .take(10)).filter((r) => r.kind === "gate" && r.stage === "queued" && !r.pr);
  for (const g of gates) {
    if (pr !== undefined) {
      await ctx.db.patch(g._id, { stage: "running", pr });
      await ctx.scheduler.runAfter(GATE_EVERY_MS, internal.functions.texLabRuns.followGate, { runId: g._id, tries: 0 });
    } else await ctx.db.patch(g._id, { stage: "failed", finishedAt: now, error: (why ?? "the version could not become Tex's config").slice(0, 300) });
  }
}

// ── The Lab's door ────────────────────────────────────────────────────────

export const start = mutation({
  args: { versionId: v.string(), kind: v.string(), convId: v.optional(v.string()), nodeId: v.optional(v.string()), models: v.optional(v.string()), repeats: v.optional(v.number()), code: v.optional(v.string()), set: v.optional(v.string()), target: v.optional(v.string()) },
  returns: v.object({ runId: v.id("texLabRuns") }),
  handler: async (ctx, a) => {
    const actor = await requireAdmin(ctx);
    const answer = await startRun(ctx, { userId: actor.userId, via: "lab" }, a, Date.now());
    if (answer.status !== "ok") throw new ConvexError(answer.error);
    return { runId: answer.runId };
  },
});

/** The Lab's Code field on a draft: a pull request or branch, or main (empty). */
export const setCode = mutation({
  args: { versionId: v.string(), code: v.string() },
  returns: v.object({ code: v.union(v.null(), v.string()) }),
  handler: async (ctx, a) => {
    await requireAdmin(ctx);
    const answer = await setDraftCode(ctx, a.versionId, a.code, Date.now());
    if (answer.status !== "ok") throw new ConvexError(answer.error);
    return { code: answer.code };
  },
});

/** The code a draft runs on (null: main). */
export const codeFor = query({
  args: { versionId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { versionId }) => {
    await requireAdmin(ctx);
    if (versionId === "main") return null;
    const draft = await ctx.db
      .query("texLabVersions")
      .withIndex("by_version", (q) => q.eq("versionId", versionId))
      .unique();
    return draft?.code ?? null;
  },
});

export const remove = mutation({
  args: { id: v.string() },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const answer = await removeRun(ctx, id);
    if (answer.status !== "ok") throw new ConvexError(answer.error);
    return null;
  },
});

export const list = query({
  args: { versionId: v.optional(v.string()) },
  returns: v.array(v.any()),
  handler: async (ctx, { versionId }) => {
    await requireAdmin(ctx);
    return await listRuns(ctx, versionId ?? null);
  },
});

export const get = query({
  args: { id: v.string() },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, { id }) => {
    await requireAdmin(ctx);
    const r = await runOf(ctx, id);
    return r ? { ...(await shown(ctx, r)), fixedSince: fixedSince(r, await dispatchWorkedSince(ctx)) } : null;
  },
});

// ── The MCP's door (`texLabDrafts.forGateway`, which has checked the caller) ──

/** `tex_dev` `run` and `runs`; null for any other action. */
export async function runAction(ctx: MutationCtx, who: Who, action: string, a: Record<string, unknown>, now: number): Promise<Record<string, unknown> | null> {
  if (action === "run") {
    const answer = await startRun(ctx, who, { versionId: a.draft, kind: a.kind, convId: a.conv, nodeId: a.node, models: a.models, repeats: a.repeats, code: a.code, set: a.set, target: a.target, quick: a.quick }, now);
    return answer.status === "ok" ? { status: "ok", id: answer.runId, ...(answer.baseRunId ? { baseRunId: answer.baseRunId } : {}) } : answer.status === "not_found" ? { status: "not_found" } : { status: "bad_request", error: answer.error };
  }
  if (action === "code") return await setDraftCode(ctx, a.draft, a.code, now);
  if (action === "run_remove") return typeof a.id === "string" ? await removeRun(ctx, a.id) : { status: "bad_request", error: "run_remove takes the run's id" };
  if (action === "runs") {
    if (typeof a.id === "string") {
      const r = await runOf(ctx, a.id);
      if (!r) return { status: "bad_request", error: `there is no run ${a.id}` };
      const one = await shown(ctx, r);
      // A draft's finished Dev run reads against main's newest Dev run, with the per-row differences kept.
      const vsMain = vsBase(one, await listRuns(ctx, "main"), true);
      return { status: "ok", run: { ...one, stats: one.results ? runStats(one.results) : null, vsMain, fixedSince: fixedSince(r, await dispatchWorkedSince(ctx)) } };
    }
    const draft = typeof a.draft === "string" ? a.draft : null;
    // The list leaves out each run's rows; `runs { id }` gives one whole.
    const listed = await listRuns(ctx, draft);
    // A draft's runs read against main's newest Dev runs (`vsBase`), taken before each row's results are cut short.
    const baseRuns = draft !== null && draft !== "main" ? await listRuns(ctx, "main") : [];
    const runs = listed.map(({ results, ...r }) => ({
      ...r,
      stats: results ? runStats(results) : null,
      vsMain: draft !== null && draft !== "main" ? vsBase({ ...r, results }, baseRuns) : null,
      results: results ? { ...results, rows: undefined, perConv: undefined } : null,
    }));
    return { status: "ok", runs };
  }
  return null;
}

// ── The workflow's door (deploy key) ──────────────────────────────────────

/** What the workflow runs: the run, the draft's graph (null for main) and the Lab's drafts of Dev conversations. */
export const job = internalQuery({
  args: { runId: v.string() },
  returns: v.any(),
  handler: async (ctx, { runId }) => {
    const r = await runOf(ctx, runId);
    if (!r || r.kind === "gate") return null;
    const draft =
      r.versionId === "main"
        ? null
        : await ctx.db
            .query("texLabVersions")
            .withIndex("by_version", (q) => q.eq("versionId", r.versionId))
            .unique();
    // Every draft conversation: a Dev draft is run in place of its repo copy; a repo Dev conversation moved to
    // Training or removed in the Lab is left out. Training drafts carry only their id and set.
    const drafts = (await ctx.db.query("texSetConvos").collect()).map((d) => ({ id: d.convoId, set: d.set, removed: d.removed, ...(d.set === "dev" && !d.removed ? { conv: d.data } : {}) }));
    return { id: r._id, versionId: r.versionId, kind: r.kind, set: r.set ?? "dev", convId: r.convId ?? null, nodeId: r.nodeId ?? null, models: r.models, repeats: r.repeats ?? DEFAULT_REPEATS, code: r.code ?? null, quick: r.quick === true, graph: draft?.graph ?? null, drafts };
  },
});

/** The workflow's stage and, at the end, its results or why it failed. A finished run stays finished. */
export const report = internalMutation({
  args: { runId: v.string(), stage: stageV, results: v.optional(v.any()), error: v.optional(v.string()), ghRunUrl: v.optional(v.string()), commit: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const r = await runOf(ctx, a.runId);
    if (!r) throw new ConvexError("No such run");
    if (r.stage === "done" || r.stage === "failed") return null;
    if (a.ghRunUrl !== undefined && !RUN_URL.test(a.ghRunUrl)) throw new ConvexError("Not a GitHub run address");
    if (a.commit !== undefined && !COMMIT.test(a.commit)) throw new ConvexError("Not a commit");
    const finished = a.stage === "done" || a.stage === "failed";
    // The dispatch's run address can land after the workflow said it is running: a stage never goes back.
    const stage = a.stage === "queued" && r.stage === "running" ? "running" : a.stage;
    await ctx.db.patch(r._id, {
      stage,
      ...(a.ghRunUrl !== undefined ? { ghRunUrl: a.ghRunUrl } : {}),
      ...(a.commit !== undefined ? { commit: a.commit } : {}),
      ...(a.results !== undefined ? { results: cleanResults(a.results) } : {}),
      ...(a.error !== undefined ? { error: a.error.slice(0, 300) } : {}),
      ...(finished ? { finishedAt: Date.now() } : {}),
    });
    return null;
  },
});

// ── GitHub ────────────────────────────────────────────────────────────────

export async function dispatchWorkflow(file: string, inputs: Record<string, string>): Promise<{ ok: true; url: string | null } | { ok: false; error: string }> {
  const token = process.env.GH_ADMIN_TOKEN;
  if (!token) return { ok: false, error: "this deployment cannot start GitHub runs (GH_ADMIN_TOKEN is not set)" };
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${repo()}/actions/workflows/${file}/dispatches`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "context-tex-lab" },
      body: JSON.stringify({ ref: "main", inputs }),
    });
  } catch {
    return { ok: false, error: "GitHub could not be reached to start the run" };
  }
  if (res.status !== 200 && res.status !== 204) {
    // GitHub's own reason ("Resource not accessible by personal access token" is a token without Actions write).
    const said = ((await res.json().catch(() => null)) as { message?: unknown } | null)?.message;
    return { ok: false, error: `GitHub refused to start the run (${res.status}${typeof said === "string" ? `: ${said.slice(0, 160)}` : ""})` };
  }
  const body = res.status === 200 ? ((await res.json().catch(() => null)) as { html_url?: unknown } | null) : null;
  const url = typeof body?.html_url === "string" && RUN_URL.test(body.html_url) ? body.html_url : null;
  return { ok: true, url };
}

export const dispatch = internalAction({
  args: { runId: v.id("texLabRuns"), target: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { runId, target }) => {
    // A preview run names its preview; the workflow runs it replay only. Unset dispatches exactly as before.
    const out = await dispatchWorkflow(RUN_WORKFLOW, { run_id: runId, ...(target && target !== "staging" ? { preview: target } : {}) });
    if (!out.ok) await ctx.runMutation(internal.functions.texLabRuns.report, { runId, stage: "failed", error: out.error });
    else if (out.url) await ctx.runMutation(internal.functions.texLabRuns.report, { runId, stage: "queued", ghRunUrl: out.url });
    return null;
  },
});

/** Promote starts at once (the quarter-hour schedule stays as the fallback). */
export const dispatchPromote = internalAction({
  args: {},
  returns: v.null(),
  handler: async () => {
    await dispatchWorkflow(PROMOTE_WORKFLOW, {});
    return null;
  },
});

/** "Test Set 12/14 right, main 11/14: …" → { pass, total }; null for a line without counts. */
export function gateCounts(description: string): { pass: number; total: number } | null {
  const m = /Test Set (\d{1,6})\/(\d{1,6})/.exec(description);
  return m ? { pass: Number(m[1]), total: Number(m[2]) } : null;
}

/** The replay rule's check (`.github/workflows/tex-replay-check.yml`). */
const REPLAY_CHECK = "Tex replay passed on this commit";

async function gateStatus(pr: string): Promise<{ state: string; description: string } | null> {
  const m = PR_URL.exec(pr);
  const token = process.env.GH_ADMIN_TOKEN;
  if (!m || !token) return null;
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "context-tex-lab" };
  try {
    const pull = (await (await fetch(`https://api.github.com/repos/${m[1]}/pulls/${m[2]}`, { headers })).json()) as { head?: { sha?: string }; state?: string; merged_at?: string | null };
    const sha = pull?.head?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return null;
    const statuses = (await (await fetch(`https://api.github.com/repos/${m[1]}/commits/${sha}/statuses?per_page=100`, { headers })).json()) as Array<{ context?: string; state?: string; description?: string }>;
    const s = Array.isArray(statuses) ? statuses.find((x) => x.context === "Tex test set") : undefined;
    if (s) return { state: String(s.state ?? ""), description: String(s.description ?? "") };
    // No Test set status: a promotion that reaches no model area never starts one, and "Tex replay passed on this
    // commit" (tex-replay-check.yml) goes green without it. That is the gate's whole answer for such a change.
    const checks = (await (await fetch(`https://api.github.com/repos/${m[1]}/commits/${sha}/check-runs?check_name=${encodeURIComponent(REPLAY_CHECK)}`, { headers })).json()) as { check_runs?: Array<{ status?: string; conclusion?: string }> };
    const replay = Array.isArray(checks?.check_runs) ? checks.check_runs[0] : undefined;
    if (replay?.status === "completed" && replay.conclusion === "success") return { state: "no-area", description: "" };
    if (pull.state === "closed" && !pull.merged_at) return { state: "closed", description: "" };
    return { state: "none", description: "" };
  } catch {
    return null;
  }
}

export const followGate = internalAction({
  args: { runId: v.id("texLabRuns"), tries: v.number() },
  returns: v.null(),
  handler: async (ctx, { runId, tries }) => {
    const run = await ctx.runQuery(internal.functions.texLabRuns.gateRun, { runId });
    if (!run || !run.pr || run.stage !== "running") return null;
    const s = await gateStatus(run.pr);
    if (s?.state === "no-area" || s?.state === "closed") {
      await ctx.runMutation(internal.functions.texLabRuns.report, {
        runId,
        stage: s.state === "no-area" ? "done" : "failed",
        results: { pass: 0, total: 0, costUsd: 0, ms: Date.now() - run.startedAt, perConv: [], perNode: [], rows: [] },
        // 0 of 0: the replay rule passed with no Test set to run (the change reaches no model area).
        ...(s.state === "closed" ? { error: "the pull request was closed without merging" } : {}),
      });
      return null;
    }
    if (s && (s.state === "success" || s.state === "failure" || s.state === "error")) {
      const counts = gateCounts(s.description);
      await ctx.runMutation(internal.functions.texLabRuns.report, {
        runId,
        stage: s.state === "success" ? "done" : "failed",
        results: { pass: counts?.pass ?? 0, total: counts?.total ?? 0, costUsd: 0, ms: Date.now() - run.startedAt, perConv: [], perNode: [], rows: [] },
        ...(s.state === "success" ? {} : { error: counts ? "the Test set gate did not pass" : "the Test set gate failed before a verdict" }),
      });
      return null;
    }
    if (tries + 1 >= GATE_TRIES) {
      await ctx.runMutation(internal.functions.texLabRuns.report, { runId, stage: "failed", error: "the Test set gate had not reported after six hours" });
      return null;
    }
    await ctx.scheduler.runAfter(GATE_EVERY_MS, internal.functions.texLabRuns.followGate, { runId, tries: tries + 1 });
    return null;
  },
});

export const gateRun = internalQuery({
  args: { runId: v.id("texLabRuns") },
  returns: v.union(v.null(), v.object({ pr: v.union(v.null(), v.string()), stage: v.string(), startedAt: v.number() })),
  handler: async (ctx, { runId }) => {
    const r = await ctx.db.get(runId);
    return r && r.kind === "gate" ? { pr: r.pr ?? null, stage: r.stage, startedAt: r.startedAt } : null;
  },
});
