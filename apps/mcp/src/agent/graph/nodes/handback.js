/**
 * THE HAND-BACK NODE: the judge's reading of one texted answer before it goes
 * (`handbackJudge.js`). It names the asks, the one hand-back that would send the
 * answer back for another round, and the notice for it. It logs the same
 * `handback_judged` line `handbackJudgeFor` writes: codes and counts, never words.
 *
 * `config`, `request`, `metadata` and `log` come from `io.ctx.handback`. The
 * request defaults to the gateway's, and the log to a console line, as they do
 * in `handbackJudgeFor`.
 */

import { judgeAsks, noticeFor, requestViaGateway } from "../../handbackJudge.js";

/**
 * @param {{ question: string, answer: string, steps: Array<{ name: string, ok: boolean }> }} input
 * @param {{ ctx: { handback: { config?: object, request?: Function, metadata?: object, log?: Function } } }} io
 * @returns {Promise<{ judged: boolean, codes: string[], sentBack: string, notice: string }>}
 */
export async function handback(input, io) {
  const { config, request = requestViaGateway, metadata, log = (line) => console.log(line) } = io.ctx.handback;
  // Without a model road the judge is not run, and nothing is logged, as in `handbackJudgeFor`.
  if (!config) return { judged: false, codes: [], sentBack: "", notice: "" };
  const asks = await judgeAsks({ question: input.question, answer: input.answer, steps: input.steps ?? [], config, request, metadata });
  const codes = asks?.map((ask) => ask.code) ?? [];
  const sentBack = codes.find((code) => code.startsWith("H")) ?? "";
  // Codes only: the production hand-back rate, never the person's words or Tex's.
  log(JSON.stringify({ event: "handback_judged", workspace: metadata?.workspace ?? null, judged: asks !== null, codes, sentBack: sentBack === "" ? null : sentBack }));
  return { judged: asks !== null, codes, sentBack, notice: sentBack === "" ? "" : (noticeFor(sentBack) ?? "") };
}
