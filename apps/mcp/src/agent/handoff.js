/**
 * THE FRONT DOOR HANDS A JOB IT COULD NOT FINISH TO A BACKGROUND WORKER (Dev2, 2026-11-18; the Hand-off node,
 * `graph/nodes/handoff.js`). The turn's side of it, asked from either of two moments, each by its own config wire:
 * `answerCheck -> handoff`, at a draft the answer check would send back with no send-back left
 * (`graph/nodes/answerCheck.js`), and `fd -> handoff`, when the front door is two rounds from its bound and still
 * gathering (`turn.js` `roundsOut`; Dev2, 2026-11-18: "wire Hand-off to fire when the Front door runs out of rounds"). The node says
 * whether to hand off and writes the job; this starts it through the turn's own background jobs (`background.js` `call`,
 * so the Job start node's slots and its "already running" check hold), and answers the start tapback for the turn to
 * end on (`QUIET_ACK`), or null when no job started (no slot, or the node kept the draft).
 */
import { QUIET_ACK, START_JOB_TOOL } from "./background.js";

/** The turn's tool results so far, from its messages, oldest first. */
export const toolResultsOf = (messages) => (Array.isArray(messages) ? messages : []).filter((m) => m?.role === "tool").map((m) => ({ name: String(m.name ?? ""), text: typeof m.text === "string" ? m.text : "", ...(m.isError ? { isError: true } : {}) }));

/**
 * The Hand-off node's `limits.routeSure` (a percent) is the router confidence above which a job pick goes to the worker;
 * absent, the doors' ROUTE_AT holds. As a fraction 0..1, or null for a missing node or a value that is not an integer 0..100.
 */
export function routeSureOf(config) {
  try {
    const node = (Array.isArray(config?.nodes) ? config.nodes : []).find((n) => n?.id === "handoff");
    const value = node?.limits?.routeSure;
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value / 100 : null;
  } catch {
    return null;
  }
}

/** Which moment asked, by the wire's source: the front door out of rounds, the router's job (`doorTurn.js`), the lookup ladder's slow rungs (`lookupLadder.js`), or the answer check out of send-backs. */
export const causeOf = (from) => (from === "fd" ? "rounds" : from === "router" ? "route" : from === "askGate" ? "ladder" : "check");

/**
 * `background` is the turn's (`background.js`), `gate(input, from)` fires the Hand-off node over the wire from `from`
 * and answers its output, `ask` is their text. The hook answers what the turn ends on, or null. Once a turn, whichever
 * moment asks first.
 */
export function handoffHook({ background, gate, ask }) {
  if (background === null || typeof background?.call !== "function" || typeof gate !== "function") return null;
  let tried = false;
  return async (draft, info, notice, from = "answerCheck") => {
    if (tried) return null; // once a turn
    tried = true;
    // A node that throws (a draft whose schema predates an input) lets the turn go on as it would unwired.
    const out = await Promise.resolve()
      .then(() => gate({ ask: String(ask ?? ""), draft: String(draft ?? ""), notice: String(notice ?? ""), found: toolResultsOf(info?.messages), cause: causeOf(from) }, from))
      .catch(() => null);
    if (out?.to !== "hand") return null;
    const before = background.started.length;
    await background.call({ title: out.title, brief: out.brief, done_when: out.doneWhen });
    if (background.started.length === before) return null; // no slot, or already running: the draft goes as it is
    // Its start line or the tapback, as a job the model started ends its turn (`background.js` `endsTurn`).
    const line = typeof background.endsTurn === "function" ? background.endsTurn(START_JOB_TOOL, {}) : null;
    return typeof line === "string" && line !== "" ? line : QUIET_ACK;
  };
}
