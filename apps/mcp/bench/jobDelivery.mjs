/**
 * A JOB A TEST'S TURN STARTED RUNS, AND ITS REPORT IS TEXTED, AS PRODUCTION DOES (Dev2, 2026-11-18: "When a job is
 * long or multi-step, it acknowledges right away and hands the job to a background worker ... The worker then delivers
 * the result").
 *
 * Until now a bench turn that started a background job recorded the start and ran nothing (`world.mjs`: "nothing runs
 * them here"), so a test whose ask was the work could pass only by a turn doing it all before it answered: a handoff
 * the person would have had the result of minutes later read as a promise. Production's texting Worker runs the job
 * part after part in its own Durable Object (`apps/agent/src/jobRun.ts`), with the job check after each part, and then
 * queues the report as a turn of the chat (`jobTexts.ts` `jobUpdate`), which texts the result (`jobReport.js`).
 *
 * Here, after the test's texts: each job its turns started (the first `MAX_DELIVERED_JOBS`) runs as the Worker runs it,
 * through the real gateway, part after part while the job check says it is not finished (`jobTasks.mjs` `runJob`, at
 * most the Part end node's `parts` and never more than `MAX_DELIVERED_PARTS`, to bound a run's cost; a job that bound
 * stopped is marked `capped`, and a job past `MAX_DELIVERED_JOBS` is recorded as not run), and its report
 * then runs as the chat's turn with `event: "job_report"` (`byCode.mjs`). What that turn texts is the person's later
 * text, kept in the conversation marked `later`, before the person's next text, so the judge grades the whole exchange
 * the person would have had, and is told a `later` line came minutes after (`judge.mjs`): how fast or how short the
 * first answer was is graded on the lines before it.
 * Nothing here decides when a job starts: that is the turn's, from its own config.
 */

import { endedAs, partsUsd, runJob } from "./jobTasks.mjs";
import { priceUsd } from "./report.mjs";
import { runningJob } from "./byCode.mjs";
import { readTexConfig } from "../../../scripts/lib/texConfigFile.mjs";
import { realNow } from "./clock.mjs";

/** Jobs one test may run after its texts: production runs three at once per chat (`jobStart` `cloudSlots`). */
export const MAX_DELIVERED_JOBS = 2;
/** Parts one delivered job may take: production allows the Part end node's `parts` (10); the bench stops sooner. */
export const MAX_DELIVERED_PARTS = 4;

/** The parts production allows a job: the Part end node's `parts` (`jobPartEnd.cjs`), 10 when the config has none. */
export function productionParts(config) {
  const node = (config?.nodes ?? []).find((n) => n?.id === "partEnd");
  const parts = Number(node?.limits?.parts);
  return Number.isInteger(parts) && parts > 0 ? parts : 10;
}

/** The parts a delivered job may take here: production's, under the bench's own bound. */
export const partsAllowed = (config) => Math.min(productionParts(config), MAX_DELIVERED_PARTS);

/**
 * The report the Worker hands the chat's turn for a job whose parts are `parts` (`jobTexts.ts` `reportOf`): its last
 * part's words, in the state the Worker ends it in; null when the job said nothing, as the Worker texts nothing then.
 */
export function deliveredReport(job, parts, id) {
  const said = [...parts].reverse().find((part) => part.ok && typeof part.answer === "string" && part.answer.trim() !== "");
  if (!said) return null;
  return { id, title: String(job.title ?? ""), state: endedAs(parts), texts: [said.answer.trim()] };
}

/**
 * Run each started job and its report turn. `world` is the test's world, `jobs` the turns' `jobs` (`{ title, brief }`),
 * each with `asked`, the person's text whose turn started it. Answers what each delivered: `{ title, state, parts, text, turn }`,
 * `turn` the report turn's `world.text` result (null when nothing was texted).
 */
