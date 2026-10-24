/**
 * Day by day, near the top of tex.lc/admin: every headline figure as a line
 * with one point per day, the latest day's value, and how it moved from the
 * day before (the owner, 2026-10-24: "does it go down the next day?"). A Task
 * dropdown narrows the conversation figures to one kind of task. Days with
 * nothing to measure are gaps, not zeros. The arithmetic is `./trends`.
 */

import { useMemo, useState } from "react";
import { texDashboardColors as C } from "../../design/tokens/texDashboardColors";
import { applyFilters, optionsOf, type TexReport } from "./model";
import { formatDelta, formatTrend, lastChange, toneOf, topOf, trendPaths, trendsOf, windowDayList, type TexSpend, type Trend } from "./trends";

export function TrendsPanel({ report, spend }: { report: TexReport; spend: TexSpend | undefined }) {
  const [task, setTask] = useState("");
  const days = useMemo(() => windowDayList(report), [report]);
  const rows = useMemo(() => (task === "" ? report.reviews : applyFilters(report.reviews, { task: [task] })), [report, task]);
  const trends = useMemo(() => trendsOf(report, rows, spend, days), [report, rows, spend, days]);
  const tasks = optionsOf(report.reviews, "task");
  return (
    <section className="td-card" data-testid="tex-dashboard-trends">
      <div className="td-card-head">
        <h2 className="td-h2">Day by day</h2>
        <span className="td-select">
          <select aria-label="Task" value={task} onChange={(event) => setTask(event.target.value)} data-testid="tex-dashboard-trends-task">
            <option value="">Task: all tasks</option>
            {tasks.map((option) => (
              <option key={option.value} value={option.value}>
                Task: {option.label} ({option.count})
              </option>
            ))}
          </select>
        </span>
      </div>
      <p className="td-meta">One point a day (UTC). The change is the latest day against the day before it. Turns, answer time and spend are everyone&apos;s; the rest follow the task.</p>
      <div className="td-trends">
        {trends.map((trend) => (
          <TrendCard key={trend.key} trend={trend} days={days} />
        ))}
      </div>
    </section>
  );
}

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function TrendCard({ trend, days }: { trend: Trend; days: readonly string[] }) {
  const { last, delta } = lastChange(trend.values);
  const tone = toneOf(trend.better, delta);
  const { line, points } = trendPaths(trend.values, topOf(trend.unit, trend.values));
  const color = trend.key === "frustrated" ? C.bad : C.blue;
  return (
    <div className="td-trend" data-testid={`tex-dashboard-trend-${trend.key}`}>
      <div className="td-trend-head">
        <span className="td-trend-name">{trend.label}</span>
        {delta === null ? null : <span className={`td-delta ${tone}`}>{formatDelta(trend.unit, delta)}</span>}
      </div>
      <span className="td-trend-value num">{formatTrend(trend.unit, last)}</span>
      <div className="td-trend-plot">
      <svg className="td-chart" viewBox="0 0 300 120" preserveAspectRatio="none" style={{ height: 120 }} role="img" aria-label={`${trend.label} per day`}>
        {[30, 60, 90].map((y) => (
          <line key={y} x1={0} y1={y} x2={300} y2={y} stroke={C.line} strokeDasharray="3 4" />
        ))}
        <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="td-trend-dots" aria-hidden>
        {points.map((point) => (
          <span key={point.i} style={{ left: `${(point.x / 300) * 100}%`, top: `${(point.y / 120) * 100}%`, background: color }} title={`${shortDay(days[point.i])}: ${formatTrend(trend.unit, trend.values[point.i])}`} />
        ))}
      </div>
      </div>
      <div className="td-axis">
        <span>{shortDay(days[0])}</span>
        <span>{shortDay(days[days.length - 1])}</span>
      </div>
    </div>
  );
}
