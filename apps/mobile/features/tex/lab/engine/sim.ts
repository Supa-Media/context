/**
 * Speed and cost of a moment through a version, ported from the artifact's
 * simulation: every step's own time and cost, helpers folded into the step
 * that calls them, send-backs weighted by how often they happen, and the
 * reply time as when "Text them" ends.
 */
import { EFFORT, FTYPES } from "../data/models";
import type { LabEdge, LabGraph, LabNode } from "../types";
import { isStable, mods } from "./modules";
import { MODELS, node, type LabState } from "./state";
import { SCENARIOS } from "./traces";
import type { RealTimes } from "./realTimes";

type Log = LabState["logRows"];
export type StepTime = { start: number; end: number; ms: number; usd: number; calls: number; parts: Part[]; lane: string };
export type Part = { id: string; ms: number; own?: boolean; note?: string };
export type Sim = { T: Record<string, StepTime>; reply: number; usd: number; replyCalls: number; jobEnd: number; reach: Map<string, { lane: string }>; inside: Set<string>; real?: Set<string> };

export const schemaTok = (n: Pick<LabNode, "outSchema">) => 10 + (n.outSchema || []).reduce((a, f) => a + ((FTYPES as Record<string, { tok: number }>)[f.type]?.tok || 6), 0);
export const outTok = (n: Pick<LabNode, "outSchema" | "out">) => (n.outSchema?.length ? schemaTok(n) : n.out || 0);

export function fires(e: LabEdge, tags: string[], g: LabGraph) {
  const t = node(e.to, g);
  const f = node(e.from, g);
  if (!t || !f || !t.on || !f.on) return false;
  return e.when.includes("*") || e.when.some((w) => tags.includes(w));
}

export function ctxTokens(n: Pick<LabNode, "ctx">, g: LabGraph) {
  let t = 0;
  for (const c of n.ctx) {
    if (c.startsWith("out:")) {
      const o = node(c.slice(4), g);
      if (o) t += outTok(o) * (o.rounds || 1) * (o.outSchema?.length ? 1 : (EFFORT as Record<string, number>)[o.effort ?? ""] || 1);
    } else t += mods(g)[c]?.tok || 0;
  }
  return t;
}

export const roundsFor = (n: LabNode, s: string) => SCENARIOS[s]?.rounds?.[n.id] ?? n.rounds;

export function cacheShare(n: Pick<LabNode, "ctx">, g: LabGraph) {
  let pre = 0;
  let tot = 0;
  let open = true;
  for (const c of n.ctx) {
    const t = ctxTokens({ ctx: [c] }, g);
    tot += t;
    if (open && isStable(c, g)) pre += t;
    else open = false;
  }
  return tot ? Math.min(0.95, pre / tot) : 0;
}

export function stepCost(n: LabNode, g: LabGraph, s: string, log: Log, hit?: number | null) {
  if (hit == null) hit = cacheShare(n, g);
  const m = MODELS[n.model] || MODELS.code;
  let ms = 0;
  let usd = 0;
  let calls = 0;
  if (m.runs === "code") ms = n.ms || 0;
  else {
    const r = roundsFor(n, s);
    const outT = outTok(n) * (m.runs === "api" || n.outSchema?.length ? 1 : (EFFORT as Record<string, number>)[n.effort ?? ""] || 1);
    const inT = ctxTokens(n, g);
    const L = log?.[n.id];
    const per = L ? L.prodMs / Math.max(1, L.calls) : (m.base ?? 0) + outT * (m.perTok ?? 0) + inT * (1 - hit) * (m.perIn ?? 0.006);
    ms = r * per;
    calls = r;
    usd = (r * (inT * (hit * (m.cacheR ?? 0) + (1 - hit) * (m.cacheW ?? 0)) + outT * (m.outP ?? 0))) / 1e6;
    if (n.timeoutS) ms = Math.min(ms, n.timeoutS * 1000);
  }
  return { ms, usd, calls };
}

/**
 * One step's time with its helpers folded in. With `real` (a text the person sent, `realTimes.ts`), a measured step
 * takes its measured time, a helper that was not measured did not run, and send-backs are already in the measured
 * rounds, so the timeline plays at the pace Tex really went.
 */
