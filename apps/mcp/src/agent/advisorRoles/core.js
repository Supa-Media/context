/**
 * THE ADVISOR'S SHARED CORE (Dev2, 2026-11-13: "should we just split them up to be different agents so that they can be
 * evaluated separately?"; docs/decisions/testing/advisor-roles.md).
 *
 * One model (`models.advisor`) plays four roles, each with instructions of its own in this folder:
 *
 * - `chat.js`: the front door's advisor, `ask_advisor` (`advisor.js`).
 * - `jobCheck.js`: the job check at every stop of a background job (`jobCheck.js`).
 * - `planner.js`: the big-ask planner, `plan_big_ask` (`planBigAsk.js`).
 * - `jobMail.js`: the advisor on a job note's mail (`jobNote.js`).
 *
 * What they share is here: how one ask is sent (the drawing ahead of the role's instructions, no tools, its thinking
 * summarized) and how its thinking is read back. Each role is its own area of the replay gate (`bench/replayAreas.mjs`,
 * cases in `bench/advisor/<role>.json`), so a change to one role's file runs that role's cases alone and a change to
 * this file runs every role's.
 */

import { requestBuiltin } from "../builtin.js";
import { withArchitecture } from "../texArchitecture.js";

/**
 * One ask of the advisor in one of its roles: its instructions behind the drawing (`texArchitecture.js`, `role` the
 * box it is), one user message, no tools. `display: "summarized"`: its thinking comes back in words, kept with its
 * answer in the chat's history (Dev, 2026-11-02: "'Its private reasoning isn't kept.' - why?"); it never goes to Tex.
 */
export function adviseOnce({ request, model, effort, prompt, role, brief }) {
  return request({ model, system: withArchitecture(prompt, role), messages: [{ role: "user", text: brief }], tools: [], display: "summarized", ...(effort ? { effort } : {}) });
}

/** The advisor's thinking in words (`aiGateway.js` hands back the answer's blocks when it thought), or "". */
export function advisorThinking(answer) {
  const blocks = Array.isArray(answer?.content) ? answer.content : [];
  return blocks
    .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
    .map((block) => block.thinking.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** `requestBuiltin` bound to a turn's provider options, for every role's `request`. */
export function advisorRequest(providerOptions) {
  return (params) => requestBuiltin(params, providerOptions.ai, providerOptions);
}
