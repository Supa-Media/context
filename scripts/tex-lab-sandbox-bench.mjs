#!/usr/bin/env node
/**
 * A LAB RUN IN THE LAB SANDBOX: a whole Training or Dev set's Front door tests, N repeats, run as real Tex turns in the
 * gateway's Lab sandbox and judged here (Seyi, 2026-11-19: "I don't see why we shouldnt be able to run full tests in
 * sandboxes"; plan `products/tex/research/sandbox-bench-scoring-2026-11-19.md`). No bench login and no GitHub runner
 * slot: the gateway runs each turn (`packages/lab/gateway/labSandbox/benchRoute.js`, one job object a run), this
 * judges each turn with the GitHub run's own code (`apps/mcp/bench/sandboxRows.mjs`), and the results go to the Lab's
 * runs (`texLabRuns`, source "sandbox") in the GitHub run's format (`scripts/tex-lab-run.mjs` `resultsOf`).
 *
 *   node scripts/tex-lab-sandbox-bench.mjs start --set training|dev [--version main|v…] [--repeats 3] [--conv <id>]
 *        [--group-chat <key>] [--target main|pr<N>] [--parallel 2] [--commit <sha>]
 *   node scripts/tex-lab-sandbox-bench.mjs resume <runId> [--target main|pr<N>] [--parallel 2] [--commit <sha>]
 *   node scripts/tex-lab-sandbox-bench.mjs status <runId> [--target main|pr<N>]
 *
 * Environment (never printed): `LAB_GATEWAY_URL` main's gateway origin and `LAB_TOKEN` a Tex developer's AI client
 * grant there, which records the run. `--target pr<N>` runs the turns on pull request N's preview instead
 * (`deploy-preview.yml`): `LAB_PREVIEW_WORKERS_DEV` the account's workers.dev host and `LAB_PREVIEW_TOKEN` a grant on
 * that preview. The judge is Haiku over the bench's transport (`models.mjs` `claudeTransport`, the bench's
 * `AI_GATEWAY_*` variables). Every unit's progress is kept in the gateway, so `resume` picks up where a run stopped,
 * including a day the sandbox bench's own budget ran out (`LAB_BENCH_DAILY_TEXTS`, never the person's 200 test texts).
 *
 * What a sandbox run is not, until parity says otherwise (`scripts/tex-lab-parity.mjs`): no record/replay of the
 * simulated world (a turn reads the sandbox's wiring, the caller's own workspaces copy-on-write, never the bench's
 * world fixtures), only texted words run (a trigger, a tapback or pictures is a row that could not run), and a test
 * chat's clock is the day it ran. Standard output says counts and ids only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeTransport } from "../apps/mcp/bench/models.mjs";
import { sandboxRow } from "../apps/mcp/bench/sandboxRows.mjs";
import { brokenRun, resultsOf, unrun } from "./tex-lab-run.mjs";

const TARGET = /^(main|pr[1-9][0-9]{0,6})$/;
const RUN_ID = /^[a-z0-9]{16,40}$/;

/** Flags: `--name value` pairs after the subcommand's own words. */
export function argsOf(argv) {
  const words = [];
  const flags = {};
  for (let k = 0; k < argv.length; k++) {
    if (argv[k].startsWith("--")) flags[argv[k].slice(2)] = argv[k + 1]?.startsWith("--") || argv[k + 1] === undefined ? "true" : argv[++k];
    else words.push(argv[k]);
  }
  return { words, flags };
}

