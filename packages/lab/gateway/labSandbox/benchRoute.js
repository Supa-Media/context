/**
 * `POST /tex-lab/sandbox` `bench_*`: A WHOLE TRAINING OR DEV SET SCORED IN THE LAB SANDBOX (Seyi, 2026-11-19: "I don't
 * see why we shouldnt be able to run full tests in sandboxes"; plan `products/tex/research/
 * sandbox-bench-scoring-2026-11-19.md`). GitHub Lab runs wait for scarce bench-login runner slots; the sandbox runs
 * real Tex on the conversations' copies with no bench login at all.
 *
 * The gateway runs Tex's turns; the driver (`scripts/tex-lab-sandbox-bench.mjs`, Node) pumps the job, judges each turn
 * with the bench's own judge and posts the row back, and reports the run's results to `texLabRuns` (source
 * "sandbox") through the same door. Every op is the caller's own (a Tex developer's grant, checked by the route):
 *
 *  - `bench_record { set, versionId?, repeats?, convId?, target? }` → `{ runId }`: the run recorded in the control
 *    plane (`texLabRuns.ts` `sandbox_run`). A run on a pull request's preview is recorded here, on main, with
 *    `target: "pr<N>"`, and its job runs on the preview (`bench_start` there).
 *  - `bench_start { runId, set, versionId?, repeats?, convId?, groupChat? }` → `{ runId, units, convs }`: the job, one
 *    Durable Object a run (`benchJob.js`), with the run's conversations (`labRunSets.mjs`, the GitHub run's own pick)
 *    and units. Starting the same run again changes nothing, so a driver that lost the answer may ask again.
 *  - `bench_status { runId }`, `bench_conv { runId, convId }`, `bench_turn { runId, i }`, `bench_rows { runId }`.
 *  - `bench_step { runId }` → `{ i, unit, turn }`, or `{ done, counts }` when nothing is left to claim: one unit's
 *    turn, its text drawn from the sandbox bench's own budget (`LAB_BENCH_DAILY_TEXTS` a day, `benchJob.js`), never
 *    the person's test texts a day (`route.js` DAILY_SENDS). 429 `{ budget: true }` when the budget is spent.
 *  - `bench_row { runId, i, row }` → `{ counts }`: the driver's judged row (first row wins).
 *  - `bench_finish { runId, stage }`: the job's stage. `bench_report { runId, stage, results?, error?, commit? }`: the
 *    run's results to the control plane (`sandbox_report`), as the GitHub workflow reports its own.
 */

import REPO from "../../src/texSetsRepo.generated.json" with { type: "json" };
import { benchUnits, runConversations } from "../../src/labRunSets.mjs";
import { benchBudgetStub, benchDailyTexts, benchJobStub, RUN_ID } from "./benchJob.js";
import { notWords, runBenchUnit } from "./benchTurn.js";
import { callSandbox } from "./object.js";
import { TURN_LIMIT_MS } from "./harness.js";

export const BENCH_OPS = new Set(["bench_record", "bench_start", "bench_status", "bench_conv", "bench_step", "bench_turn", "bench_row", "bench_rows", "bench_finish", "bench_report"]);
const CHAT_KEY = /^[0-9a-f]{64}$/;
const VERSION = /^(main|v[a-z0-9]{1,60})$/;
const TARGET = /^pr[1-9][0-9]{0,6}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;
/** A claimed unit whose step has not turned in this long died: its turn's bound, a job's, and a minute. */
export const BENCH_STALE_MS = TURN_LIMIT_MS + 10 * 60_000 + 60_000;

const setOf = (set) => (set === "training" ? "training" : set === undefined || set === null || set === "dev" ? "dev" : null);
const repeatsOf = (n) => (n === undefined || n === null ? 3 : Number.isInteger(n) && n >= 1 && n <= 5 ? n : null);

/** One sandbox bench text from the bench's own budget: `{ ok, n, max }`. */
export async function takeBenchText(env, day = new Date().toISOString().slice(0, 10)) {
  return await callSandbox(benchBudgetStub(env), "bench.budget", { day, max: benchDailyTexts(env) });
}

