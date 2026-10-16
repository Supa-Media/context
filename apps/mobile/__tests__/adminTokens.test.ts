import { describe, expect, test } from "@jest/globals";
import { changeBetween, isTokenMetric, perCall, perCallSegments, tokenReport } from "../features/admin/tokens";

const day = (i: number) => `2026-10-${String(i + 1).padStart(2, "0")}`;
const series = (metric: string, counts: number[]) => ({
  metric,
  points: counts.map((count, i) => ({ day: day(i), count })),
  total: counts.reduce((a, b) => a + b, 0),
});

describe("token panel arithmetic", () => {
  test("family counters are token metrics; the rest are events", () => {
    expect(isTokenMetric("mcp.calls.claude")).toBe(true);
    expect(isTokenMetric("mcp.response_tokens.other")).toBe(true);
    expect(isTokenMetric("mcp.tool_call")).toBe(false);
    expect(isTokenMetric("note.write")).toBe(false);
  });

  test("the shown window and the one before it are split, not mixed", () => {
    const report = tokenReport(
      [
        series("mcp.calls.claude", [1, 1, 2, 2]),
        series("mcp.response_tokens.claude", [10, 10, 40, 40]),
        series("mcp.request_tokens.claude", [5, 5, 6, 6]),
        series("mcp.tool_call", [9, 9, 9, 9]),
      ],
      2,
    );
    expect(report.days).toEqual([day(2), day(3)]);
    expect(report.totals).toEqual({ calls: 4, in: 12, out: 80 });
    expect(report.previous).toEqual({ calls: 2, in: 10, out: 20 });
    expect(report.agents[0].out).toEqual([40, 40]);
    // A family with no counters is zeros, not missing.
    expect(report.agents[1].calls).toEqual([0, 0]);
  });

  test("a window too short to hold the period before has no comparison", () => {
    const report = tokenReport([series("mcp.calls.claude", [1, 2, 3])], 2);
    expect(report.previous).toBeNull();
  });

  test("per-call segments add up to the day's overall average", () => {
    const report = tokenReport(
      [
        series("mcp.calls.claude", [3]),
        series("mcp.response_tokens.claude", [600]),
        series("mcp.calls.chatgpt", [1]),
        series("mcp.response_tokens.chatgpt", [400]),
      ],
      1,
    );
    const segments = perCallSegments(report);
    const stacked = segments.reduce((total, agent) => total + agent[0], 0);
    expect(stacked).toBe(perCall(1000, 4));
    // Not the sum of each agent's own average (200 + 400).
    expect(stacked).not.toBe(600);
  });

  test("no calls is no average and no change", () => {
    expect(perCall(10, 0)).toBeNull();
    expect(changeBetween(5, 0)).toBeNull();
    expect(changeBetween(null, 3)).toBeNull();
    expect(changeBetween(3, 4)).toBe(-0.25);
  });
});