/** The gateway a run's turns go to, and the one that records it: main's, or a pull request's preview's for the turns. */
export function gatewaysOf(target = "main", env = process.env) {
  if (!TARGET.test(target)) throw new Error("--target is main or pr<N>");
  const main = { origin: String(env.LAB_GATEWAY_URL ?? "").replace(/\/+$/, ""), token: env.LAB_TOKEN };
  if (!/^https:\/\//.test(main.origin) || !main.token) throw new Error("set LAB_GATEWAY_URL (https) and LAB_TOKEN: main's gateway records every run");
  if (target === "main") return { record: main, job: main };
  const host = String(env.LAB_PREVIEW_WORKERS_DEV ?? "").replace(/^\.+|\/+$/g, "");
  if (!/^[a-z0-9.-]+$/.test(host) || !env.LAB_PREVIEW_TOKEN) throw new Error("a preview target needs LAB_PREVIEW_WORKERS_DEV and LAB_PREVIEW_TOKEN");
  return { record: main, job: { origin: `https://context-mcp-${target}.${host}`, token: env.LAB_PREVIEW_TOKEN } };
}

/** One `/tex-lab/sandbox` op on a gateway: `{ status, body }`. */
export function caller(gateway, fetchImpl = fetch) {
  return async (body) => {
    const response = await fetchImpl(`${gateway.origin}/tex-lab/sandbox`, { method: "POST", headers: { authorization: `Bearer ${gateway.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
}

const must = (answer, what) => {
  if (answer.status !== 200) throw new Error(`${what} refused (${answer.status}): ${String(answer.body?.error ?? "").slice(0, 200)}`);
  return answer.body;
};

/**
 * Drives one run's job to its end: each unit's turn (`bench_step`), judged here and its row posted back; units that
 * turned but were never judged (a driver that died between the two) are judged first. Returns `{ done, budget }`.
 */
export async function pump({ job, runId, judge, parallel = 1, log = () => {} }) {
  const convs = new Map();
  const convOf = async (id) => {
    if (!convs.has(id)) convs.set(id, must(await job({ op: "bench_conv", runId, convId: id }), "bench_conv").conv);
    return convs.get(id);
  };
  const judgeOne = async (unit, turn) => {
    const row = await judge({ unit, conv: await convOf(unit.chat), turn });
    must(await job({ op: "bench_row", runId, i: unit.i, row }), "bench_row");
  };
  const status = must(await job({ op: "bench_status", runId }), "bench_status");
  for (const u of status.units.filter((x) => x.state === "turned")) {
    const kept = must(await job({ op: "bench_turn", runId, i: u.i }), "bench_turn");
    await judgeOne(kept.unit, kept.turn);
  }
  let budget = false;
  let done = false;
  const lane = async () => {
    while (!budget && !done) {
      const step = await job({ op: "bench_step", runId });
      if (step.status === 429 && step.body?.budget) return void (budget = true);
      const said = must(step, "bench_step");
      if (said.done !== undefined) {
        // Nothing left to claim; another lane's unit may still be running.
        if (said.done) done = true;
        return;
      }
      await judgeOne(said.unit, said.turn);
      log(`unit ${said.i}: ${said.turn.ran ? "ran" : "could not run"}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, Number(parallel) || 1)) }, lane));
  const after = must(await job({ op: "bench_status", runId }), "bench_status");
  return { done: after.counts.total === after.counts.judged, budget, counts: after.counts };
}

/**
 * The run's results from its rows, as the GitHub run makes them, and whether it failed: a step that ran none of its
 * tests, or Claude calls out of credit, fail the run as `tex-lab-run.mjs ran` fails the workflow's.
 */
export function finishOf(rows, ms, convs) {
  const none = unrun(rows);
  if (none.length > 0) return { stage: "failed", error: none.map((x) => `none of ${x.node}'s ${x.total} tests could run: ${x.why}`).join(" | ").slice(0, 280) };
  const broken = brokenRun(rows);
  if (broken?.startsWith("Claude calls could not run")) return { stage: "failed", error: broken.slice(0, 280) };
  return { stage: "done", results: resultsOf(rows, ms, null, { models: "gw", convs }) };
}

