/**
 * THE JOB MAIL ADVISOR NODE: the model's answer to a question a job asks on its
 * note's mail (`jobNote.js` `adviseRoute`, its model branch). It picks the
 * model, asks it once with the mail role's instructions, and meters the call
 * as builtin usage. Reading the note and sending the answer on the mail stay
 * with the route; the runner logs the step.
 *
 * Live things (the production setup, the env, the request, the control plane
 * and the session) come from `io.ctx.mailadv`.
 */

import { adviseOnce, advisorRequest } from "../../advisorRoles/core.js";
import { ADVISOR_MAIL_PROMPT } from "../../advisorRoles/jobMail.js";
import { jobMailBrief } from "../../jobNote.js";
import { aiGatewayConfig } from "../../aiGateway.js";
import { builtinModel, canRunBuiltin } from "../../builtin.js";

/**
 * @param {{ jobId: string, title: string, brief: string, doneWhen: string, from: string, question: string, noteText: string }} input
 * @param {{ ctx: { mailadv: { production?: object, env?: object, request?: Function, controlPlane?: object, session?: object } } }} io
 * @returns {Promise<{ model: string, words: string, ok: boolean }>}
 */
export async function mailadv(input, io) {
  const { production, env, controlPlane, session } = io.ctx.mailadv;
  const model = [production?.advisor, production?.model, builtinModel(env)].find((name) => typeof name === "string" && canRunBuiltin(name, env));
  if (typeof model !== "string") return { model: "", words: "", ok: false };
  const request =
    io.ctx.mailadv.request ??
    advisorRequest({ ai: env?.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session?.workspaceId), client: "job-advisor" } });
  const started = Date.now();
  let answer = null;
  try {
    answer = await adviseOnce({
      request,
      model,
      effort: production?.efforts?.[model],
      prompt: ADVISOR_MAIL_PROMPT,
      role: "jobAdvisor",
      brief: jobMailBrief({ title: input.title, brief: input.brief, doneWhen: input.doneWhen, from: input.from, noteText: input.noteText, question: input.question }),
    });
  } catch {
    answer = null;
  }
  try {
    await controlPlane?.recordBuiltinUsage?.(session?.accessToken, session?.workspaceId, {
      input: answer?.usage?.input ?? 0,
      output: answer?.usage?.output ?? 0,
      cacheRead: answer?.usage?.cacheRead ?? 0,
      cacheWrite: answer?.usage?.cacheWrite ?? 0,
      model,
      decision: 0,
      failed: answer === null,
      ms: Date.now() - started,
      background: true, // a job's advisor, like a job's turn, is never on the daily cap
    });
  } catch {
    // A meter that could not be reached costs us a report, not the job its answer.
  }
  const words = typeof answer?.text === "string" ? answer.text.trim() : "";
  return { model, words, ok: answer !== null };
}
