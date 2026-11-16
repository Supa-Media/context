/**
 * The migration's bridges: plumbing that is not a node yet runs a node over the config's own wire (`gatewayGraph`
 * `fire`), so the runner checks its shape and logs it, and the caller keeps the value it read before. Each bridge goes
 * when its caller becomes a node: a job's part is run by the job node (`nodes/job.js`), which lends its io, so Job check,
 * the Hand-back judge and the Advisor on job mail are reached through it (`jobCheckFor`, `handbackFor`); the bridges
 * below stay for a job run by a Worker, and for a caller that finds no pass running here.
 */
import { checkOf } from "./nodes/jobcheck.js";
import { borrowJob } from "./jobHandles.js";

/** `checkJob`'s drop-in: Job check over the job -> jobcheck wire; the same `null` or verdict `checkJob` returned. */
export function jobCheckOnGraph(graph) {
  return async ({ job, live, answer, exhausted = false, model, effort, request, meter }) => {
    if (job === null || typeof model !== "string" || typeof request !== "function") return null;
    const input = { job, answer: typeof answer === "string" ? answer : "", exhausted: exhausted === true };
    // A draft that draws the Job advisor runs the check as its `check` role (`nodes/jobadv.js`); main's config, Job check.
    const output = graph.wired?.("job", "jobadv") ? await graph.fire("job", "jobadv", { role: "check", ...input }, { jobCheck: { live, model, effort, request, meter } }) : await graph.fire("job", "jobcheck", input, { jobCheck: { live, model, effort, request, meter } });
    return checkOf(output);
  };
}

/** The hand-back judge's node input and its ctx, as `handbackOnGraph` has always built them. */
function handbackRun(question, answer, steps, { config, metadata, request, log }) {
  return {
    input: { question: typeof question === "string" ? question : "", answer: typeof answer === "string" ? answer : "", steps: steps.map((s) => ({ name: String(s?.name ?? ""), ok: s?.ok === true })) },
    lend: { handback: { config, metadata, ...(request ? { request } : {}), ...(log ? { log } : {}) } },
  };
}

/** `handbackJudgeFor`'s judge, `(answer, steps) => notice | null`, over the job -> handback wire; null with no model road. */
export function handbackOnGraph(graph, { question, config, metadata, request, log }) {
  if (!config) return null;
  return async (answer, steps = []) => {
    const { input, lend } = handbackRun(question, answer, steps, { config, metadata, request, log });
    const output = await graph.fire("job", "handback", input, lend);
    return output.notice === "" ? null : output.notice;
  };
}

/**
 * The Job check drop-in for one job: while the job's pass runs here (`jobHandles.js`), the check goes over the job node's
 * own `jobcheck` wire; otherwise `jobCheckOnGraph`, over the config's job -> jobcheck wire.
 */
export function jobCheckFor(jobId, graph) {
  const io = borrowJob(jobId);
  if (io === null) return jobCheckOnGraph(graph);
  return async ({ job, live, answer, exhausted = false, model, effort, request, meter }) => {
    if (job === null || typeof model !== "string" || typeof request !== "function") return null;
    const input = { job, answer: typeof answer === "string" ? answer : "", exhausted: exhausted === true };
    const lend = { jobCheck: { live, model, effort, request, meter } };
    const output = "jobadv" in io.use ? await io.use.jobadv({ role: "check", ...input }, lend) : await io.use.jobcheck(input, lend);
    return checkOf(output);
  };
}

/**
 * The hand-back judge for one job: while the job's pass runs here, the judge goes over the job node's own `handback` wire;
 * otherwise `handbackOnGraph`. Null with no model road, as `handbackOnGraph` is.
 */
export function handbackFor(jobId, graph, opts) {
  const io = borrowJob(jobId);
  if (io === null || !opts.config) return handbackOnGraph(graph, opts);
  return async (answer, steps = []) => {
    const { input, lend } = handbackRun(opts.question, answer, steps, opts);
    const run = await io.job.handback(input, lend);
    return run.output.notice === "" ? null : run.output.notice;
  };
}
