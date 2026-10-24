/**
 * How Tex's models perform, read from the turn log's traces for the Tex
 * dashboard (`texReport.ts`, tex.lc/admin): each model's rounds, how fast they
 * are, how often they fail, retry, run out of room or fall back; what the
 * router sends to thinking; and where a turn's time goes.
 *
 * Pure: the turns go in, figures come out. Names, counts and milliseconds
 * only, as the log itself.
 */

import { v, type Infer } from "convex/values";
import type { Doc } from "../../../_generated/dataModel";
import { percentile } from "./agentReport";

export const texPerformanceValidator = v.object({
  /** Whole turns, model rounds and tool calls, in milliseconds. */
  time: v.object({ totalMs: v.number(), modelMs: v.number(), toolMs: v.number(), p50: v.number(), p95: v.number() }),
  models: v.array(
    v.object({
      model: v.string(),
      rounds: v.number(),
      failed: v.number(),
      retried: v.number(),
      cut: v.number(),
      /** Turns that fell back onto this model after another failed. */
      fallbacks: v.number(),
      p50: v.number(),
      p95: v.number(),
    }),
  ),
  router: v.object({ picks: v.number(), think: v.number(), confidence: v.union(v.number(), v.null()) }),
  /** Answer times per day, aligned with the report's `byDay`. */
  daily: v.array(v.object({ p50: v.number(), p95: v.number() })),
  tools: v.array(v.object({ tool: v.string(), p50: v.number() })),
});

export type TexPerformance = Infer<typeof texPerformanceValidator>;

function spread(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

/** `dayOf` maps a turn to its index in the report's days, or -1 outside them. */
export function texPerformance(turns: readonly Doc<"agentTurns">[], days: number, dayOf: (at: number) => number): TexPerformance {
  const models = new Map<string, { ms: number[]; failed: number; retried: number; cut: number; fallbacks: number }>();
  const entry = (model: string) => {
    const found = models.get(model) ?? { ms: [], failed: 0, retried: 0, cut: 0, fallbacks: 0 };
    models.set(model, found);
    return found;
  };
  const toolMs = new Map<string, number[]>();
  const daily: number[][] = Array.from({ length: days }, () => []);
  const router = { picks: 0, think: 0, confidence: [] as number[] };
  const time = { totalMs: 0, modelMs: 0, toolMs: 0 };
  for (const turn of turns) {
    time.totalMs += turn.ms;
    time.modelMs += turn.modelMs;
    time.toolMs += turn.toolMs;
    const index = dayOf(turn.at);
    if (index >= 0 && index < days) daily[index].push(turn.ms);
    for (const step of turn.trace) {
      if (step.kind === "model") {
        const model = entry(step.model ?? turn.model);
        model.ms.push(step.ms);
        if (!step.ok) model.failed += 1;
        if (step.retried) model.retried += 1;
        if (step.cut) model.cut += 1;
      } else if (step.kind === "fallback") {
        entry(step.model ?? turn.model).fallbacks += 1;
      } else if (step.kind === "router") {
        router.picks += 1;
        if (step.tier === "think") router.think += 1;
        if (step.confidence !== undefined) router.confidence.push(step.confidence);
      } else if (step.tool !== undefined) {
        const list = toolMs.get(step.tool) ?? [];
        list.push(step.ms);
        toolMs.set(step.tool, list);
      }
    }
  }
  return {
    time: { ...time, ...spread(turns.map((turn) => turn.ms)) },
    models: [...models.entries()]
      .map(([model, m]) => ({ model, rounds: m.ms.length, failed: m.failed, retried: m.retried, cut: m.cut, fallbacks: m.fallbacks, ...spread(m.ms) }))
      .sort((a, b) => b.rounds - a.rounds),
    router: {
      picks: router.picks,
      think: router.think,
      confidence: router.confidence.length === 0 ? null : router.confidence.reduce((sum, c) => sum + c, 0) / router.confidence.length,
    },
    daily: daily.map(spread),
    tools: [...toolMs.entries()].map(([tool, ms]) => ({ tool, p50: spread(ms).p50 })),
  };
}
