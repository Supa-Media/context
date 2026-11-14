/**
 * The migration's bridges: plumbing that is not a node yet runs a node over the config's own wire (`gatewayGraph`
 * `fire`), so the runner checks its shape and logs it, and the caller keeps the value it read before. Each bridge goes
 * when its caller becomes a node: a job's part (`job`) is still the door's path today, so Job check, the Hand-back
 * judge and the Advisor on job mail are reached from the code that runs that part, over the job's wires.
 */
import { checkOf } from "./nodes/jobcheck.js";

/** `checkJob`'s drop-in: Job check over the job -> jobcheck wire; the same `null` or verdict `checkJob` returned. */
export function jobCheckOnGraph(graph) {
  return async ({ job, live, answer, exhausted = false, model, effort, request, meter }) => {
    if (job === null || typeof model !== "string" || typeof request !== "function") return null;
    const output = await graph.fire("job", "jobcheck", { job, answer: typeof answer === "string" ? answer : "", exhausted: exhausted === true }, { jobCheck: { live, model, effort, request, meter } });
    return checkOf(output);
  };
}

/** `handbackJudgeFor`'s judge, `(answer, steps) => notice | null`, over the job -> handback wire; null with no model road. */
export function handbackOnGraph(graph, { question, config, metadata, request, log }) {
  if (!config) return null;
  return async (answer, steps = []) => {
    const output = await graph.fire("job", "handback", { question: typeof question === "string" ? question : "", answer: typeof answer === "string" ? answer : "", steps: steps.map((s) => ({ name: String(s?.name ?? ""), ok: s?.ok === true })) }, { handback: { config, metadata, ...(request ? { request } : {}), ...(log ? { log } : {}) } });
    return output.notice === "" ? null : output.notice;
  };
}
