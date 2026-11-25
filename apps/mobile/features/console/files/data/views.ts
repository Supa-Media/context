/**
 * One metric as its row draws it: name, latest value coloured by how it
 * stands against the target of the area that uses it, its trend, its formula
 * as chips, who uses it and the sources it reads. Pure.
 */

import type { MetricNote, Use } from "./metrics";
import { usedByWords } from "./metrics";
import { sourceBySlug, type DataSource } from "./sources";
import { formulaParts, inputsOf, stateOf, targetOnScale, trendOf, type Part, type TargetState, type Worked, type ValueStatus } from "./workOut";

export interface MetricView {
  readonly path: string;
  readonly name: string;
  readonly slug: string;
  readonly shown: string;
  readonly status: ValueStatus | "loading";
  /** The parser's or the engine's own words, for a formula that could not be read or worked out. */
  readonly problem: string | null;
  readonly series: readonly number[];
  readonly target: number | null;
  readonly state: TargetState;
  readonly parts: readonly Part[];
  readonly period: string;
  /** "Velocity", or null: drawn "Not used yet". */
  readonly usedBy: string | null;
  /** "Stripe + Cloudflare": the sources it reads, as the phone's line and the area picker say. */
  readonly inputs: string;
  /** Each input's sheet, `stripe/revenue.csv`, for the metric note's inputs line. */
  readonly inputPaths: readonly { label: string; path: string | null }[];
  /** The source folders it reads. */
  readonly reads: readonly string[];
}

export function metricView(
  metric: MetricNote,
  worked: Worked | undefined,
  uses: ReadonlyMap<string, readonly Use[]>,
  sources: readonly DataSource[],
  settled: boolean,
): MetricView {
  const bySlug = sourceBySlug(sources);
  const used = uses.get(metric.name.trim().toLowerCase());
  const target = used?.[0]?.target ?? null;
  const parts = metric.parsed.ok ? formulaParts(metric.parsed.ast, (slug) => bySlug(slug)?.kind ?? "other") : [];
  const inputs = metric.parsed.ok ? inputsOf(metric.parsed.ast) : [];
  const names: string[] = [];
  for (const input of inputs) {
    const name = bySlug(input.source)?.name ?? input.source;
    if (!names.includes(name)) names.push(name);
  }
  const loading = !settled && worked?.latest.status !== "ok" && metric.parsed.ok;
  const status = worked === undefined || loading ? "loading" : worked.latest.status;
  return {
    path: metric.path,
    name: metric.name,
    slug: metric.slug,
    shown: status === "loading" ? "…" : (worked?.shown ?? "—"),
    status,
    problem: metric.parsed.ok ? (worked?.latest.status === "error" ? (worked.latest.note ?? null) : null) : metric.parsed.message,
    series: worked === undefined ? [] : trendOf(worked),
    target: worked === undefined ? null : targetOnScale(worked, target),
    state: worked === undefined ? "unknown" : stateOf(worked, target),
    parts,
    period: metric.every,
    usedBy: usedByWords(used),
    inputs: names.join(" + "),
    inputPaths: inputs.map((input) => {
      const source = bySlug(input.source);
      const dataset = source?.datasets.find((d) => d.name.toLowerCase() === input.dataset.toLowerCase());
      return { label: `${input.source}/${input.dataset}.csv`, path: dataset === undefined || dataset.computed ? null : dataset.path };
    }),
    reads: inputs.map((input) => bySlug(input.source)?.folder ?? input.source),
  };
}
