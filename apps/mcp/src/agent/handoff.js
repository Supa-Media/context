/**
 * THE FRONT DOOR HANDS A JOB IT COULD NOT FINISH TO A BACKGROUND WORKER (Dev2, 2026-11-18; the Hand-off node,
 * `graph/nodes/handoff.js`). The turn's side of it: when the config wires `answerCheck -> handoff`, the answer check
 * asks this hook at a draft it would send back with no send-back left (`graph/nodes/answerCheck.js`). The node says
 * whether to hand off and writes the job; this starts it through the turn's own background jobs (`background.js` `call`,
 * so the Job start node's slots and its "already running" check hold), and answers the start tapback for the turn to
 * end on (`QUIET_ACK`), or null when no job started (no slot, or the node kept the draft).
 */
import { QUIET_ACK, START_JOB_TOOL } from "./background.js";

/** The turn's tool results so far, from its messages, oldest first. */
export const toolResultsOf = (messages) => (Array.isArray(messages) ? messages : []).filter((m) => m?.role === "tool").map((m) => ({ name: String(m.name ?? ""), text: typeof m.text === "string" ? m.text : "", ...(m.isError ? { isError: true } : {}) }));

/**
 * `background` is the turn's (`background.js`), `gate(input)` fires the Hand-off node and answers its output, `ask` is
 * their text. The hook answers what the turn ends on, or null.
 */
export function handoffHook({ background, gate, ask }) {
  if (background === null || typeof background?.call !== "function" || typeof gate !== "function") return null;
  let tried = false;
  return async (draft, info, notice) => {
    if (tried) return null; // once a turn
    tried = true;
    const out = await gate({ ask: String(ask ?? ""), draft: String(draft ?? ""), notice: String(notice ?? ""), found: toolResultsOf(info?.messages) });
    if (out?.to !== "hand") return null;
    const before = background.started.length;
    await background.call({ title: out.title, brief: out.brief, done_when: out.doneWhen });
    if (background.started.length === before) return null; // no slot, or already running: the draft goes as it is
    // Its start line or the tapback, as a job the model started ends its turn (`background.js` `endsTurn`).
    const line = typeof background.endsTurn === "function" ? background.endsTurn(START_JOB_TOOL, {}) : null;
    return typeof line === "string" && line !== "" ? line : QUIET_ACK;
  };
}