/** The answer to one `bench_*` op. `deps` are the route's: env, controlPlane, token, who, origin, runTurn, helpers. */
export async function serveBench(input, deps) {
  const { env, controlPlane, token, who, origin, runTurn, helpers } = deps;
  const { json, refused } = helpers;
  if (input.op === "bench_record") {
    const set = setOf(input.set);
    if (set === null) return refused(400, "set is training or dev");
    const repeats = repeatsOf(input.repeats);
    if (repeats === null) return refused(400, "repeats is 1 to 5");
    if (input.target !== undefined && !TARGET.test(String(input.target))) return refused(400, "target is pr<N>, or unset for this deployment");
    const answer = await controlPlane.texDev(token, "sandbox_run", { draft: input.versionId ?? "main", kind: input.convId ? "chat" : "dev", ...(input.convId ? { conv: input.convId } : {}), set, repeats, ...(input.target ? { target: input.target } : {}) });
    if (answer?.status !== "ok" || typeof answer.id !== "string") return refused(answer?.status === "refused" ? 403 : 400, String(answer?.error ?? "the control plane did not record the run"));
    return json({ runId: answer.id });
  }
  if (input.op === "bench_report") {
    if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) return refused(400, "name the run: runId");
    if (input.commit !== undefined && !COMMIT.test(String(input.commit))) return refused(400, "commit is a commit's hex id");
    const answer = await controlPlane.texDev(token, "sandbox_report", { id: input.runId, stage: input.stage, ...(input.results !== undefined ? { results: input.results } : {}), ...(typeof input.error === "string" ? { error: input.error.slice(0, 300) } : {}), ...(input.commit ? { commit: input.commit } : {}) });
    if (answer?.status !== "ok") return refused(answer?.status === "refused" ? 403 : 400, String(answer?.error ?? "the control plane did not take the report"));
    return json({ ok: true, ...(answer.unchanged ? { unchanged: true } : {}) });
  }

  if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) return refused(400, "name the run: runId");
  const stub = benchJobStub(env, who.userId, input.runId);
  const call = (op, fields = {}) => callSandbox(stub, op, fields);

  if (input.op === "bench_start") {
    const set = setOf(input.set);
    if (set === null) return refused(400, "set is training or dev");
    const repeats = repeatsOf(input.repeats);
    if (repeats === null) return refused(400, "repeats is 1 to 5");
    const versionId = input.versionId ?? "main";
    if (typeof versionId !== "string" || !VERSION.test(versionId)) return refused(400, "versionId is main or a draft's id (v…)");
    if (input.groupChat !== undefined && !CHAT_KEY.test(String(input.groupChat))) return refused(400, "groupChat is one of your group chats' keys");
    // The Lab's drafts over the repo's sets, picked by the GitHub run's own code (`labRunSets.mjs`).
    const listed = await controlPlane.labSandbox(token, "sets", {}).catch(() => null);
    if (listed === null) return refused(503, "the control plane did not answer");
    const drafts = listed.status === "ok" && Array.isArray(listed.drafts) ? listed.drafts : [];
    const convs = runConversations(set, REPO.sets ?? [], drafts, typeof input.convId === "string" ? input.convId : null);
    const units = benchUnits(convs, repeats);
    if (units.length === 0) return refused(400, `no Front door unit tests to run in the ${set} set${input.convId ? ` for ${input.convId}` : ""}`);
    const job = { runId: input.runId, by: who.userId, set, versionId, repeats, groupChat: input.groupChat ?? null, startedAt: Date.now() };
    const kept = await call("bench.init", { job, convs, units });
    console.log(JSON.stringify({ event: "lab_bench_start", set, units: units.length, convs: convs.length, existing: kept.existing === true, draft: versionId !== "main" }));
    return json({ runId: input.runId, units: kept.counts?.total ?? units.length, convs: convs.length, existing: kept.existing === true });
  }
  if (input.op === "bench_status") return json(await call("bench.status"));
  if (input.op === "bench_conv") return json(await call("bench.conv", { id: input.convId }));
  if (input.op === "bench_turn") return json(await call("bench.get", { i: input.i }));
  if (input.op === "bench_rows") return json(await call("bench.rows"));
  if (input.op === "bench_row") {
    if (!input.row || typeof input.row !== "object" || Array.isArray(input.row)) return refused(400, "row is the judged row");
    return json(await call("bench.row", { i: input.i, row: input.row }));
  }
  if (input.op === "bench_finish") return json(await call("bench.finish", { stage: input.stage }));

  // `bench_step`: claim first, then the budget; a refused budget gives the claim back, so the unit waits for tomorrow.
  const status = await call("bench.status");
  if (!status.job) return refused(404, "There is no such bench run here: bench_start it first.");
  const claimed = await call("bench.claim", { staleMs: BENCH_STALE_MS });
  if (claimed.claimed === null) return json({ done: claimed.counts.pending === 0 && claimed.counts.running === 0, counts: claimed.counts });
  const { i, unit } = claimed.claimed;
  const { conv } = await call("bench.conv", { id: unit.chat });
  // A unit that is no texted words runs nothing, so it takes no budget (`runBenchUnit` says why it could not run).
  if (notWords(conv?.msgs?.[unit.at]) === null) {
    const budget = await takeBenchText(env);
    if (!budget.ok) {
      await call("bench.release", { i });
      return json({ error: `the sandbox bench's ${budget.max} texts a day are spent: resume tomorrow`, budget: true }, 429);
    }
  }
  const turn = await runBenchUnit({ env, controlPlane, token, who, origin, job: status.job, unit, conv, runTurn, helpers });
  await call("bench.turn", { i, turn });
  console.log(JSON.stringify({ event: "lab_bench_step", i, ran: turn.ran === true, ms: turn.ms }));
  return json({ i, unit, turn });
}
