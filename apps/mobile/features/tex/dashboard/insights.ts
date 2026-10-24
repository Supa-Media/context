/**
 * What tex.lc/admin says, worked out from the figures (redesigned 2026-10-24
 * after the owner called the scorecards useless: "I have no frame of
 * reference of improvement or regression and where the gaps are").
 *
 * Every number carries the window before it and a target, and says how many
 * conversations it rests on; a rate drawn from fewer than `MIN_RATE_N` says so
 * instead of claiming a trend. Problems come from the triage agent's theme
 * notes (`apps/convex/functions/lib/adminFns/texTriage.ts`), matched to the
 * scored conversations by their signal and task codes; a shipped fix is
 * judged on the conversations where the problem could have happened, before
 * and since.
 *
 * Pure: the page draws what this returns.
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { SIGNAL_LABELS, TASK_LABELS, type TexReport, type TexReview } from "./model";
import type { TexSpend } from "./trends";

export type TexTriage = FunctionReturnType<typeof api.functions.texDashboard.triage>;
export type TriageDesk = Extract<TexTriage, { available: true }>;
export type ThemeRow = TriageDesk["themes"][number];
export type BugRow = TriageDesk["bugs"][number];
export type ReviewNoteRow = TriageDesk["reviews"][number];

const DAY = 86_400_000;
/** Task and signal codes were first scored 2026-10-24 at about 18:00 UTC; rows before it carry none. */
export const CODES_BEGAN = Date.UTC(2026, 9, 24, 18, 0);
/** A rate needs this many conversations in both windows before it claims better or worse. */
export const MIN_RATE_N = 20;
/** A shipped fix needs this many chances since it shipped before it is judged. */
export const MIN_SINCE_N = 5;
/** How far back a problem's hits are counted. */
export const PAIN_DAYS = 14;

/** Starting targets, proposed by the dashboard and accepted by the owner (2026-10-24). */
export const TARGETS = {
  success: 0.7,
  handedBack: 0.15,
  p95Ms: 60_000,
  troubled: 0.05,
} as const;

export function isSuccess(row: TexReview): boolean {
  return row.goal >= 8 && !row.signals.includes("gave_up");
}

export function isHandedBack(row: TexReview): boolean {
  return row.independence <= 4 || row.signals.includes("cant_first");
}

export function isCoded(row: TexReview): boolean {
  return row.at >= CODES_BEGAN;
}

export interface Span {
  from: number;
  to: number;
}

/** This window and the one before it, ending now. */
export function spansOf(days: number, now: number): { now: Span; before: Span } {
  return { now: { from: now - days * DAY, to: now }, before: { from: now - 2 * days * DAY, to: now - days * DAY } };
}

const inSpan = (span: Span) => (row: { at: number }) => row.at > span.from && row.at <= span.to;

export interface Tile {
  key: "success" | "handedBack" | "p95" | "troubled";
  label: string;
  /** The value and last window's, as shares or milliseconds; null when there is nothing to show. */
  value: number | null;
  before: number | null;
  target: number;
  /** Which way is good. */
  better: "up" | "down";
  unit: "pct" | "seconds";
  n: number;
  beforeN: number;
  /** Whether both windows hold enough to say better or worse. */
  enough: boolean;
  foot: string;
}

function share(rows: readonly TexReview[], test: (row: TexReview) => boolean): number | null {
  return rows.length === 0 ? null : rows.filter(test).length / rows.length;
}

