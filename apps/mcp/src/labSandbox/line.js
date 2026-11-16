/**
 * THE TEST CHAT'S PHONE LINE (Dev2, 2026-11-16: "by default wire/pretend it's a Photon iMessage thing so it should
 * simulate default latency on that and text should arrive on the new number (+1 415 791-8922)"; decision
 * `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * A test text is held for the line's delay in before it reaches the chat object ("A text arrives"), and each text Tex
 * sends is held for the line's delay out after Text them before it shows as delivered. Both holds are steps of their
 * own (`lineIn`, `lineOut`, kind `line`): the simulated line is the sandbox's transport, not Tex, so they are no nodes
 * of `texConfig.json`, and `scripts/tex-diagram-check.mjs` checks they never become one by accident.
 *
 * The delay is the median (p50) of real Photon deliveries: a chat's own `text` steps (the provider's lag on the way
 * in, `stepEvents.ts` `textStep`) and `send` steps that reached `delivered` (its lag on the way out, `sendStep`), as
 * the texting Worker logs them on every text and send (#3318). There is no aggregate of those across chats, so a test
 * chat measures its own: `measuredLine` over the real chat's logged steps, read once at open. A chat with too few Photon
 * deliveries logged gets `PHOTON_DEFAULT`, a fixed default that is not a measurement (said on the `line` it answers).
 */

/** Tex's new number, where a test text arrives: a public business line, not a secret. */
export const PHOTON_NUMBER = "+14157918922";
/**
 * The delays a chat with too few logged Photon deliveries gets. NOT MEASURED: no aggregate of Photon's lag exists to
 * read from here, so these are a stand-in until one does; `measured: false` says so on every `line`.
 */
export const PHOTON_DEFAULT = Object.freeze({ inMs: 1_500, outMs: 2_000 });
/** Fewer logged deliveries than this, one way, and that way's default is used. */
export const MIN_SAMPLES = 5;
/** The longest hold a line keeps, whatever was measured: a test text never waits more than this either way. */
export const MAX_HOLD_MS = 30_000;

/** The median of a list of numbers, rounded; null for none. */
export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = sorted.length >> 1;
  return Math.round(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** A logged step's Photon lag: the way in (`text`) or the way out (`send`, delivered), or null. */
function lagOf(entry) {
  if (entry?.kind !== "step") return null;
  if (entry.step === "text" && entry.input?.provider?.name === "photon" && Number.isFinite(entry.input.provider.lagMs)) return { way: "in", ms: entry.input.provider.lagMs };
  if (entry.step === "send" && entry.output?.name === "photon" && entry.output?.status === "delivered" && Number.isFinite(entry.output.lagMs)) return { way: "out", ms: entry.output.lagMs };
  return null;
}

/**
 * The line a test chat's texts use: Photon, its delays the p50 of the real chat's logged Photon deliveries (`entries`,
 * its ledger's `step` entries), each way on its own, the default for a way with fewer than `MIN_SAMPLES`.
 */
export function measuredLine(entries = []) {
  const ins = [];
  const outs = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const lag = lagOf(entry);
    if (lag !== null) (lag.way === "in" ? ins : outs).push(lag.ms);
  }
  const inMs = ins.length >= MIN_SAMPLES ? median(ins) : null;
  const outMs = outs.length >= MIN_SAMPLES ? median(outs) : null;
  return {
    name: "photon",
    number: PHOTON_NUMBER,
    inMs: Math.min(MAX_HOLD_MS, inMs ?? PHOTON_DEFAULT.inMs),
    outMs: Math.min(MAX_HOLD_MS, outMs ?? PHOTON_DEFAULT.outMs),
    measured: { in: inMs === null ? 0 : ins.length, out: outMs === null ? 0 : outs.length },
  };
}

/** The line a test chat opened with, or the default Photon line for one opened before lines were kept. */
export function lineOf(about) {
  const line = about?.line;
  if (line && typeof line === "object" && line.name === "photon" && Number.isFinite(line.inMs) && Number.isFinite(line.outMs)) return line;
  return measuredLine([]);
}

/** The `line` a row carries: its name and the holds (`outMs` on a Tex text only). */
export function rowLine(line, { out = false } = {}) {
  return { name: line.name, inMs: line.inMs, ...(out ? { outMs: line.outMs } : {}) };
}

/** Wait `ms`, as the line holds a text. */
export const hold = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(MAX_HOLD_MS, ms))));
