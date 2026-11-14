/**
 * THE JOB CHECK NODE: the advisor's verdict on one background job's part
 * (`jobCheck.js` `checkJob`). Wraps it so the graph runner can run it.
 *
 * The live things (the request function, the meter, the chat's messages) come
 * from `io.ctx.jobCheck`, never from the input or the output, which stay plain
 * and loggable. `checkOf` maps the output back to what `checkJob` returned, so
 * a caller keeps the exact same behaviour.
 */

import { checkJob } from "../../jobCheck.js";

/**
 * @param {{ job: object, answer: string, exhausted: boolean }} input
 * @param {{ ctx: { jobCheck: { live: object, model: string, effort?: string, request: Function, meter?: Function } } }} io
 * @returns {Promise<{ verdict: string, advice: string, thinking: string }>}
 */
export async function jobcheck(input, io) {
  const { live, model, effort, request, meter } = io.ctx.jobCheck;
  const check = await checkJob({ job: input.job, live, answer: input.answer, exhausted: input.exhausted, model, effort, request, meter });
  if (check === null) return { verdict: "none", advice: "", thinking: "" };
  return { verdict: check.verdict, advice: check.advice ?? "", thinking: check.thinking ?? "" };
}

/** The `checkJob` result an output stands for: null for "none", else the verdict with only the fields that are set. */
export function checkOf(output) {
  if (output.verdict === "none") return null;
  return {
    verdict: output.verdict,
    ...(output.advice ? { advice: output.advice } : {}),
    ...(output.thinking ? { thinking: output.thinking } : {}),
  };
}
