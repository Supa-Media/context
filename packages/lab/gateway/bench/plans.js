/**
 * A bench's cases kept beside its standing objects, and the object that asks them (Dev2, 2026-11-23: "a change to
 * search should be a lab change and a run of the benchmarks in the sandbox, less than a minute").
 *
 * A run from GitHub (`cli.mjs search --remote`) loads a world and asks its cases; it also leaves those cases here,
 * by bench (`serveBenchPlans`), with the world and the copies they were asked of. A Lab draft is then benched by
 * the gateway alone (`run.js`): no GitHub job, no checkout, no load, only the searches, every copy at once.
 *
 * A runner object (`serveRun`) asks one copy's share of the cases through the gateway's MCP endpoint, in the bench
 * environment, once on main's search config and once on the draft's (`SEARCH_CONFIG_DRAFT`, read only in a bench
 * environment: `search/config/benchDraft.js`). It is a bench object holding nothing; it runs the searches so that
 * no one Worker request carries all of them.
 */

import { benchToken, searchOnce } from "./setup.js";

/** The registry object's path for kept plans. */
export const PLANS_PATH = "/bench-plans";
/** A runner object's one call. */
export const RUN_PATH = "/bench-run";
/** A bench's name for its plan: its id, and its part where it has parts (`search-real:dev`). */
export const PLAN_KEY = /^[a-z0-9][a-z0-9:_-]{0,80}$/;
/** Most cases one plan keeps. */
export const MAX_PLAN_CASES = 2_000;
/** Longest search config one run carries, as JSON. */
export const MAX_DRAFT_CHARS = 200_000;

/**
 * The gateway's own request handler, set by the gateway as it loads (`http/route.js`): a runner object runs in the
 * same Worker, and asking through the handler keeps this module from importing the whole gateway.
 */
let gateway = null;
export function setBenchGateway(handler) {
  gateway = handler;
}

/** `{put: {bench, plan}}` keeps a plan; `{get: bench}` answers it; `{list: true}` answers each bench's size and time. */
export async function serveBenchPlans(sql, request, now = Date.now()) {
  sql.exec("CREATE TABLE IF NOT EXISTS bench_plans (bench TEXT PRIMARY KEY, plan TEXT NOT NULL, at INTEGER NOT NULL)");
  const input = await request.json().catch(() => ({}));
  if (input.put && PLAN_KEY.test(String(input.put.bench ?? ""))) {
    sql.exec("INSERT INTO bench_plans (bench, plan, at) VALUES (?, ?, ?) ON CONFLICT(bench) DO UPDATE SET plan = excluded.plan, at = excluded.at", input.put.bench, JSON.stringify(input.put.plan), now);
    return Response.json({ kept: true, at: now });
  }
  if (typeof input.get === "string") {
    const row = sql.exec("SELECT plan, at FROM bench_plans WHERE bench = ?", input.get).toArray()[0];
    return Response.json(row ? { plan: JSON.parse(row.plan), at: row.at } : { plan: null });
  }
  const rows = sql.exec("SELECT bench, plan, at FROM bench_plans ORDER BY bench").toArray();
  return Response.json({ plans: rows.map((row) => ({ bench: row.bench, at: row.at, cases: JSON.parse(row.plan).worlds.reduce((sum, w) => sum + w.cases.length, 0) })) });
}

/**
 * A runner's share: `{cases: [{id, query, personal, context}], drafts: [null | configJson, ...]}`, every case asked
 * on every config at once (they wait their turn in the copy's objects). Answers `{answers: [{id, variant, ok, text, ms}]}`.
 */
export async function serveRun(env, request) {
  if (gateway === null) return Response.json({ error: "the gateway is not loaded" }, 503);
  const input = await request.json().catch(() => ({}));
  const cases = Array.isArray(input.cases) ? input.cases : [];
  const drafts = Array.isArray(input.drafts) && input.drafts.length > 0 ? input.drafts.slice(0, 2) : [null];
  const ctx = { waitUntil: (promise) => void Promise.resolve(promise).catch(() => {}), passThroughOnException() {} };
  const envs = drafts.map((draft) => (typeof draft === "string" && draft !== "" && draft.length <= MAX_DRAFT_CHARS ? { ...env, SEARCH_CONFIG_DRAFT: draft } : env));
  const answers = await Promise.all(
    cases.flatMap((c) =>
      envs.map(async (variantEnv, variant) => {
        const started = Date.now();
        const answer = await searchOnce((req, e) => gateway(req, e, ctx), variantEnv, await benchToken(env, String(c.personal)), String(c.query), c.context ?? null).catch((error) => ({ ok: false, text: String(error?.message ?? error).slice(0, 200), status: 500 }));
        return { id: c.id, variant, ok: answer.ok, text: answer.text, ms: Date.now() - started };
      }),
    ),
  );
  return Response.json({ answers });
}
