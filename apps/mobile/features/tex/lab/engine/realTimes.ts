/**
 * Real step times for one of the person's own texts (Dev2, 2026-11-14: "keep it as estimates but make it accurate,
 * but when we play through a real text, show the real time instead of the estimate").
 *
 * Read from what Tex logged for that turn in the person's chat ledger: the reply's `timing` (the Worker's wait, the
 * time before the first model call, each front-door round and each tool call, and the whole reply), the reviewer's
 * `judge` entries, and the `step` entries Tex writes for its other model steps. Each becomes the canvas step it
 * measures; what was not measured keeps its estimate, shown as one.
 */
import type { LedgerEntry } from "../../page/texPageTypes";
import type { Sim } from "./sim";

export type RealTimes = {
  /** What the person waited: the Worker's wait plus the gateway's reply. */
  reply: number;
  /** Milliseconds per canvas step id, and how many model calls each made. */
  ms: Record<string, number>;
  calls: Record<string, number>;
};

/** `step` names that are canvas steps of the same id. */
const STEP_NODES = new Set(["decide", "router", "fallback", "card", "classifier", "selfreview", "handback", "mailadv"]);

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The measured times of one turn, or null when its reply kept no timing. */
export function realTimes(entries: LedgerEntry[], turn: string | null): RealTimes | null {
  if (!turn) return null;
  const mine = entries.filter((e) => e.turn === turn);
  const timing = rec(mine.find((e) => e.kind === "reply" && rec(e.timing))?.timing);
  const replyMs = num(timing?.replyMs);
  if (!timing || replyMs === null) return null;
  const ms: Record<string, number> = {};
  const calls: Record<string, number> = {};
  const add = (id: string, t: number, n = 0) => {
    ms[id] = (ms[id] ?? 0) + t;
    if (n) calls[id] = (calls[id] ?? 0) + n;
  };
  const wait = num(timing.waitMs) ?? 0;
  if (wait) add("lanes", wait);
  const rounds = (Array.isArray(timing.rounds) ? timing.rounds : []).map(rec).filter((r): r is Record<string, unknown> => r !== null && num(r.ms) !== null);
  if (rounds.length) {
    add("door", num(rounds[0].at) ?? 0);
    for (const r of rounds) add("fd", num(r.ms)!, 1);
  }
  for (const t of Array.isArray(timing.tools) ? timing.tools : []) {
    const m = num(rec(t)?.ms);
    if (m !== null) add("tools", m);
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
  return { reply: wait + replyMs, ms, calls };
}

/** The simulation with each measured step's time put in, and the reply as measured. */
export function withReal(sim: Sim, real: RealTimes | null): Sim {
  if (!real) return sim;
  const T = { ...sim.T };
  for (const [id, m] of Object.entries(real.ms)) {
    const was = T[id];
    T[id] = was ? { ...was, ms: m, calls: real.calls[id] ?? 0 } : { start: 0, end: m, ms: m, usd: 0, calls: real.calls[id] ?? 0, parts: [], lane: "reply" };
  }
  const replyCalls = Object.values(real.calls).reduce((a, n) => a + n, 0);
  return { ...sim, T, reply: real.reply, replyCalls, real: new Set(Object.keys(real.ms)) };
}
