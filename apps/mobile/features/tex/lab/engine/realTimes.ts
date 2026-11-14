/**
 * Real step times for one of the person's own texts (Dev2, 2026-11-14: "keep it as estimates but make it accurate,
 * but when we play through a real text, show the real time instead of the estimate").
 *
 * Read from what Tex logged for that turn in the person's chat ledger: the reply's `timing` (the Worker's wait, the
 * time before the first model call, each front-door round and each tool call, and the whole reply), the reviewer's
 * `judge` entries, and the `step` entries Tex writes for its other model steps. Each becomes the canvas step it
 * measures; what was not measured keeps its estimate, shown as one.
 */
import { BASE_MODELS } from "../data/models";
import type { LedgerEntry } from "../../page/texPageTypes";
import type { LabGraph } from "../types";
import { simulate, type Sim } from "./sim";
import { G, lab } from "./state";
import { momentAsSteps, STEP_NODES, stepIO, type IoLine } from "./stepIO";

export type RealTimes = {
  /** What the person waited: the Worker's wait plus the gateway's reply. */
  reply: number;
  /** Milliseconds per canvas step id, and how many model calls each made. */
  ms: Record<string, number>;
  calls: Record<string, number>;
  /** When a helper first ran, in ms from the gateway's start of the turn (Door steps' start): tool calls. */
  at?: Record<string, number>;
  /** What the front door's rounds really cost, from their logged token counts at each model's price; absent when none were logged. */
  usd?: number;
};

/**
 * One model round's cost from its logged tokens (`timing.rounds`: input, output, cacheRead, cacheWrite) at the Lab's
 * model prices per million tokens; plain input is priced as a cache write without the write's 25%.
 */
export function roundUsd(r: Record<string, unknown>): number {
  const m = Object.values(BASE_MODELS).find((x) => x.id === r.model);
  if (!m || m.cacheW === undefined) return 0;
  const n = (k: string) => num(r[k]) ?? 0;
  return (n("input") * (m.cacheW / 1.25) + n("cacheRead") * (m.cacheR ?? 0) + n("cacheWrite") * m.cacheW + n("output") * (m.outP ?? 0)) / 1e6;
}


const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The measured times of one turn, or null when its reply kept no timing. */
export function realTimes(entries: LedgerEntry[], turn: string | null): RealTimes | null {
  if (!turn) return null;
  const mine = entries.filter((e) => e.turn === turn);
  const timing = rec(mine.find((e) => e.kind === "reply" && rec(e.timing))?.timing);
  const replyMs = num(timing?.replyMs);
  const ms: Record<string, number> = {};
  const calls: Record<string, number> = {};
  const add = (id: string, t: number, n = 0) => {
    ms[id] = (ms[id] ?? 0) + t;
    if (n) calls[id] = (calls[id] ?? 0) + n;
  };
  if (!timing || replyMs === null) return untimed(mine, add, ms, calls);
  const wait = num(timing.waitMs) ?? 0;
  if (wait) add("lanes", wait);
  const rounds = (Array.isArray(timing.rounds) ? timing.rounds : []).map(rec).filter((r): r is Record<string, unknown> => r !== null && num(r.ms) !== null);
  if (rounds.length) {
    add("door", num(rounds[0].at) ?? 0);
    for (const r of rounds) add("fd", num(r.ms)!, 1);
  }
  const usd = rounds.some((r) => r.model) ? rounds.reduce((a, r) => a + roundUsd(r), 0) : undefined;
  const at: Record<string, number> = {};
  for (const t of Array.isArray(timing.tools) ? timing.tools : []) {
    const m = num(rec(t)?.ms);
    if (m === null) continue;
    add("tools", m);
    const when = num(rec(t)?.at);
    if (when !== null && at.tools === undefined) at.tools = when;
  }
  for (const e of mine) {
    const m = num(e.ms);
    if (m === null) continue;
    if (e.kind === "judge" && e.by === "review") add("reviewer", m, 1);
    else if (e.kind === "step" && typeof e.step === "string" && STEP_NODES.has(e.step)) add(e.step, m, 1);
  }
  // The rest of the reply (the code checks, the send) is what the steps above do not account for.
  const counted = ["door", "fd", "tools", "reviewer"].reduce((a, id) => a + (ms[id] ?? 0), 0);
  add("send", Math.max(0, replyMs - counted));
  return { reply: wait + replyMs, ms, calls, ...(Object.keys(at).length ? { at } : {}), ...(usd !== undefined ? { usd } : {}) };
}

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

