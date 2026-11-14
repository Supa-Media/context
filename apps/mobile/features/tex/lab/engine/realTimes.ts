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
import type { LabGraph } from "../types";
import { simulate, type Sim } from "./sim";
import { G, lab } from "./state";

export type RealTimes = {
  /** What the person waited: the Worker's wait plus the gateway's reply. */
  reply: number;
  /** Milliseconds per canvas step id, and how many model calls each made. */
  ms: Record<string, number>;
  calls: Record<string, number>;
  /** When a helper first ran, in ms from the gateway's start of the turn (Door steps' start): tool calls. */
  at?: Record<string, number>;
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
  return { reply: wait + replyMs, ms, calls, ...(Object.keys(at).length ? { at } : {}) };
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
  return { ...sim, T, reply: real.reply, replyCalls, real: new Set(Object.keys(real.ms)) };
}

/** The real times of the text the canvas traces, when it is one the person sent. */
export const tracedReal = (): RealTimes | null => (lab.scn === "own" && lab.real?.text === lab.ownText ? lab.real.times : null);

/** The canvas's simulation of the traced moment: estimates, or the measured run of a real text. */
export function labSim(g: LabGraph = G()): Sim {
  const real = tracedReal();
  return withReal(simulate(g, lab.scn, lab.logRows, real), real, g);
}

/** One thing a step got or gave in a real run, as the panel lists it. */
export type IoLine = { k: string; v: string };

const CUT = 1200;
const show = (v: unknown): string => {
  const t = typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 1);
  return t.length > CUT ? t.slice(0, CUT) + "…" : t;
};

/**
 * What each step got and gave in one real turn, from the same ledger entries as its times (Dev2, 2026-11-14: "when a
 * node is highlighted, I cant see what the inputs or outputs are, It should show up in the right panel"). Only the
 * person's own chat is read, and only into this tab.
 */
export function realIO(entries: LedgerEntry[], turn: string | null, text: string, answer: string): Record<string, IoLine[]> {
  const io: Record<string, IoLine[]> = { text: [{ k: "Your text", v: text }] };
  const push = (id: string, k: string, v: unknown) => {
    const s = show(v);
    if (s.trim()) (io[id] ??= []).push({ k, v: s });
  };
  push("fd", "Got", text);
  const mine = turn ? [...entries].filter((e) => e.turn === turn).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at - b.at) : [];
  let round = 0;
  for (const e of mine) {
    if (e.kind === "thinking") push("fd", "Thought", e.text);
    else if (e.kind === "said") push("fd", "Said", e.text);
    else if (e.kind === "tool") push("tools", String(e.name ?? "tool") + (num(e.ms) !== null ? ` · ${num(e.ms)} ms` : ""), [show(e.args), e.result !== undefined ? "→ " + show(e.result) : ""].filter(Boolean).join("\n"));
    else if (e.kind === "judge" && e.by === "review") {
      round += 1;
      push("reviewer", `Round ${round}: ${e.went ? "let it go" : "sent it back"}`, [e.text ? "Draft: " + show(e.text) : "", e.notice ?? e.reason ?? ""].filter(Boolean).join("\n"));
    } else if (e.kind === "step" && typeof e.step === "string" && STEP_NODES.has(e.step)) {
      push(e.step, "Got", e.input);
      push(e.step, "Gave", e.output ?? (e.reason ? { reason: e.reason } : undefined));
    }
  }
  push("fd", "Answer", answer);
  push("send", "Sent", answer);
  return io;
}
