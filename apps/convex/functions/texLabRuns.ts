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
import { handleForUser } from "./lib/identities";
import { internalMutation, mutation } from "./lib/rowWatch/mutations";

/** At most this many of one person's runs waiting or running at once, and this many started in a day. */
export const MAX_QUEUED = 3;
export const MAX_PER_DAY = 20;
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

type Run = Doc<"texLabRuns">;
type Who = { userId: Id<"users">; via: string };
type Kind = (typeof KINDS)[number];

const stageV = v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed"));

// ── Results ───────────────────────────────────────────────────────────────

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const str = (x: unknown, n = 80) => (typeof x === "string" ? x.slice(0, n) : "");

/** A workflow's results as the Lab reads them: numbers, ids, each verdict's short got/want and a miss's detail, nothing else. */
export function cleanResults(r: unknown) {
  const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  const list = (x: unknown) => (Array.isArray(x) ? x.slice(0, MAX_ROWS) : []) as Record<string, unknown>[];
  return {
    pass: num(o.pass),
    total: num(o.total),
    costUsd: Math.round(num(o.costUsd) * 10_000) / 10_000,
    ms: num(o.ms),
    perConv: list(o.perConv).map((c) => ({ id: str(c.id), pass: num(c.pass), total: num(c.total) })),
    perNode: list(o.perNode).map((c) => ({ node: str(c.node, 40), pass: num(c.pass), total: num(c.total) })),
    rows: list(o.rows).map((x) => ({
      convId: str(x.convId),
      msgIndex: num(x.msgIndex),
      node: str(x.node, 40),
      ok: x.ok === true,
      got: str(x.got, 200),
      want: str(x.want, 200),
      ...(x.ran === false ? { ran: false } : {}),
      // A miss's failed lines with the judge's reasons and Tex's texts (`scripts/tex-lab-run.mjs` detailOf).
      ...(typeof x.detail === "string" && x.detail !== "" ? { detail: str(x.detail, 1_500) } : {}),
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
    convId: r.convId ?? null,
    nodeId: r.nodeId ?? null,
    models: r.models,
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
export async function startRun(ctx: MutationCtx, who: Who, a: Record<string, unknown>, now: number): Promise<{ status: "ok"; runId: Id<"texLabRuns"> } | { status: "bad_request" | "not_found" | "refused"; error: string }> {
  const versionId = typeof a.versionId === "string" ? a.versionId : "";
  const kind = a.kind as Kind;
  const models = a.models === undefined ? "gw" : a.models;
  if (!VERSION.test(versionId)) return { status: "bad_request", error: "versionId is main or a draft's id (v…)" };
  if (a.kind === "gate") return { status: "bad_request", error: "a gate run starts with Promote, never on its own" };
  if (!KINDS.includes(kind)) return { status: "bad_request", error: "kind is dev, chat or node" };
  if (models !== "gw" && models !== "cc") return { status: "bad_request", error: "models is gw (the AI gateway) or cc (Claude Code)" };
  const convId = kind === "chat" ? a.convId : undefined;
  const nodeId = kind === "node" ? a.nodeId : undefined;
  if (kind === "chat" && (typeof convId !== "string" || !CONVO_ID.test(convId))) return { status: "bad_request", error: "a chat run names the Dev conversation (convId)" };
  if (kind === "node" && (typeof nodeId !== "string" || !NODE_ID.test(nodeId))) return { status: "bad_request", error: "a node run names the step (nodeId)" };
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
    models,
    ...(code ? { code } : {}),
    stage: "queued",
    by: who.userId,
    via: who.via.slice(0, 60),
    startedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.functions.texLabRuns.dispatch, { runId });
  return { status: "ok", runId };
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
  args: { versionId: v.string(), kind: v.string(), convId: v.optional(v.string()), nodeId: v.optional(v.string()), models: v.optional(v.string()), code: v.optional(v.string()) },
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
    const answer = await startRun(ctx, who, { versionId: a.draft, kind: a.kind, convId: a.conv, nodeId: a.node, models: a.models, code: a.code }, now);
    return answer.status === "ok" ? { status: "ok", id: answer.runId } : answer.status === "not_found" ? { status: "not_found" } : { status: "bad_request", error: answer.error };
  }
  if (action === "code") return await setDraftCode(ctx, a.draft, a.code, now);
  if (action === "run_remove") return typeof a.id === "string" ? await removeRun(ctx, a.id) : { status: "bad_request", error: "run_remove takes the run's id" };
  if (action === "runs") {
    if (typeof a.id === "string") {
      const r = await runOf(ctx, a.id);
      return r ? { status: "ok", run: { ...(await shown(ctx, r)), fixedSince: fixedSince(r, await dispatchWorkedSince(ctx)) } } : { status: "bad_request", error: `there is no run ${a.id}` };
    }
    const draft = typeof a.draft === "string" ? a.draft : null;
    // The list leaves out each run's rows; `runs { id }` gives one whole.
    const runs = (await listRuns(ctx, draft)).map(({ results, ...r }) => ({ ...r, results: results ? { ...results, rows: undefined, perConv: undefined } : null }));
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
    return { id: r._id, versionId: r.versionId, kind: r.kind, convId: r.convId ?? null, nodeId: r.nodeId ?? null, models: r.models, code: r.code ?? null, graph: draft?.graph ?? null, drafts };
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

async function dispatchWorkflow(file: string, inputs: Record<string, string>): Promise<{ ok: true; url: string | null } | { ok: false; error: string }> {
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
  args: { runId: v.id("texLabRuns") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const out = await dispatchWorkflow(RUN_WORKFLOW, { run_id: runId });
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
