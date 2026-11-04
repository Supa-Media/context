/**
 * WHERE ONE TURN'S TIME WENT, KEPT WITH ITS REPLY (Dev, 2026-11-03: "I need
 * to be able to look at an interaction with Tex and tell exactly why things
 * might be slow").
 *
 * Analytics Engine has every step of every turn (`texTiming.js`,
 * `turnStages.js`), but only an account token can read it, and the chat's
 * history held only each tool's milliseconds and the reply's total. So the
 * reply entry in the chat's ledger carries this block: the wait before the
 * gateway, each named step the turn took, the router, each model round with
 * its tokens, and each tool, every one with when it started (`at`, from the
 * moment the gateway read the text) and how long it took (`ms`). The bubbles
 * that went out are the chat's own `text` entries, with their times.
 *
 * Names, counts and times only, never a word: a tool's arguments and result
 * stay in its own entry. Capped, so a long job's turn cannot grow its reply.
 */

export const TIMING_VERSION = 1;
const MAX_STEPS = 60;
const MAX_ROUNDS = 40;
const MAX_TOOLS = 80;

/**
 * Inside `waitMs`, what the texting Worker said its own wait was: the
 * control plane's session lookup and its work between that and asking
 * (Dev, 2026-11-04: "why are we waiting 0.9s in the texting worker?").
 * Numbers only, each capped at the wait itself's sanity bound; anything else
 * the Worker sent is dropped.
 */
const MAX_WORKER_MS = 10 * 60 * 1000;
function workerPart(worker) {
  if (worker === null || typeof worker !== "object") return {};
  const ms = (value) => (Number.isFinite(value) && value >= 0 && value <= MAX_WORKER_MS ? Math.round(value) : null);
  const sessionMs = ms(worker.sessionMs), beforeAskMs = ms(worker.beforeAskMs);
  if (sessionMs === null && beforeAskMs === null) return {};
  return { worker: { ...(sessionMs === null ? {} : { sessionMs }), ...(beforeAskMs === null ? {} : { beforeAskMs }) } };
}

const whole = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
const name = (value) => String(value ?? "").slice(0, 64);

/**
 * @param {{
 *   steps?: Array<{ name: string, at: number, ms: number, state?: string }>,
 *   trace?: Array<object>,
 *   waitMs?: number | null,
 *   worker?: unknown,
 *   replyMs: number,
 * }} turn `steps`: the entry point's (`tex.steps`); `trace`: the model loop's (`turn.js`), each `at` from the loop's start
 */
export function turnTiming({ steps = [], trace = [], waitMs = null, worker = null, replyMs }) {
  const kept = (Array.isArray(steps) ? steps : []).filter((step) => typeof step?.name === "string" && !step.name.startsWith("after:") && step.name !== "to_response");
  // The model loop's own clock starts with the `model` step: its offsets are moved onto the turn's.
  const model = kept.find((step) => step.name === "model");
  const loopAt = whole(model?.at);
  const timing = {
    v: TIMING_VERSION,
    ...(Number.isFinite(waitMs) && waitMs >= 0 ? { waitMs: Math.round(waitMs) } : {}),
    ...workerPart(worker),
    replyMs: whole(replyMs),
    steps: kept.slice(0, MAX_STEPS).map((step) => ({ name: name(step.name), at: whole(step.at), ms: whole(step.ms), ...(step.state && step.state !== "ok" ? { state: name(step.state) } : {}) })),
    rounds: [],
    tools: [],
  };
  for (const entry of Array.isArray(trace) ? trace : []) {
    const at = loopAt + whole(entry?.at);
    const ms = whole(entry?.ms);
    if (entry?.kind === "router") timing.router = { at, ms, ...(typeof entry.model === "string" ? { model: name(entry.model) } : {}) };
    else if (entry?.kind === "tool" && timing.tools.length < MAX_TOOLS) timing.tools.push({ at, ms, name: name(entry.tool), ...(entry.ok === false ? { ok: false } : {}), ...(entry.held ? { held: true } : {}) });
    else if ((entry?.kind === "model" || entry?.kind === "fallback") && timing.rounds.length < MAX_ROUNDS) {
      const usage = entry.usage ?? {};
      timing.rounds.push({
        at,
        ms,
        ...(typeof entry.model === "string" ? { model: name(entry.model) } : {}),
        ...(entry.kind === "fallback" ? { fallback: true } : {}),
        ...(entry.ok === false ? { ok: false } : {}),
        ...(entry.retried ? { retried: true } : {}),
        ...(entry.cut ? { cut: true } : {}),
        ...(entry.usage ? { input: whole(usage.input), output: whole(usage.output), cacheRead: whole(usage.cacheRead), cacheWrite: whole(usage.cacheWrite), said: whole(entry.said), calls: whole(entry.calls) } : {}),
      });
    }
  }
  return timing;
}