/** The real times of the text the canvas traces, when it is one the person sent. */
export const tracedReal = (): RealTimes | null => (lab.scn === "own" && lab.real?.text === lab.ownText ? lab.real.times : null);

/** The canvas's simulation of the traced moment: estimates, or the measured run of a real text. */
export function labSim(g: LabGraph = G()): Sim {
  const real = tracedReal();
  return withReal(simulate(g, lab.scn, lab.logRows, real), real, g);
}

/**
 * The texting Worker's own steps (its `decide` judgings and `react` tapbacks) are logged with no turn, shaped
 * `{step: {name, of, ok, ms, input, output}}`. Those logged between `from` and `to` (epoch ms) are given to `turn`, in
 * the gateway's step shape, so its times and the panel read them like any other step.
 */
export function withWorkerSteps(entries: LedgerEntry[], turn: string, from: number, to: number): LedgerEntry[] {
  const out = entries.filter((e) => !(e.kind === "step" && rec(e.step)));
  // A group's judgings, kept by the gateway as `judge` entries `by: "moment"`, are its Decide (and React) too.
  for (const e of entries) if (e.kind === "judge" && e.by === "moment" && !e.turn && e.at >= from && e.at <= to) out.push(...momentAsSteps(e, turn));
  for (const e of entries) {
    const st = rec(e.step);
    if (e.kind !== "step" || !st || typeof st.name !== "string" || e.turn || e.at < from || e.at > to) continue;
    out.push({ ...e, turn, step: st.name, ok: st.ok !== false, ...(num(st.ms) !== null ? { ms: num(st.ms)! } : {}), input: st.input, output: st.output, ...(typeof st.of === "string" ? { of: st.of } : {}) } as LedgerEntry);
  }
  return out;
}

/**
 * A turn whose reply kept no timing (a routine's run, a check-in's look): its times from its own entries, each
 * thinking a front-door round, each tool call, each review, each step; the whole from its first entry to its last.
 */
function untimed(mine: LedgerEntry[], add: (id: string, t: number, n?: number) => void, ms: Record<string, number>, calls: Record<string, number>): RealTimes | null {
  if (!mine.length) return null;
  for (const e of mine) {
    const m = num(e.ms);
    if (m === null) continue;
    if (e.kind === "thinking") add("fd", m, 1);
    else if (e.kind === "tool") add("tools", m);
    else if (e.kind === "judge" && e.by === "review") add("reviewer", m, 1);
    else if (e.kind === "step" && typeof e.step === "string" && STEP_NODES.has(e.step)) add(e.step, m, 1);
  }
  if (!Object.keys(ms).length) return null;
  const first = Math.min(...mine.map((e) => e.at - (num(e.ms) ?? 0)));
  const last = Math.max(...mine.map((e) => e.at));
  return { reply: Math.max(0, last - first), ms, calls };
}

export type { IoLine } from "./stepIO";

/**
 * What each step got and gave in one real turn, from the same ledger entries as its times (Dev2, 2026-11-14: "when a
 * node is highlighted, I cant see what the inputs or outputs are, It should show up in the right panel"). Only the
 * person's own chats are read, and only into this tab. `stepIO.ts` reads each step.
 */
export function realIO(entries: LedgerEntry[], turn: string | null, text: string, answer: string, startedBy?: string): Record<string, IoLine[]> {
  return stepIO(entries, turn, text, answer, startedBy);
}
