/**
 * What one real turn measured, read from what Tex logged for it in the chat's ledger (Dev2, 2026-11-14: "when we play
 * through a real text, show the real time instead of the estimate"): the reply's `timing` (the Worker's wait, the time
 * before the first model call, each front-door round and each tool call, and the whole reply), the reviewer's `judge`
 * entries, and the `step` entries Tex writes for its other model steps. Each becomes the canvas step it measures.
 *
 * Kept apart from the canvas's simulation (`realTimes.ts` re-exports these) so it reads nothing but the ledger: the
 * gateway's `tex_dev` bundles this file with the Lab's other Replay code (`replayEntry.ts`,
 * `scripts/tex-dev-replay.mjs`), and answers an AI with the same numbers the Lab draws.
 */
import { BASE_MODELS } from "../data/models";
import type { LedgerEntry } from "../../page/texPageTypes";
import { momentAsSteps, STEP_NODES, stepIO, type IoLine } from "./stepIO";

export type { IoLine } from "./stepIO";

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

const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

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
  // A step the graph runner logged is timed by its own runs (`ownMs`); the reply's timing fills in only the steps it
  // has no run for (turns from before the runner), so no time is counted twice and none is made up from a remainder.
  const ran = new Set(mine.filter(isNodeRun).map((e) => e.name as string));
  const rounds = (Array.isArray(timing.rounds) ? timing.rounds : []).map(rec).filter((r): r is Record<string, unknown> => r !== null && num(r.ms) !== null);
  if (rounds.length) {
    add("door", num(rounds[0].at) ?? 0);
    for (const r of rounds) add("fd", ran.has("fd") ? 0 : num(r.ms)!, 1);
  }
  const usd = rounds.some((r) => r.model) ? rounds.reduce((a, r) => a + roundUsd(r), 0) : undefined;
  const at: Record<string, number> = {};
  for (const t of Array.isArray(timing.tools) ? timing.tools : []) {
    const m = num(rec(t)?.ms);
    if (m === null) continue;
    if (!ran.has("tools")) add("tools", m);
    const when = num(rec(t)?.at);
    if (when !== null && at.tools === undefined) at.tools = when;
  }
  for (const e of mine) {
    const m = num(e.ms);
    if (m === null) continue;
    if (e.kind === "judge" && e.by === "review") add("reviewer", m, 1);
    else if (isNodeRun(e)) add(e.name as string, ownMs(e), e.name === "fd" && rounds.length ? 0 : 1);
    else if (isDelivery(e)) add("send", m);
    else if (e.kind === "step" && typeof e.step === "string" && STEP_NODES.has(e.step)) add(e.step, m, 1);
  }
  // A turn from before the Worker kept its delivery: Text them is timed from the gateway's answer to its last text kept
  // as delivered, both logged times, never what the other steps leave of the reply.
  if (!mine.some(isDelivery)) {
    const answered = mine.find((e) => e.kind === "reply")?.at;
    const last = Math.max(...mine.filter((e) => e.kind === "text" && rec(e.from)?.kind === "tex" && e.delivered !== false).map((e) => e.at));
    if (typeof answered === "number" && Number.isFinite(last) && last >= answered) add("send", last - answered);
  }
  return { reply: wait + replyMs, ms, calls, ...(Object.keys(at).length ? { at } : {}), ...(usd !== undefined ? { usd } : {}) };
}

/** A run the graph runner logged (`ledger.js` `nodeEntry`). */
const isNodeRun = (e: LedgerEntry) => e.kind === "step" && e.step === "node" && typeof e.name === "string" && e.name !== "";

/**
 * A run's own time: its whole run less what it waited on the nodes it called (`texGraph.cjs`), so Answer checks never
 * show the front door's rewrites as theirs. A run logged before `own` was kept counts whole.
 */
const ownMs = (e: LedgerEntry) => num(e.own) ?? num(e.ms) ?? 0;

/**
 * The texting Worker's delivery of the turn's reply to the chat's service (`apps/agent/src/stepEvents.ts`
 * `deliveryStep`): Text them's own work happens there, after the gateway's answer, so its time is the gateway's send
 * node plus this.
 */
const isDelivery = (e: LedgerEntry) => e.kind === "step" && e.step === "send" && e.name === "delivery";

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
    // Before Triage had a node (2026-11-14), code's straight-to-Tex was kept as a Decide `by: "code"`: it is Triage's.
    const name = st.name === "decide" && rec(st.output)?.by === "code" ? "triage" : st.name;
    out.push({ ...e, turn, step: name, ok: st.ok !== false, ...(num(st.ms) !== null ? { ms: num(st.ms)! } : {}), input: st.input, output: st.output, ...(typeof st.of === "string" ? { of: st.of } : {}) } as LedgerEntry);
  }
  return out;
}

/**
 * One turn of a moment as Replay reads it: the chat's entries with the Worker's judgings and tapbacks from the moment's
 * first text (less a second) until the turn's last entry given to the turn as its Decide and React.
 */
export function momentTurnEntries(m: { at: number }, entries: LedgerEntry[], turn: string): LedgerEntry[] {
  const sent = Math.max(m.at, ...entries.filter((e) => e.turn === turn).map((e) => e.at));
  return withWorkerSteps(entries, turn, m.at - 1_000, sent);
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
    else if (isNodeRun(e)) add(e.name as string, ownMs(e), 1);
    else if (isDelivery(e)) add("send", m);
    else if (e.kind === "step" && typeof e.step === "string" && STEP_NODES.has(e.step)) add(e.step, m, 1);
  }
  if (!Object.keys(ms).length) return null;
  const first = Math.min(...mine.map((e) => e.at - (num(e.ms) ?? 0)));
  const last = Math.max(...mine.map((e) => e.at));
  return { reply: Math.max(0, last - first), ms, calls };
}

/**
 * What each step got and gave in one real turn, from the same ledger entries as its times (Dev2, 2026-11-14: "when a
 * node is highlighted, I cant see what the inputs or outputs are, It should show up in the right panel"). Only the
 * person's own chats are read, and only into this tab. `stepIO.ts` reads each step.
 */
export function realIO(entries: LedgerEntry[], turn: string | null, text: string, answer: string, startedBy?: string): Record<string, IoLine[]> {
  return stepIO(entries, turn, text, answer, startedBy);
}
