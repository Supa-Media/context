/**
 * Still answers them? node, `recheck` (config wire `send -> recheck`, uses; Dev2, 2026-11-23: the no-shadow steps,
 * `docs/decisions/texting-assistant/no-shadow-steps.md`). A group reply that waited behind newer messages is asked once
 * more whether it still answers them, before the Worker sends it (`apps/agent/src/lookAgain.ts`, `groupRecheck.ts`).
 *
 * The Worker asks the gateway at `/texts/recheck` (`textsDecide.js`), which runs this: Clef answers the typed questions
 * of `recheckRequest`, and the reading is `readRecheckAnswers`. A model that does not answer is `unavailable`, and the
 * Worker sends the reply as it is. Turned off in a config, `textsDecide.js` answers "fits" without calling it.
 */
import { readRecheckAnswers, recheckRequest } from "../../../../src/textDecide.cjs";

/**
 * Whether the config runs this step: a config without it runs it, as before it had a node; one that draws it runs it
 * only when it is on and send -> recheck is wired to it (`scripts/tex-wire-check.mjs` OUTSIDE_CALLS).
 */
export const recheckOn = (config) => {
  const node = (config?.nodes ?? []).find((n) => n?.id === "recheck");
  return node === undefined || (node.on !== false && (config?.edges ?? []).some((e) => e.from === "send" && e.to === "recheck"));
};

/**
 * @param {object} body The Worker's recheck body (`readRecheckBody`).
 * @param {{ engine: (state: string, questions: object) => Promise<object|null> }} deps Clef, as Decide asks it.
 * @returns {Promise<{ result: object, answered: boolean, questions: number, chars: number, ms: number }>}
 */
export async function recheckNode(body, { engine } = {}) {
  const asked = recheckRequest(body);
  const started = Date.now();
  const answers = typeof engine === "function" ? await engine(asked.state, asked.questions) : null;
  return {
    result: answers === null ? { ok: false, reason: "unavailable", cause: "model_failed" } : readRecheckAnswers(answers),
    answered: answers !== null,
    questions: Object.keys(asked.questions).length,
    chars: asked.state.length + JSON.stringify(asked.questions).length,
    ms: Date.now() - started,
  };
}