async function finish({ job, record, runId, started, commit }) {
  const rows = must(await job({ op: "bench_rows", runId }), "bench_rows").rows;
  const status = must(await job({ op: "bench_status", runId }), "bench_status");
  const ids = [...new Set(status.units.map((u) => u.chat))];
  const convs = [];
  for (const id of ids) convs.push(must(await job({ op: "bench_conv", runId, convId: id }), "bench_conv").conv);
  const end = finishOf(rows, Date.now() - started, convs);
  must(await job({ op: "bench_finish", runId, stage: end.stage }), "bench_finish");
  must(await record({ op: "bench_report", runId, stage: end.stage, ...(end.results ? { results: end.results } : {}), ...(end.error ? { error: end.error } : {}), ...(commit ? { commit } : {}) }), "bench_report");
  return end;
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const { words, flags } = argsOf(rest);
  const target = flags.target ?? "main";
  const gateways = gatewaysOf(target);
  const record = caller(gateways.record);
  const job = caller(gateways.job);
  if (flags.commit !== undefined && !/^[0-9a-f]{7,40}$/.test(flags.commit)) throw new Error("--commit is a commit's hex id");

  let runId = words[0];
  if (sub === "start") {
    if (target !== "main" && flags.version && flags.version !== "main") throw new Error("a preview runs its pull request's code: no --version there");
    const repeats = flags.repeats === undefined ? 3 : Number(flags.repeats);
    const recorded = must(await record({ op: "bench_record", set: flags.set, versionId: flags.version ?? "main", repeats, ...(flags.conv ? { convId: flags.conv } : {}), ...(target !== "main" ? { target } : {}) }), "bench_record");
    runId = recorded.runId;
    const started = must(await job({ op: "bench_start", runId, set: flags.set, versionId: flags.version ?? "main", repeats, ...(flags.conv ? { convId: flags.conv } : {}), ...(flags["group-chat"] ? { groupChat: flags["group-chat"] } : {}) }), "bench_start");
    console.log(`sandbox run ${runId}: ${started.units} units over ${started.convs} conversations on ${target}`);
  } else if (sub === "status") {
    if (!RUN_ID.test(String(runId))) throw new Error("name the run: status <runId>");
    const status = must(await job({ op: "bench_status", runId }), "bench_status");
    console.log(`sandbox run ${runId}: ${JSON.stringify(status.counts)}; stage ${status.job?.stage ?? "unknown"}`);
    return;
  } else if (sub !== "resume") {
    throw new Error("usage: tex-lab-sandbox-bench.mjs start --set training|dev [...] | resume <runId> [...] | status <runId>");
  }
  if (!RUN_ID.test(String(runId))) throw new Error("name the run: resume <runId>");

  const scratch = await mkdtemp(join(tmpdir(), "lab-sandbox-bench-"));
  const send = claudeTransport(process.env);
  const started = Date.now();
  try {
    const judge = ({ unit, conv, turn }) => sandboxRow({ unit, conv, turn, scratch, send, ...(flags.commit ? { commit: flags.commit } : {}) });
    const pumped = await pump({ job, runId, judge, parallel: flags.parallel ?? 2, log: (line) => console.log(line) });
    if (!pumped.done) {
      console.log(`sandbox run ${runId}: stopped at ${JSON.stringify(pumped.counts)}${pumped.budget ? "; the sandbox bench's budget for today is spent" : ""}: resume ${runId}`);
      return;
    }
    const end = await finish({ job, record, runId, started, commit: flags.commit });
    console.log(end.stage === "done" ? `sandbox run ${runId}: done, ${end.results.pass}/${end.results.total} (fallbacks ${end.results.fallbacks}, ${end.results.valid ? "valid" : "not valid"})` : `sandbox run ${runId}: failed`);
  } catch (error) {
    // Never reported as failed here: every unit's progress is kept, so the run is resumed, not lost.
    console.error(`sandbox run ${runId}: stopped; resume ${runId}`);
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`tex-lab-sandbox-bench: ${String(error?.message ?? error).slice(0, 300)}`);
    process.exit(1);
  });
}
