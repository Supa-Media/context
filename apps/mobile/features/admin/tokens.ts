/**
 * The admin Token usage panel's arithmetic: turning the per-family token and
 * call counters (`mcp.request_tokens.<family>`, `mcp.response_tokens.<family>`,
 * `mcp.calls.<family>`) into what the panel draws.
 *
 * Pure, like `report.ts`, so every number is checkable without mounting.
 * All of these counters cover Premium workspaces only
 * (`docs/decisions/observability/token-usage.md`), so tokens and calls are
 * divided over the same population.
 */
import type { Series } from "./report";

/** The control plane's `CLIENT_FAMILIES`, in its order, with the name a person reads. */
export const TOKEN_FAMILIES = [
  ["claude", "Claude"],
  ["chatgpt", "ChatGPT"],
  ["codex", "Codex"],
  ["gemini", "Gemini"],
  ["other", "Other agents"],
] as const;

const TOKEN_METRIC = /^mcp\.(request_tokens|response_tokens|calls)\.[a-z]+$/;

/** A family counter: drawn by the Token usage panel, never as an Events row. */
export function isTokenMetric(metric: string): boolean {
  return TOKEN_METRIC.test(metric);
}

export interface AgentUsage {
  family: string;
  label: string;
  /** One value per day in the window, oldest first. */
  calls: number[];
  in: number[];
  out: number[];
}

export interface Totals {
  calls: number;
  in: number;
  out: number;
}

export interface TokenReport {
  days: string[];
  agents: AgentUsage[];
  totals: Totals;
  /** The same totals for the window before, or null where the report did not reach that far. */
  previous: Totals | null;
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/**
 * Build the panel from a report that covers `window` days ending today, where
 * the panel shows the last `days` of them. A window at least twice `days`
 * carries the comparison period; a shorter one has none.
 */
export function tokenReport(series: readonly Series[], days: number): TokenReport {
  const byMetric = new Map(series.map((entry) => [entry.metric, entry.points]));
  const anyPoints = series.find((entry) => isTokenMetric(entry.metric))?.points ?? series[0]?.points ?? [];
  const length = anyPoints.length;
  const shown = Math.min(days, length);
  const counts = (metric: string) => {
    const points = byMetric.get(metric);
    return Array.from({ length }, (_, i) => points?.[i]?.count ?? 0);
  };

  const full = TOKEN_FAMILIES.map(([family, label]) => ({
    family,
    label,
    calls: counts(`mcp.calls.${family}`),
    in: counts(`mcp.request_tokens.${family}`),
    out: counts(`mcp.response_tokens.${family}`),
  }));
  const current = (values: number[]) => values.slice(length - shown);
  const before = (values: number[]) => values.slice(length - 2 * shown, length - shown);
  const totalsOf = (pick: (values: number[]) => number[]): Totals => ({
    calls: sum(full.flatMap((agent) => pick(agent.calls))),
    in: sum(full.flatMap((agent) => pick(agent.in))),
    out: sum(full.flatMap((agent) => pick(agent.out))),
  });

  return {
    days: anyPoints.slice(length - shown).map((point) => point.day),
    agents: full.map((agent) => ({
      ...agent,
      calls: current(agent.calls),
      in: current(agent.in),
      out: current(agent.out),
    })),
    totals: totalsOf(current),
    previous: length >= 2 * shown && shown > 0 ? totalsOf(before) : null,
  };
}

/** Tokens out per tool call, or null with no calls to divide by. */
export function perCall(out: number, calls: number): number | null {
  return calls > 0 ? out / calls : null;
}

/** Fractional change from `before` to `now`; null where there is no base to compare against. */
export function changeBetween(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return (now - before) / before;
}

/**
 * Each agent's share of one day's tokens returned per call: its tokens out over
 * **all** calls that day. The segments add up to the day's overall average,
 * which a stack of each agent's own average would not.
 */
export function perCallSegments(report: TokenReport): number[][] {
  return report.agents.map((agent) =>
    report.days.map((_, i) => {
      const calls = sum(report.agents.map((each) => each.calls[i]));
      return calls > 0 ? agent.out[i] / calls : 0;
    }),
  );
}