/** The turn days inside a span, by the report's zero-filled days. */
function turnDaysIn(report: TexReport, span: Span) {
  return report.turns.byDay
    .map((day, index) => ({ ...day, index, at: Date.parse(`${day.day}T12:00:00Z`) }))
    .filter((day) => day.at > span.from - DAY / 2 && day.at <= span.to + DAY / 2);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The four numbers at the top, each with the window before it and its target. */
export function tilesOf(report: TexReport, rows: readonly TexReview[], days: number, now: number): Tile[] {
  const spans = spansOf(days, now);
  const coded = rows.filter(isCoded);
  const thisRows = coded.filter(inSpan(spans.now));
  const beforeRows = coded.filter(inSpan(spans.before));
  const enough = thisRows.length >= MIN_RATE_N && beforeRows.length >= MIN_RATE_N;
  const thisDays = turnDaysIn(report, spans.now);
  const beforeDays = days * 2 <= report.turnDays ? turnDaysIn(report, spans.before) : [];
  const p95 = (list: typeof thisDays) => median(list.filter((day) => day.turns > 0).map((day) => report.performance.daily[day.index]?.p95 ?? 0));
  const troubled = (list: typeof thisDays) => {
    const turns = list.reduce((sum, day) => sum + day.turns, 0);
    return turns === 0 ? null : list.reduce((sum, day) => sum + day.troubled, 0) / turns;
  };
  const turnsIn = (list: typeof thisDays) => list.reduce((sum, day) => sum + day.turns, 0);
  const turnEnough = beforeDays.length > 0 && turnsIn(thisDays) >= MIN_RATE_N && turnsIn(beforeDays) >= MIN_RATE_N;
  return [
    {
      key: "success",
      label: "Got what they wanted",
      value: share(thisRows, isSuccess),
      before: share(beforeRows, isSuccess),
      target: TARGETS.success,
      better: "up",
      unit: "pct",
      n: thisRows.length,
      beforeN: beforeRows.length,
      enough,
      foot: "Goal 8 or more and never gave up",
    },
    {
      key: "handedBack",
      label: "Tex handed it back",
      value: share(thisRows, isHandedBack),
      before: share(beforeRows, isHandedBack),
      target: TARGETS.handedBack,
      better: "down",
      unit: "pct",
      n: thisRows.length,
      beforeN: beforeRows.length,
      enough,
      foot: "Said it can't, or left the work to them",
    },
    {
      key: "p95",
      label: "Slowest 1 in 20 replies",
      value: p95(thisDays),
      before: beforeDays.length === 0 ? null : p95(beforeDays),
      target: TARGETS.p95Ms,
      better: "down",
      unit: "seconds",
      n: turnsIn(thisDays),
      beforeN: turnsIn(beforeDays),
      enough: turnEnough,
      foot: "On a typical day, every reply Tex sent",
    },
    {
      key: "troubled",
      label: "Replies that went wrong",
      value: troubled(thisDays),
      before: beforeDays.length === 0 ? null : troubled(beforeDays),
      target: TARGETS.troubled,
      better: "down",
      unit: "pct",
      n: turnsIn(thisDays),
      beforeN: turnsIn(beforeDays),
      enough: turnEnough,
      foot: "No answer, or a tool failed",
    },
  ];
}

export function onTarget(tile: Pick<Tile, "value" | "target" | "better">): boolean | null {
  if (tile.value === null) return null;
  return tile.better === "up" ? tile.value >= tile.target : tile.value <= tile.target;
}

/** Better, worse or about the same as last window; null when either window is too thin to say. */
export function directionOf(tile: Tile): "better" | "worse" | "same" | null {
  if (!tile.enough || tile.value === null || tile.before === null) return null;
  const change = tile.value - tile.before;
  const scale = tile.unit === "pct" ? 0.03 : 0.1 * Math.max(tile.before, 1);
  if (Math.abs(change) < scale) return "same";
  return (change > 0) === (tile.better === "up") ? "better" : "worse";
}

export function formatTile(unit: Tile["unit"], value: number | null): string {
  if (value === null) return "—";
  return unit === "pct" ? `${Math.round(value * 100)}%` : `${Math.round(value / 1000)}s`;
}

// ---------------------------------------------------------------------------
// Where it hurts

export type PainStatus = "none" | "working" | "shipped";
export type FixVerdict = "too_early" | "working" | "still";

export interface Count {
  hits: number;
  n: number;
}

export interface PainRow {
  key: string;
  name: string;
  theme: ThemeRow;
  status: PainStatus;
  /** Scored conversations in the last `PAIN_DAYS` that hit it, and when it was last seen. */
  hits: number;
  lastSeen: number | null;
  /** Hits per day, oldest first, `PAIN_DAYS` long. */
  strip: number[];
  /** The review notes and bug reports the triage agent filed under it. */
  reports: { path: string; at: number | null; kind: "review" | "bug" }[];
  before: Count | null;
  since: Count | null;
  verdict: FixVerdict | null;
  isNew: boolean;
}

const SHIPPED = new Set(["shipped", "fixed", "merged", "done"]);
const RETIRED = new Set(["retired", "wontfix", "dropped"]);

export function painStatusOf(theme: ThemeRow): PainStatus | "retired" {
  const status = theme.status.toLowerCase();
  if (RETIRED.has(status)) return "retired";
  if (SHIPPED.has(status)) return "shipped";
  if (theme.fixThread !== null || theme.prs.length > 0 || status !== "open") return "working";
  return "none";
}

/** Whether one scored conversation is a case of the problem: a matching signal, in a task it names (any, if none). */
export function hitsTheme(theme: Pick<ThemeRow, "signals" | "tasks">, row: TexReview): boolean {
  return theme.signals.some((code) => row.signals.includes(code)) && inScope(theme, row);
}

function inScope(theme: Pick<ThemeRow, "tasks">, row: TexReview): boolean {
  return theme.tasks.length === 0 || (row.task !== null && theme.tasks.includes(row.task));
}

/** Before and since a fix: of the conversations where it could have happened, how many it did. */
export function beforeAndSince(theme: ThemeRow, rows: readonly TexReview[], now: number): { before: Count; since: Count; verdict: FixVerdict } | null {
  if (theme.merged === null || theme.signals.length === 0) return null;
  const scoped = rows.filter((row) => isCoded(row) && inScope(theme, row));
  const count = (span: Span): Count => {
    const those = scoped.filter(inSpan(span));
    return { hits: those.filter((row) => hitsTheme(theme, row)).length, n: those.length };
  };
  const before = count({ from: theme.merged - PAIN_DAYS * DAY, to: theme.merged });
  const since = count({ from: theme.merged, to: now });
  let verdict: FixVerdict = "still";
  if (since.n < MIN_SINCE_N || before.n === 0) verdict = "too_early";
  else if (since.hits / since.n <= before.hits / before.n / 2) verdict = "working";
  return { before, since, verdict };
}

const STATUS_ORDER: Record<PainStatus, number> = { none: 0, working: 1, shipped: 2 };

export function painRowsOf(desk: TriageDesk | null, rows: readonly TexReview[], now: number): PainRow[] {
  if (desk === null) return [];
  const recent: Span = { from: now - PAIN_DAYS * DAY, to: now };
  const dayStart = Math.floor(now / DAY) * DAY;
  const out: PainRow[] = [];
  for (const theme of desk.themes) {
    const status = painStatusOf(theme);
    if (status === "retired") continue;
    const hitRows = rows.filter((row) => isCoded(row) && inSpan(recent)(row) && hitsTheme(theme, row));
    const reports = [
      ...desk.reviews.filter((review) => review.theme === theme.slug).map((review) => ({ path: review.path, at: review.reviewed, kind: "review" as const })),
      ...desk.bugs.filter((bug) => bug.theme === theme.slug).map((bug) => ({ path: bug.path, at: bug.filed, kind: "bug" as const })),
    ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    const strip = Array.from({ length: PAIN_DAYS }, () => 0);
    for (const row of hitRows) {
      const index = PAIN_DAYS - 1 - Math.floor((dayStart - Math.floor(row.at / DAY) * DAY) / DAY);
      if (index >= 0 && index < PAIN_DAYS) strip[index] = (strip[index] ?? 0) + 1;
    }
    const seen = [...hitRows.map((row) => row.at), ...reports.map((report) => report.at ?? 0)];
    const judged = status === "shipped" ? beforeAndSince(theme, rows, now) : null;
    out.push({
      key: theme.slug,
      name: theme.name,
      theme,
      status,
      hits: theme.signals.length === 0 ? reports.filter((report) => (report.at ?? 0) > recent.from).length : hitRows.length,
      lastSeen: seen.length === 0 ? null : Math.max(...seen),
      strip,
      reports,
      before: judged?.before ?? null,
      since: judged?.since ?? null,
      verdict: judged?.verdict ?? null,
      isNew: theme.firstSeen !== null ? theme.firstSeen > now - 7 * DAY : false,
    });
  }
  return out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.hits - a.hits || (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/** Frustration signals in the window that no named problem covers yet, most first. */
export function untriagedSignals(desk: TriageDesk | null, rows: readonly TexReview[], now: number): { code: string; label: string; n: number }[] {
  const covered = new Set((desk?.themes ?? []).filter((theme) => painStatusOf(theme) !== "retired").flatMap((theme) => theme.signals));
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isCoded(row) || row.at <= now - PAIN_DAYS * DAY) continue;
    for (const code of row.signals) if (!covered.has(code)) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return [...counts.entries()].map(([code, n]) => ({ code, label: SIGNAL_LABELS[code] ?? code, n })).sort((a, b) => b.n - a.n);
}

export interface Verdict {
  next: { name: string; detail: string; theme: ThemeRow | null; signal: string | null } | null;
  checks: { key: string; text: string; tone: "good" | "warn" | "bad" }[];
}

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };
export const shortDate = (at: number) => new Date(at).toLocaleDateString("en-US", SHORT_DATE);
const chats = (n: number) => `${n} ${n === 1 ? "chat" : "chats"}`;

/** The top of the page: the one thing to do next, and what to keep an eye on. */
export function verdictOf(pain: readonly PainRow[], untriaged: readonly { code: string; label: string; n: number }[], tiles: readonly Tile[]): Verdict {
  const open = pain.find((row) => row.status === "none");
  let next: Verdict["next"] = null;
  if (open !== undefined) {
    next = { name: open.name, detail: `${chats(open.hits)} in ${PAIN_DAYS} days, and nobody is fixing it yet.`, theme: open.theme, signal: null };
  } else if (untriaged[0] !== undefined) {
    next = { name: untriaged[0].label, detail: `${chats(untriaged[0].n)} in ${PAIN_DAYS} days, and no problem is named for it yet.`, theme: null, signal: untriaged[0].code };
  }
  const checks: Verdict["checks"] = [];
  for (const row of pain) {
    if (row.status !== "shipped" || row.before === null || row.since === null || row.verdict === null) continue;
    const prs = row.theme.prs.map((pr) => `#${pr}`).join(" ");
    const base = `${prs === "" ? row.name : `${prs} ${row.name}`}: ${row.before.hits} of ${row.before.n} before, ${row.since.hits} of ${row.since.n} since.`;
    const tail = row.verdict === "too_early" ? ` Too early, ${Math.max(0, MIN_SINCE_N - row.since.n)} more to judge.` : row.verdict === "working" ? " Working." : " Still happening.";
    checks.push({ key: row.key, text: base + tail, tone: row.verdict === "working" ? "good" : row.verdict === "still" ? "bad" : "warn" });
  }
  for (const tile of tiles) {
    if (directionOf(tile) !== "worse") continue;
    checks.push({ key: tile.key, text: `${tile.label} got worse: ${formatTile(tile.unit, tile.value)}, from ${formatTile(tile.unit, tile.before)}.`, tone: "bad" });
  }
  return { next, checks: checks.slice(0, 4) };
}

// ---------------------------------------------------------------------------
// Getting better, day by day

export interface Series {
  key: string;
  title: string;
  now: string;
  values: (number | null)[];
  /** Conversations behind each day, where a day's dot is sized by them. */
  weights: number[] | null;
  /** Draw a line through the days, or only dots while it is too thin to. */
  line: boolean;
  target: number;
  better: "up" | "down";
  top: number;
  foot: string;
}

export interface Marker {
  day: string;
  label: string;
}

/** Shipped fixes inside the days drawn, from the triage agent's theme notes. */
export function markersOf(desk: TriageDesk | null, days: readonly string[]): Marker[] {
  if (desk === null || days.length === 0) return [];
  const first = days[0]!;
  const last = days[days.length - 1]!;
  return desk.themes
    .filter((theme) => theme.merged !== null)
    .map((theme) => ({ day: new Date(theme.merged!).toISOString().slice(0, 10), label: `${theme.prs.map((pr) => `#${pr}`).join(" ")} ${theme.name}`.trim() }))
    .filter((marker) => marker.day >= first && marker.day <= last)
    .sort((a, b) => a.day.localeCompare(b.day));
}

export function seriesOf(report: TexReport, rows: readonly TexReview[]): Series[] {
  const days = report.turns.byDay.map((day) => day.day);
  const troubled = report.turns.byDay.map((day) => (day.turns === 0 ? null : day.troubled / day.turns));
  const p95 = report.turns.byDay.map((day, index) => (day.turns === 0 ? null : (report.performance.daily[index]?.p95 ?? null)));
  const coded = rows.filter(isCoded);
  const byDay = new Map<string, TexReview[]>();
  for (const row of coded) {
    const day = new Date(row.at).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  const success = days.map((day) => share(byDay.get(day) ?? [], isSuccess));
  const weights = days.map((day) => byDay.get(day)?.length ?? 0);
  const lastOf = (values: (number | null)[]) => [...values].reverse().find((value) => value !== null) ?? null;
  const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
  const secs = (value: number | null) => (value === null ? "—" : `${Math.round(value / 1000)}s`);
  return [
    {
      key: "troubled",
      title: "Replies that went wrong",
      now: `${pct(lastOf(troubled))} · target under ${pct(TARGETS.troubled)}`,
      values: troubled,
      weights: null,
      line: true,
      target: TARGETS.troubled,
      better: "down",
      top: Math.max(0.2, ...troubled.map((value) => value ?? 0)),
      foot: "Every reply Tex sent: no answer, or a tool failed.",
    },
    {
      key: "p95",
      title: "Slowest 1 in 20 replies",
      now: `${secs(lastOf(p95))} · target under ${secs(TARGETS.p95Ms)}`,
      values: p95,
      weights: null,
      line: true,
      target: TARGETS.p95Ms,
      better: "down",
      top: Math.max(120_000, ...p95.map((value) => value ?? 0)),
      foot: "How long the slow replies took, each day.",
    },
    {
      key: "success",
      title: "Got what they wanted",
      now: coded.length < MIN_RATE_N ? `${coded.length} scored · line starts at ${MIN_RATE_N}` : `${pct(lastOf(success))} · target ${pct(TARGETS.success)}`,
      values: success,
      weights,
      line: coded.length >= MIN_RATE_N,
      target: TARGETS.success,
      better: "up",
      top: 1,
      foot: `Scored chats since ${shortDate(CODES_BEGAN)}, one dot a day, sized by chats.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Bugs and money

/** Reports filed per day over the report's days, and how many are still waiting on someone. */
export function bugsByDay(bugs: readonly BugRow[], days: readonly string[]): number[] {
  const counts = new Map<string, number>();
  for (const bug of bugs) {
    if (bug.filed === null) continue;
    const day = new Date(bug.filed).toISOString().slice(0, 10);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return days.map((day) => counts.get(day) ?? 0);
}

export const BUG_STATUSES = ["open", "triage", "fixing", "fixed", "retired"] as const;

export function bugStatusOf(status: string): (typeof BUG_STATUSES)[number] {
  const lower = status.toLowerCase();
  if ((BUG_STATUSES as readonly string[]).includes(lower)) return lower as (typeof BUG_STATUSES)[number];
  if (SHIPPED.has(lower)) return "fixed";
  if (RETIRED.has(lower)) return "retired";
  return "open";
}

const TEXT_JOBS = new Set(["texts", "texts-group"]);

/** Billed spend per text Tex answered, and the share that went on everything else. */
export function costOf(report: TexReport, spend: TexSpend | undefined, days: number): { perText: number | null; textsUsd: number; otherUsd: number; testsUsd: number; texts: number; billed: boolean } {
  const texts = report.turns.byDay.slice(-days).reduce((sum, day) => sum + day.texts, 0);
  if (spend === undefined || !spend.configured || spend.error !== null) {
    const usd = report.turns.byDay.slice(-days).reduce((sum, day) => sum + day.costMicroUsd, 0) / 1_000_000;
    return { perText: texts === 0 ? null : usd / texts, textsUsd: usd, otherUsd: 0, testsUsd: 0, texts, billed: false };
  }
  const textsUsd = spend.jobs.filter((job) => TEXT_JOBS.has(job.job)).reduce((sum, job) => sum + job.usd, 0);
  const otherUsd = Math.max(0, spend.totalUsd - spend.testsUsd - textsUsd);
  return { perText: texts === 0 ? null : textsUsd / texts, textsUsd, otherUsd, testsUsd: spend.testsUsd, texts, billed: true };
}

export const taskLabel = (task: string) => TASK_LABELS[task] ?? task;
