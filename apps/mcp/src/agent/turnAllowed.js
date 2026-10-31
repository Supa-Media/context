/**
 * MAY THIS TURN SPEND THE BUILT-IN MODEL? ASKED BESIDE THE TURN, NOT BEFORE IT.
 *
 * The control plane's answer (`openProvider`, `/gateway/builtin-model`)
 * decides and counts the turn. It is almost always yes, and it used to be
 * awaited before anything else the turn did: on 2026-10-31 it took 9.7 s of a
 * one-to-one text whose model took 3 s (normally 0.2 s). So it is now asked
 * when the turn starts and awaited only where a "no" would matter:
 *
 * - before a voice message is sent to be transcribed (that costs us);
 * - before each model call while it is still unknown, if it has already come
 *   back no (`runTurn`), so a refused turn spends nothing it can avoid;
 * - beside the first model round, which races it: a no ends the turn at once,
 *   and a yes is waited for before anything the round said is acted on — no
 *   tool runs, no answer is checked or returned, before the yes.
 *
 * What a refused turn may already have spent: a model round it never shows
 * anyone, and the reads before it. It never runs a tool, texts anybody, or
 * keeps a word of the model's.
 */
import { json } from "../http/responses.js";

/**
 * What a turn that may not run says. Nothing in the app can change this any
 * more (people's own model keys were deleted, the owner, 2026-10-10): the
 * built-in model answers texts and routines where the control plane allows
 * it, and every other `no_provider` — another client, another plan, the
 * assistant switched off, a deployment with no built-in model, a request
 * naming a provider — is the same sentence, so none of them is told apart
 * from the outside.
 */
const NO_MODEL_HERE = "The assistant isn't available here yet.";

/**
 * The control plane's answer, started now. `refusal` is set the moment it is
 * known to be no; `wait` resolves on yes and rejects with the refusal. Never
 * an unhandled rejection: a turn that returns before awaiting it leaves none.
 *
 * @param {Promise<unknown>} check `openProvider(...)`, already started
 * @param {() => number} [now]
 */
export function allowedBeside(check, now = Date.now) {
  const started = now();
  // `heldMs`: how long a model's reply waited on the answer, the time this file still costs a turn.
  const gate = { refusal: null, settled: false, ms: null, heldMs: 0, wait: null, now };
  gate.wait = Promise.resolve(check).then(
    () => {
      gate.settled = true;
      gate.ms = now() - started;
    },
    (error) => {
      gate.settled = true;
      gate.ms = now() - started;
      gate.refusal = error ?? new Error("refused");
      throw gate.refusal;
    },
  );
  gate.wait.catch(() => {});
  return gate;
}

/**
 * A model call beside the answer (`runTurn`): it resolves with the model's
 * reply only once the answer is yes, and rejects with the refusal the moment
 * the answer is no, without waiting for the model. A model that failed first
 * fails as it would have (the fallback runs beside the answer in turn).
 */
export function besideAllowed(gate, request) {
  if (gate === null || gate === undefined || (gate.settled && gate.refusal === null)) return request;
  if (gate.refusal !== null) {
    Promise.resolve(request).catch(() => {});
    return Promise.reject(gate.refusal);
  }
  let replied = null;
  const timed = Promise.resolve(request).then((reply) => ((replied = gate.now()), reply));
  return Promise.all([timed, gate.wait]).then(([reply]) => {
    if (replied !== null) gate.heldMs += Math.max(0, gate.now() - replied);
    return reply;
  });
}

/** Whether this error is the gate's own refusal, rather than anything else the turn threw. */
export function isRefusal(gate, error) {
  return gate !== null && gate !== undefined && gate.refusal !== null && error === gate.refusal;
}

/**
 * The response a refused turn gets. A control plane that could not be
 * reached is not a refusal, and telling somebody the assistant is not theirs
 * when it is is worse than telling them nothing.
 */
export function refusedResponse(error) {
  // `AgentRefusal` (`turn.js`), by name: `turn.js` imports this file, so this one does not import it back.
  const refusal = error?.name === "AgentRefusal" && typeof error.code === "string";
  if (refusal && error.code === "daily_limit") {
    return json({ error: "daily_limit", error_description: "That's all the questions for today. Ask me again tomorrow." }, 429);
  }
  if (refusal) return json({ error: error.code, error_description: NO_MODEL_HERE }, 409);
  return json({ error: "model_unavailable" }, 503);
}
