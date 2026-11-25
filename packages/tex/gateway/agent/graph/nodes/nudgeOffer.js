/**
 * The Nudge node, `nudgeOffer` (Dev and Seyi, 2026-11-24: "create a node for it so we can easily debug ... good tracing
 * and observability so that we can track retention rate amongst users and why"). Wired `finish -> nudgeOffer`, mode
 * `uses`: Finish the text asks it, after its own work on the words, whether one offer line goes after the answer.
 *
 * It is its own step, not part of Check-in: a check-in looks three times a day with nobody texting, while a nudge rides
 * on the reply to what the person just texted. The habit, its gates, its record and its points are `../../nudges.js`.
 *
 * Off on main (today's behaviour: no nudges). Turned on in a Lab draft it decides and, with Add the line on, Finish adds
 * the line; with Add the line off it decides, keeps and counts exactly the same, and nothing is added (a shadow run).
 *
 * Its row in the chat's record says `to` (offer, none or skip), the gate that skipped it, the capability and the line,
 * the model's reason, how the person answered the last offer, and whether the line was sent. Never throws: a nudge
 * that fails is no line, and the answer goes as it was.
 */
import { aiGatewayConfig } from "../../aiGateway.js";
import { settingsOf, texConfigOf, texEffort, texModel, texStep } from "../../texConfig.js";
import { DEFAULT_MODEL, DEFAULT_MS, GATES, MAX_KEPT, askNudge, checkedVerdict, freshState, gateOf, nudgePoints, nudgeQuestion, nudgeRecord, parseState, pendingOffer, settlePending, writePoints } from "../../nudges.js";

/** The step's model, effort and time limit in this config; the defaults when the config has no such step. */
function setupOf(env) {
  const config = texConfigOf(env);
  const out = { model: DEFAULT_MODEL, effort: "low", ms: DEFAULT_MS };
  try {
    const step = texStep("nudgeOffer", config);
    out.model = texModel("nudgeOffer", config);
    out.effort = texEffort("nudgeOffer", config).effort ?? "low";
    if (typeof step.timeoutS === "number" && step.timeoutS > 0) out.ms = step.timeoutS * 1000;
  } catch {
    // a config with no such step: the defaults
  }
  return out;
}

/** Which gate holds before the record is read: not a 1:1 text, nothing texted, or an answer that already asks. */
export function turnGate(t) {
  const oneToOne = t?.chatTurn === true && t.group === null && t.job === null && t.report === null && (t.routine ?? null) === null && !t.runner && !t.crossChat && typeof t.finishCheckIn !== "function";
  if (!oneToOne) return "not1to1";
  const f = t.finished;
  if (!f || f.silent || f.quiet || f.hushed || f.crossAskRun || String(f.answer ?? "").trim() === "") return "silent";
  if ((t.ledger?.asked?.length ?? 0) > 0 || t.ledger?.offered || f.offerText || /\?\s*$/.test(String(f.answer).trim())) return "asking";
  return null;
}

/** The last few lines of the chat; Tex's own are left out when this turn may repeat a stranger's words. */
const recentOf = (history, tainted) => (Array.isArray(history) ? history : []).slice(-4).filter((turn) => !tainted || turn?.role !== "assistant").map((turn) => `${turn?.role === "assistant" ? "Tex" : "Them"}: ${String(turn?.text ?? "").slice(0, 400)}`);

/**
 * @param {{ chars?: number }} input the finished answer's length (logged).
 * The turn comes in `io.ctx.turn`, never in the logged input.
 * @returns {Promise<object>} the row: `to` offer | none | skip, and why.
 */
export default async function nudgeOffer(_input, io) {
  const t = io?.ctx?.turn ?? {};
  const env = t.env ?? io?.ctx?.env ?? null;
  const now = Number.isFinite(io?.ctx?.now) ? io.ctx.now : Date.now();
  const settings = settingsOf(env, "nudgeOffer");
  const sent = settings.addLine === true;
  const workspace = t.session?.workspaceId ?? null;
  const dataset = env?.TEX_NUDGES;

  const early = turnGate(t);
  // A group, a job or a check-in is no 1:1 turn: nothing is read, kept or counted.
  if (early === "not1to1") return { to: "skip", gate: early, why: GATES[early] };

  const record = nudgeRecord(env, t.store, t.session);
  if (record === null) return { to: "skip", gate: "noStore", why: GATES.noStore };
  let state;
  try {
    const text = await record.get();
    state = text === null ? freshState(now) : parseState(text, now);
  } catch {
    state = freshState(now);
  }
  state.texts += 1;

  const pending = pendingOffer(state);
  const gate = early ?? gateOf(state, now, settings);
  const offerOpen = gate === null;
  let verdict = { offer: false, why: gate ? GATES[gate] : "", lastOffer: null };
  let asked = null;
  // The model is asked when an offer may be made, or to read their answer to the last one.
  if (offerOpen || pending) {
    asked = await askNudge(
      nudgeQuestion({ question: t.question, answer: t.finished?.answer, recent: recentOf(t.history, t.ledger?.untrusted === true), tainted: t.ledger?.untrusted === true, offered: state.offers, pending, offerOpen }),
      io?.ctx?.gateway ?? aiGatewayConfig(env),
      { ...setupOf(env), fetchImpl: io?.ctx?.fetchImpl, now: () => (Number.isFinite(io?.ctx?.now) ? now : Date.now()) },
    );
    const checked = checkedVerdict(asked.args, state);
    verdict = offerOpen ? checked : { ...checked, offer: false, why: verdict.why };
    if (asked.args === null) verdict.why = asked.why ?? verdict.why;
  }

  const settled = settlePending(pending, verdict.lastOffer, now);
  if (verdict.offer) {
    state.offers.push({ capability: verdict.capability, line: verdict.line, at: now, outcome: sent ? "pending" : "shadow", ...(sent ? {} : { shadow: true }) });
    state.offers = state.offers.slice(-MAX_KEPT);
  }
  try {
    await record.put(JSON.stringify(state));
  } catch {
    // a record that could not be kept costs one offer's memory, never the reply
  }

  const to = verdict.offer ? "offer" : gate ? "skip" : "none";
  writePoints(dataset, nudgePoints({
    workspace,
    event: to,
    capability: verdict.offer ? verdict.capability : "",
    detail: gate ?? "",
    sent,
    state,
    now,
    modelMs: asked?.modelMs ?? 0,
    outcome: settled ? { capability: pending.capability, said: settled, shadow: false } : null,
  }));

  return {
    to,
    sent: verdict.offer && sent,
    texts: state.texts,
    ...(gate ? { gate } : {}),
    ...(verdict.offer ? { capability: verdict.capability, line: verdict.line } : {}),
    ...(verdict.why ? { why: verdict.why } : {}),
    ...(settled ? { answered: { capability: pending.capability, said: settled } } : pending ? { waiting: pending.capability } : {}),
    ...(asked?.model ? { model: asked.model } : {}),
    ...(Number.isFinite(asked?.modelMs) ? { modelMs: asked.modelMs } : {}),
  };
}
