/**
 * The Tex dashboard's day-by-day view (tex.lc/admin): every headline figure as
 * a series, one point per day, so a bad day can be checked against the next
 * (the owner, 2026-10-24: "sure people are frustrated most of the time, but
 * the next day does it go down?").
 *
 * Pure. A day with nothing to measure is `null` and drawn as a gap, never as
 * zero: a day nobody was scored is not a day nobody was frustrated.
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { SCORE_LABELS, formatMicroUsd, formatSeconds, isFrustrated, type TexReport, type TexReview } from "./model";

export type TexSpend = FunctionReturnType<typeof api.functions.texSpend.report>;

export type TrendUnit = "pct" | "score" | "texts" | "count" | "seconds" | "usd";

export interface Trend {
  key: string;
  label: string;
  unit: TrendUnit;
  /** Which way is good, or null when neither is (how many there were). */
  better: "up" | "down" | null;
  values: (number | null)[];
}

const DAY_MS = 86_400_000;

export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Every day of the report's window, oldest first, ending on its last day. */
export function windowDayList(report: TexReport, now = Date.now()): string[] {
  const last = report.turns.byDay[report.turns.byDay.length - 1]?.day ?? dayOf(now);
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: report.days }, (_, i) => dayOf(end - (report.days - 1 - i) * DAY_MS));
}

function perDay(rows: readonly TexReview[], days: readonly string[], measure: (those: TexReview[]) => number | null): (number | null)[] {
  const byDay = new Map<string, TexReview[]>();
  for (const row of rows) {
    const day = dayOf(row.at);
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  return days.map((day) => {
    const those = byDay.get(day);
    return those === undefined || those.length === 0 ? null : measure(those);
  });
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Real spend when Cloudflare answered, else our own estimate from token counts; null where neither knows. */
export function spendByDay(report: TexReport, spend: TexSpend | undefined, days: readonly string[]): { values: (number | null)[]; real: boolean } {
  if (spend !== undefined && spend.configured && spend.error === null) {
    const usd = new Map(spend.days.map((day) => [day.day, day.usd]));
    return { values: days.map((day) => (day < spend.keptFrom ? null : (usd.get(day) ?? null))), real: true };
  }
  const micro = new Map(report.turns.byDay.map((day) => [day.day, day.costMicroUsd / 1_000_000]));
  return { values: days.map((day) => micro.get(day) ?? null), real: false };
}

/**
 * The series, in the order the page draws them. `rows` are the scored
 * conversations already narrowed (by task, say); the turn figures are always
 * everyone's.
 */
export function trendsOf(report: TexReport, rows: readonly TexReview[], spend: TexSpend | undefined, days = windowDayList(report)): Trend[] {
  const turns = new Map(report.turns.byDay.map((day, i) => [day.day, { turns: day.turns, p50: report.performance.daily[i]?.p50 ?? 0 }]));
  const money = spendByDay(report, spend, days);
  const turnsPerDay = days.map((day) => turns.get(day)?.turns ?? null);
  return [
    { key: "frustrated", label: "Frustrated", unit: "pct", better: "down", values: perDay(rows, days, (those) => those.filter(isFrustrated).length / those.length) },
    ...SCORE_LABELS.map(({ key, label }) => ({ key, label, unit: "score" as const, better: "up" as const, values: perDay(rows, days, (those) => average(those.map((row) => row[key]))) })),
    { key: "texts", label: "Texts to finish", unit: "texts", better: "down", values: perDay(rows, days, (those) => average(those.flatMap((row) => (row.texts === null ? [] : [row.texts])))) },
    { key: "scored", label: "Conversations scored", unit: "count", better: null, values: perDay(rows, days, (those) => those.length) },
    { key: "turns", label: "Turns", unit: "count", better: null, values: turnsPerDay },
    { key: "answer", label: "Typical answer time", unit: "seconds", better: "down", values: days.map((day) => { const t = turns.get(day); return t && t.turns > 0 ? t.p50 : null; }) },
    { key: "spend", label: money.real ? "Spend" : "Spend (our estimate)", unit: "usd", better: null, values: money.values },
    {
      key: "perTurn",
      label: "Cost per turn",
      unit: "usd",
      better: "down",
      values: days.map((_, i) => { const usd = money.values[i]; const n = turnsPerDay[i]; return usd === null || !n ? null : usd / n; }),
    },
  ];
}

/** The latest day with a value, and how it moved from the day with a value before it. */
export function lastChange(values: readonly (number | null)[]): { last: number | null; delta: number | null } {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return { last: null, delta: null };
  const last = known[known.length - 1];
  return { last, delta: known.length < 2 ? null : last - known[known.length - 2] };
}

export function formatTrend(unit: TrendUnit, value: number | null): string {
  if (value === null) return "—";
  switch (unit) {
    case "pct":
      return `${Math.round(value * 100)}%`;
    case "score":
    case "texts":
      return value.toFixed(1);
    case "count":
      return Math.round(value).toLocaleString("en-US");
    case "seconds":
      return formatSeconds(value);
    case "usd":
      return formatMicroUsd(value * 1_000_000);
  }
}

/** A change in the unit's own terms: points for a share, a signed number otherwise. */
export function formatDelta(unit: TrendUnit, delta: number): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  const size = Math.abs(delta);
  switch (unit) {
    case "pct":
      return `${sign}${Math.round(size * 100)} pts`;
    case "score":
    case "texts":
      return `${sign}${size.toFixed(1)}`;
    case "count":
      return `${sign}${Math.round(size)}`;
    case "seconds":
      return `${sign}${formatSeconds(size)}`;
    case "usd":
      return `${sign}${formatMicroUsd(size * 1_000_000)}`;
  }
}

/** Whether a change is good news, bad news, or neither. */
export function toneOf(better: Trend["better"], delta: number | null): "good" | "bad" | "flat" {
  if (better === null || delta === null || delta === 0) return "flat";
  return (delta < 0) === (better === "down") ? "good" : "bad";
}

/** A line through the known days of a `w` by `h` box, broken at each unknown day, and where each point sits. */
export function trendPaths(values: readonly (number | null)[], top: number, w = 300, h = 120): { line: string; points: { i: number; x: number; y: number }[] } {
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const scale = top > 0 ? top : 1;
  const points = values.flatMap((value, i) => (value === null ? [] : [{ i, x: values.length > 1 ? i * step : w / 2, y: h - 4 - (Math.min(value, scale) / scale) * (h - 8) }]));
  let line = "";
  points.forEach((point, n) => {
    const joined = n > 0 && points[n - 1].i === point.i - 1;
    line += `${joined ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
  });
  return { line: line.trim(), points };
}

/** The top of a series' scale: shares and scores have a fixed one, so days compare across windows. */
export function topOf(unit: TrendUnit, values: readonly (number | null)[]): number {
  if (unit === "pct") return 1;
  if (unit === "score") return 10;
  const max = Math.max(0, ...values.filter((value): value is number => value !== null));
  return max === 0 ? 1 : max * 1.1;
}
