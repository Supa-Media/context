/**
 * The Speed and cost view's "Measured from a run" reader: the pure part of the artifact's `readLog`
 * (template.html 1175), so it can be tested without the page. One JSON line per model call; a line
 * names its step (`node`) and optionally its model. Only the version's own steps are measured: a line
 * whose `side` is "main" is skipped and not counted as bad, since a run log may carry main's side too.
 */
import type { LabGraph, LabModel } from "../../types";

export type LogRow = { calls: number; wall: number; prodMs: number; out: number; api: boolean };
export type LogResult = { rows: Record<string, LogRow> | null; matched: number; bad: number };

/** The fields a log line may carry; anything else is ignored. */
type LogLine = { node?: unknown; model?: unknown; side?: unknown; ms?: unknown; in?: unknown; out?: unknown };

/**
 * Sum each step's calls. A line that is not JSON, or names no step of `g`, counts as bad. An API model's
 * time is the logged `ms`; a subscription model's is re-timed from its tokens (`base` + out * perTok +
 * 0.2 * in * 0.006), the artifact's arithmetic.
 */
export function readLog(text: string, g: LabGraph, MODELS: Record<string, LabModel>): LogResult {
  const out: Record<string, LogRow> = {};
  let matched = 0;
  let bad = 0;
  for (const line of text.split(/\n+/)) {
    const s = line.trim();
    if (!s) continue;
    let o: LogLine;
    try {
      o = JSON.parse(s) as LogLine;
    } catch {
      bad++;
      continue;
    }
    if (!o || typeof o !== "object") {
      bad++;
      continue;
    }
    if (o.side === "main") continue;
    const n = g.nodes.find((x) => x.id === o.node);
    if (!n) {
      bad++;
      continue;
    }
    const byLine = typeof o.model === "string" ? MODELS[o.model] : undefined;
    const m = byLine || MODELS[n.model] || MODELS.code;
    const api = m.runs !== "subscription";
    const prod = api ? +(o.ms as number) || 0 : (m.base ?? 0) + (+(o.out as number) || 0) * (m.perTok ?? 0) + (+(o.in as number) || 0) * 0.2 * 0.006;
    const r = out[n.id] || (out[n.id] = { calls: 0, wall: 0, prodMs: 0, out: 0, api });
    r.calls++;
    r.wall += +(o.ms as number) || 0;
    r.prodMs += prod;
    r.out += +(o.out as number) || 0;
    matched++;
  }
  return { rows: matched ? out : null, matched, bad };
}
