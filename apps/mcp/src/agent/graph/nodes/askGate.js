/**
 * The Before-asking node, `askGate` (the lookup ladder, `../../lookupLadder.js`; Dev2, 2026-11-20; on the node shelf
 * until a Lab draft wires `answerCheck -> askGate`). The Answer check asks it about a draft it would let go.
 *
 * A draft with no question mark goes on with no model. Otherwise a decision model (the step's own: Clef, Clef Flash or
 * Jev) reads what the draft asks of them. Nothing, an approval or something only they can answer goes on as it is. A
 * fact Tex could find climbs: the first time, rungs 1 to 4 (`rungKnows`, `rungNotes`, `rungTools`, each its own step
 * over this step's `uses` wires, so Replay shows each one and what it found) and a send-back with what they found or
 * which fast rung is untried; with nothing to send back, or a second asking draft after a send-back, the slow rungs go
 * to a background job (`askGate -> handoff`).
 *
 * Output `to`: "pass" (no ask), "bypass" (an ask only they can answer), "back" with the notice, or "job" with why.
 */
import { MAX_DECISION_STATE_CHARS } from "../../decide.js";
import { askRequest, ladderNotice, questionsIn, readAsk, selectorOf, termsOf, untriedFast } from "../../lookupLadder.js";
import { DEFAULT_TIME_ZONE, nowLine, readTimeZone } from "../../localNow.js";
import { routerContextText } from "../../routerContext.js";
import { TRAINING, texConfigOf, texModel, texStep, texTimeoutMs } from "../../texConfig.js";

/** The longest the model may take when the step names no limit. */
const DEFAULT_MS = 2_500;

const within = (read, ms) => {
  let timer;
  return Promise.race([
    Promise.resolve().then(read).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * The step's model, context, time limit and climb bar in this turn's config; Clef, no context, the default limit and
 * no bar when it has none. `limits.climbAt` (a percent) is how sure the model must be of a fact to climb; absent, its
 * choice alone decides, because a decision model's confidence means nothing until it is calibrated on our own labels.
 */
function gateSetup(env) {
  const config = texConfigOf(env);
  const out = { model: "@cf/cloudflare/clef", ctx: [], ms: DEFAULT_MS, climbAt: 0 };
  try {
    const step = texStep("askGate", config);
    if (Array.isArray(step.ctx)) out.ctx = step.ctx;
    out.climbAt = climbBarOf(step);
    if (typeof step.timeoutS === "number" && step.timeoutS > 0) out.ms = step.timeoutS * 1000;
    out.model = texModel("askGate", config);
  } catch {
    // a config with no such step, or a model it names no id for: the defaults so far
  }
  return out;
}

/** A step's `limits.climbAt` as a fraction 0..1; 0 (the choice alone) when it is unset or not a whole percent. */
export function climbBarOf(step) {
  const bar = step?.limits?.climbAt;
  return Number.isInteger(bar) && bar >= 0 && bar <= 100 ? bar / 100 : 0;
}

/**
 * `(state, questions) => { answers, fault }` over the Workers AI binding: the step's model by its id, asked with the
 * selector its id ends in. Unlike `decide.js` `decisionEngine` it keeps why a call failed, so the step's log says it.
 */
export function askEngine(ai, model) {
  if (typeof ai?.run !== "function") return null;
  return async (state, questions) => {
    try {
      const raw = await ai.run(model, { model: selectorOf(model), state: state.slice(0, MAX_DECISION_STATE_CHARS), questions });
      return raw && typeof raw === "object" && raw.answers && typeof raw.answers === "object" ? { answers: raw.answers, fault: null } : { answers: null, fault: "no answers in the reply" };
    } catch (error) {
      return { answers: null, fault: String(error?.message ?? error).slice(0, 200) };
    }
  };
}

/** Whether a helper is wired: `io.use` throws or lacks it when the config has no wire. */
const has = (io, id) => {
  try {
    return id in io.use;
  } catch {
    return false;
  }
};

/**
 * @param {{ ask: string, draft: string }} input their text and the draft the Answer check would let go.
 */
export async function askGateNode(input, io) {
  const t = io?.ctx?.turn ?? {};
  const questions = questionsIn(input?.draft);
  if (questions.length === 0) return { to: "pass", why: "no question in the draft", when: ["clear"] };
  const { model, ctx, ms, climbAt } = gateSetup(t.env);
  const engine = io?.engine ? async (state, questions) => ({ answers: await io.engine(state, questions), fault: null }) : askEngine(t.env?.AI, model);
  if (typeof engine !== "function") return { to: "pass", why: "no decision model here", model, when: ["clear"] };
  const at = Number.isFinite(t.received) ? t.received : Date.now();
  const context = ctx.length > 0 ? routerContextText(ctx, { training: TRAINING, today: nowLine(at, readTimeZone(t?.body?.timeZone) ?? DEFAULT_TIME_ZONE) }) : "";
  const asked = askRequest({ ask: input?.ask, draft: input?.draft, context });
  const started = Date.now();
  const got = await within(() => engine(asked.state, asked.questions), ms);
  const modelMs = Date.now() - started;
  const read = readAsk(got?.answers);
  if (read === null) return { to: "pass", why: got === null ? "the model was not back in time" : got.fault ?? "the model named no kind", model, modelMs, when: ["clear"] };
  const base = { kind: read.kind, sure: read.sure, model, modelMs, questions };
  if (read.kind === "none") return { to: "pass", ...base, when: ["clear"] };
  if (read.kind !== "fact" || read.sure < climbAt) return { to: "bypass", ...base, when: ["bypass"] };
  // A second asking draft after the ladder sent one back: the quick rungs had their go, so the slow ones are a job's.
  if (t.ladderSentBack === true) return { to: "job", why: "still asking after the quick rungs", ...base, when: ["climbOn"] };
  const terms = termsOf(questions);
  const [knows, notes, tools] = await Promise.all([
    has(io, "rungKnows") ? Promise.resolve(io.use.rungKnows({ terms })).catch(() => null) : null,
    has(io, "rungNotes") ? Promise.resolve(io.use.rungNotes({ query: questions.slice(0, 2).join(" "), terms })).catch(() => null) : null,
    has(io, "rungTools") ? Promise.resolve(io.use.rungTools({})).catch(() => null) : null,
  ]);
  const tried = new Set(Array.isArray(tools?.tried) ? tools.tried : []);
  const notice = ladderNotice({
    questions,
    knows: Array.isArray(knows?.found) ? knows.found : [],
    notes: Array.isArray(notes?.found) ? notes.found : [],
    untried: tools === null ? [] : untriedFast(tried),
    failedApps: Array.isArray(tools?.failedApps) ? tools.failedApps : [],
  });
  const climbed = { knows: knows?.found?.length ?? null, notes: notes?.found?.length ?? null, tried: [...tried] };
  if (notice === null) return { to: "job", why: "the quick rungs found nothing and all were tried", ...base, climbed, when: ["climbOn"] };
  t.ladderSentBack = true;
  return { to: "back", notice, ...base, climbed, when: ["tryNext"] };
}