export async function deliverJobs(world, jobs, { running = null, config = null, now = () => Date.now() } = {}) {
  const maxParts = partsAllowed(config);
  const out = [];
  for (const [i, job] of jobs.slice(0, MAX_DELIVERED_JOBS).entries()) {
    const id = `bench-delivered-${i + 1}`;
    const asked = String(job.asked ?? "");
    const { parts } = await runJob(world, { id, text: asked, job: { title: job.title, brief: job.brief } }, { maxParts, posted: true });
    const report = deliveredReport(job, parts, `bench-${id}`); // the id runJob gave the job
    if (report === null) {
      out.push({ title: job.title, state: endedAs(parts), parts, text: "", turn: null });
      continue;
    }
    const turn = await world.text(asked, [], { byCode: true, cause: "job_report", event: { event: "job_report", jobReport: report }, running: [...(running ?? []), runningJob(report, now())] });
    // Still not finished when the bench's bound stopped it, where production had parts left: said, never hidden.
    const capped = report.state === "stuck" && parts.length >= maxParts && maxParts < productionParts(config);
    out.push({ title: job.title, state: report.state, parts, text: turn.ok ? turn.answer : "", turn, ...(capped ? { capped: true } : {}) });
  }
  return out;
}

/** What a report turn cost, model by model. */
const turnUsd = (turn) => Object.entries(turn?.usageByModel ?? {}).reduce((sum, [model, usage]) => sum + (priceUsd(model, usage, { perCall: false }) ?? 0), 0);

/** What every delivered job of `runs` added: jobs run, parts, the job advisor's calls and spend. */
export function handoffTotals(delivered) {
  const ran = (Array.isArray(delivered) ? delivered : []).filter((d) => d && d.state !== "not run");
  const usd = ran.reduce((sum, d) => sum + (Number(d.usd) || 0), 0);
  return { jobs: ran.length, parts: ran.reduce((n, d) => n + (Number(d.parts) || 0), 0), advisorCalls: ran.reduce((n, d) => n + (Number(d.advisorCalls) || 0), 0), usd: Math.round(usd * 10_000) / 10_000 };
}

/** The usage of every model in `byModel`, added up. */
export const sumUsage = (byModel) => Object.values(byModel ?? {}).reduce((sum, u) => ({ input: sum.input + (u.input ?? 0), output: sum.output + (u.output ?? 0), cacheRead: sum.cacheRead + (u.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (u.cacheWrite ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Add a turn's (or a job part's) usage, each model's spend and rounds into `totals`, priced model by model later. */
export function addSpend(totals, turn) {
  for (const key of Object.keys(totals.usage)) totals.usage[key] += turn.usage?.[key] ?? 0;
  // What each model spent and how many rounds it ran (`src/agent/modelPlan.js`): priced model by model.
  for (const [model, spent] of Object.entries(turn.usageByModel ?? {})) {
    const into = (totals.usageByModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (const key of Object.keys(into)) into[key] += spent[key] ?? 0;
  }
  for (const [model, count] of Object.entries(turn.rounds ?? {})) totals.rounds[model] = (totals.rounds[model] ?? 0) + count;
}

/**
 * Run the jobs one turn started and put their reports into the conversation (`jobDelivery.mjs`). Its time is the job's,
 * never the reply's (`jobMs`), and its spend is the test's. A job past the bench's bound is recorded as not run, so a
 * result never reads a dropped job as one that ran.
 */
export async function deliverInto(world, jobs, { conversation, totals, running, clock = realNow }) {
  const started = clock();
  const room = Math.max(0, MAX_DELIVERED_JOBS - totals.delivered.filter((d) => d.state !== "not run").length);
  for (const done of await deliverJobs(world, jobs.slice(0, room), { running, config: readTexConfig() })) {
    // A part keeps only its spend by model (`jobTasks.mjs` runJob): its usage is their sum.
    for (const part of done.parts) addSpend(totals, { usage: sumUsage(part.usageByModel), usageByModel: part.usageByModel });
    if (done.turn !== null) {
      addSpend(totals, done.turn);
      totals.traces.push(done.turn.trace ?? []);
    }
    // What the job added, for Finance beside the score (Dev2, 2026-11-18): its done checks (the job advisor's calls) and its spend.
    const usd = partsUsd(done.parts) + turnUsd(done.turn);
    totals.delivered.push({ title: done.title, state: done.state, parts: done.parts.length, advisorCalls: done.parts.filter((part) => part.checked).length, usd: Math.round(usd * 1e6) / 1e6, ...(done.capped ? { capped: true } : {}) });
    if (done.text !== "") conversation.push({ from: "assistant", text: done.text, later: "texted when the background job finished" });
  }
  for (const job of jobs.slice(room)) totals.delivered.push({ title: job.title, state: "not run", parts: 0, advisorCalls: 0, usd: 0 });
  totals.jobMs += clock() - started;
}
