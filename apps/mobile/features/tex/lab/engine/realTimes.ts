/**
 * Real step times for one of the person's own texts (Dev2, 2026-11-14: "keep it as estimates but make it accurate,
 * but when we play through a real text, show the real time instead of the estimate").
 *
 * Read from what Tex logged for that turn in the person's chat ledger: the reply's `timing` (the Worker's wait, the
 * time before the first model call, each front-door round and each tool call, and the whole reply), the reviewer's
 * `judge` entries, and the `step` entries Tex writes for its other model steps. Each becomes the canvas step it
 * measures; what was not measured keeps its estimate, shown as one.
 */
import type { LabGraph } from "../types";
import { simulate, type Sim } from "./sim";
import { G, lab } from "./state";
import type { RealTimes } from "./measured";

// The measured times and what each step got and gave are read from the ledger alone (`measured.ts`, which the
// gateway's `tex_dev` bundles too); the canvas's own uses of them stay here.
export { momentTurnEntries, realIO, realTimes, roundUsd, withWorkerSteps, type IoLine, type RealTimes } from "./measured";

/**
 * The simulation run on measured times (`simulate(..., real)`), with any measured step it did not place put where it
 * ran: a helper at its logged start from Door steps, else beside the step that uses it; the reply as measured.
 */
export function withReal(sim: Sim, real: RealTimes | null, g?: LabGraph): Sim {
  if (!real) return sim;
  const T = { ...sim.T };
  for (const [id, m] of Object.entries(real.ms)) {
    if (T[id]) continue;
    const user = g?.edges.find((e) => e.mode === "uses" && e.to === id && T[e.from]);
    const start = real.at?.[id] !== undefined && T.door ? T.door.start + real.at[id] : user ? T[user.from].start : 0;
    T[id] = { start, end: start + m, ms: m, usd: 0, calls: real.calls[id] ?? 0, parts: [], lane: user ? T[user.from].lane : "reply" };
  }
  const replyCalls = Object.values(real.calls).reduce((a, n) => a + n, 0);
  // The front door's cost as logged; every other step's as estimated.
  const usd = real.usd !== undefined ? real.usd + Object.entries(T).filter(([id]) => id !== "fd").reduce((a, [, t]) => a + t.usd, 0) : sim.usd;
  return { ...sim, T, reply: real.reply, replyCalls, usd, real: new Set(Object.keys(real.ms)) };
}

/**
 * Only what ran (Dev2, 2026-11-14: "If the step never ran, then why is it logged as running? ... Are you telling me
 * that the replay is false?"): in Replay, a step the turn's log does not show is not drawn at all, never filled in
 * with the Lab's estimate. What started it (a text, a check-in) stays, as the log's own first line.
 */
export function onlyWhatRan(sim: Sim, g: LabGraph = G()): Sim {
  if (!sim.real) return sim;
  const T = Object.fromEntries(Object.entries(sim.T).filter(([id]) => sim.real!.has(id) || g.nodes.find((n) => n.id === id)?.kind === "input"));
  return { ...sim, T };
}

/** The real times of the text the canvas traces, when it is one the person sent. */
export const tracedReal = (): RealTimes | null => (lab.scn === "own" && lab.real?.text === lab.ownText ? lab.real.times : null);

/** The canvas's simulation of the traced moment: estimates, or the measured run of a real text. */
export function labSim(g: LabGraph = G()): Sim {
  const real = tracedReal();
  const sim = withReal(simulate(g, lab.scn, lab.logRows, real), real, g);
  return lab.mode === "replay" ? onlyWhatRan(sim, g) : sim;
}