export function fold(n: LabNode, g: LabGraph, s: string, tags: string[], log: Log, seen = new Set<string>(), real: RealTimes | null = null): { ms: number; usd: number; calls: number; parts: Part[] } {
  if (seen.has(n.id)) return { ms: 0, usd: 0, calls: 0, parts: [] };
  seen.add(n.id);
  const est = stepCost(n, g, s, log);
  const own = real && real.ms[n.id] !== undefined ? { ms: real.ms[n.id], usd: est.usd, calls: real.calls[n.id] ?? 0 } : est;
  let ms = own.ms;
  let usd = own.usd;
  let calls = own.calls;
  const parts: Part[] = [{ id: n.id, ms: own.ms, own: true }];
  for (const e of g.edges.filter((e) => e.from === n.id && e.mode === "uses" && (real ? true : fires(e, tags, g)))) {
    const c = node(e.to, g)!;
    if (real) {
      const m = real.ms[c.id];
      if (m === undefined) continue;
      ms += m;
      calls += real.calls[c.id] ?? 0;
      parts.push({ id: c.id, ms: m });
      continue;
    }
    if (c.kind === "tool") {
      const k = Math.max(1, roundsFor(n, s) - 1);
      const inner = fold(c, g, s, tags, log, new Set(seen));
      ms += k * c.ms + (inner.ms - c.ms);
      usd += inner.usd;
      calls += inner.calls;
      parts.push({ id: c.id, ms: k * c.ms, note: k + (k > 1 ? " calls" : " call") });
      inner.parts.filter((p) => !p.own).forEach((p) => parts.push(p));
    } else {
      const inner = fold(c, g, s, tags, log, new Set(seen));
      ms += inner.ms;
      usd += inner.usd;
      calls += inner.calls;
      parts.push({ id: c.id, ms: inner.ms });
    }
  }
  for (const e of g.edges.filter((e) => !real && e.from === n.id && e.mode === "loop" && fires(e, tags, g))) {
    const p = n.sendBack ?? 0.1;
    const back = fold(node(e.to, g)!, g, s, tags, log, new Set([n.id]));
    const x = p * (back.ms + own.ms);
    ms += x;
    usd += p * (back.usd + own.usd);
    calls += p * (back.calls + own.calls);
    parts.push({ id: "sendback", ms: x, note: Math.round(p * 100) + "% of the time" });
  }
  return { ms, usd, calls, parts };
}

/** Steps whose every run leaves a ledger entry for its turn (`realTimes.ts`), so no entry means it did not run. */
const LOGS_WHEN_RUN = new Set(["reviewer", "router", "fallback", "card", "classifier", "selfreview", "handback", "mailadv", "tools"]);

export function simulate(g: LabGraph, s: string, log: Log, real: RealTimes | null = null): Sim {
  const tags = (SCENARIOS[s] || SCENARIOS.own)?.tags ?? [];
  // A real run goes where it was measured: a measured step ran, a step that always logs when it runs and logged
  // nothing did not, and the rest follow the guess from the text's words.
  const on = (e: LabEdge) => {
    if (!real) return fires(e, tags, g);
    if (!node(e.to, g)?.on || !node(e.from, g)?.on) return false;
    if (real.ms[e.to] !== undefined) return true;
    return !LOGS_WHEN_RUN.has(e.to) && fires(e, tags, g);
  };
  const reach = new Map<string, { lane: string }>();
  const start = node("text", g) || g.nodes[0];
  if (!start) return { T: {}, reply: 0, usd: 0, replyCalls: 0, jobEnd: 0, reach, inside: new Set() };
  reach.set(start.id, { lane: "reply" });
  let ch = true;
  let guard = 0;
  while (ch && guard++ < 60) {
    ch = false;
    for (const e of g.edges) {
      if (!reach.has(e.from) || !on(e) || e.mode === "uses" || e.mode === "loop") continue;
      const fl = reach.get(e.from)!.lane;
      const lane = e.mode === "behind" ? "behind" : e.mode === "job" ? "job" : fl;
      if (!reach.has(e.to)) {
        reach.set(e.to, { lane });
        ch = true;
      }
    }
  }
  const T: Record<string, StepTime> = {};
  const order = [...reach.keys()];
  for (let p = 0; p < order.length + 2; p++)
    for (const id of order) {
      const n = node(id, g)!;
      const preds = g.edges.filter((e) => e.to === id && reach.has(e.from) && on(e) && !["uses", "loop"].includes(e.mode) && T[e.from]);
      if (id !== start.id && !preds.length) continue;
      const st = id === start.id ? 0 : Math.max(0, ...preds.map((e) => T[e.from].end));
      const f = fold(n, g, s, tags, log, new Set(), real);
      T[id] = { start: st, end: st + f.ms, ms: f.ms, usd: f.usd, calls: f.calls, parts: f.parts, lane: reach.get(id)!.lane };
    }
  const all = Object.values(T);
  const reply = T.send ? T.send.end : Math.max(0, ...all.filter((t) => t.lane === "reply").map((t) => t.end));
  const inside = new Set<string>();
  for (const e of g.edges) if (e.mode === "uses" && reach.has(e.from) && on(e)) inside.add(e.to);
  let grow = true;
  while (grow) {
    grow = false;
    for (const e of g.edges)
      if (e.mode === "uses" && inside.has(e.from) && on(e) && !inside.has(e.to)) {
        inside.add(e.to);
        grow = true;
      }
  }
  return {
    T,
    reply,
    usd: all.reduce((a, t) => a + t.usd, 0),
    replyCalls: all.filter((t) => t.lane === "reply").reduce((a, t) => a + t.calls, 0),
    jobEnd: Math.max(0, ...all.filter((t) => t.lane === "job").map((t) => t.end)),
    reach,
    inside,
  };
}

export const fmtS = (ms: number) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s";
export const fmtUsd = (u: number) => (u < 0.01 ? "$" + u.toFixed(4) : "$" + u.toFixed(u < 1 ? 3 : 2));
