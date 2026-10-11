/**
 * The Agent tab's arithmetic and words: what the turn log's figures say, in
 * a sentence a person reads without knowing the tool ids.
 *
 * Pure functions, like `./report`, so every number on the tab is checked in
 * `__tests__/adminAgent.test.ts` without mounting anything.
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { shortDay } from "./report";

export type AgentReport = FunctionReturnType<typeof api.functions.admin.agentReport>;
export type AgentTurnRow = AgentReport["recent"][number];
export type AgentTraceStep = AgentTurnRow["trace"][number];
export type AgentOutcome = AgentTurnRow["outcome"];
export type AgentClient = AgentReport["client"];

export const AGENT_CLIENTS: readonly { key: AgentClient; label: string }[] = [
  { key: "all", label: "All" },
  { key: "texts", label: "Texts" },
  { key: "app", label: "App" },
];

export const AGENT_WINDOWS: readonly { key: "1" | "7" | "30"; label: string }[] = [
  { key: "1", label: "24 hours" },
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
];

/** How long the turn log keeps a row (`agentTurns`' retention sweep). */
export const TURN_RETENTION_DAYS = 30;

/** `4.2 s`, `42 s`, `1 m 12 s`; a dash for nothing measured. */
export function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}

function periodBefore(days: number): string {
  return days === 1 ? "the day before" : `the ${days} days before`;
}

/**
 * A time against the window before, as a sentence and a tone: faster is good
 * news, slower is bad. Under a twentieth of a second is the same.
 */
export function timeChange(
  current: number,
  prior: number,
  priorTurns: number,
  days: number,
): { text: string; tone: "ok" | "crit" | "neutral" } {
  if (priorTurns === 0 || current === 0) return { text: `Nothing to compare with ${periodBefore(days)}`, tone: "neutral" };
  const diff = current - prior;
  if (Math.abs(diff) < 50) return { text: `Same as ${periodBefore(days)}`, tone: "neutral" };
  const amount = formatSeconds(Math.abs(diff));
  return diff < 0
    ? { text: `${amount} faster than ${periodBefore(days)}`, tone: "ok" }
    : { text: `${amount} slower than ${periodBefore(days)}`, tone: "crit" };
}

/** `+12 vs the 7 days before`. */
export function countChange(current: number, prior: number, days: number): string {
  const diff = current - prior;
  const signed = diff > 0 ? `+${diff}` : diff < 0 ? `−${Math.abs(diff)}` : "±0";
  return `${signed} vs ${periodBefore(days)}`;
}

/** A whole percentage of a total, zero when there is no total. */
export function percentOf(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/**
 * Where a window's time went. `Other` is what neither the model nor a tool
 * accounts for (reading the connection, writing the reply), never negative.
 */
export function timeShares(current: AgentReport["current"]): { key: string; label: string; ms: number; percent: number }[] {
  const other = Math.max(0, current.totalMs - current.modelMs - current.toolMs);
  const total = current.modelMs + current.toolMs + other;
  return [
    { key: "thinking", label: "Thinking (the model)", ms: current.modelMs },
    { key: "lookups", label: "Looking things up (tools)", ms: current.toolMs },
    { key: "other", label: "Other", ms: other },
  ].map((share) => ({ ...share, percent: percentOf(share.ms, total) }));
}

const TOOL_LABELS: Record<string, string> = {
  orient: "Get oriented",
  search: "Search",
  search_notes: "Search notes",
  read_note: "Read a note",
  list_notes: "List notes",
  list_changes: "Recent changes",
  read_activity: "Read activity",
  list_meetings: "List meetings",
  read_meeting: "Read a meeting",
  list_contacts: "List contacts",
  read_contact: "Read a contact",
  read_image: "Look at an image",
  fetch: "Fetch a note",
  scope_info: "Check access",
  propose_note: "Suggest a note",
  write_note: "Write a note",
  archive_note: "Archive a note",
  search_web: "Search the web",
  open_page: "Open a page",
};

/** A tool's name for a person; one with no entry is its id, spaced and capitalised. */
export function toolLabel(tool: string): string {
  const known = TOOL_LABELS[tool];
  if (known) return known;
  const spaced = tool.replace(/[_-]+/g, " ").trim();
  return spaced === "" ? tool : spaced[0].toUpperCase() + spaced.slice(1);
}

export function outcomeLabel(outcome: AgentOutcome): string {
  return outcome === "answered" ? "Answered" : outcome === "exhausted" ? "Ran out of steps" : "Failed";
}

export function outcomeTone(outcome: AgentOutcome): "ok" | "warn" | "crit" {
  return outcome === "answered" ? "ok" : outcome === "exhausted" ? "warn" : "crit";
}

export function clientLabel(client: "texts" | "app"): string {
  return client === "texts" ? "Texts" : "App";
}

/** A bucket's label under the chart: `7 Oct` for a day, `14:00` for an hour. */
export function bucketLabel(label: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(label) ? shortDay(label) : label;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function clock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** `14:02` today, `6 Oct, 14:02` before it. */
export function whenLabel(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? clock(date) : `${date.getDate()} ${MONTHS[date.getMonth()]}, ${clock(date)}`;
}

/** The day the log drops a turn. */
export function keptUntil(at: number): string {
  const date = new Date(at + TURN_RETENTION_DAYS * 86_400_000);
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export interface WaterfallStep extends AgentTraceStep {
  label: string;
  /** Where the bar starts and how wide it is, as percentages of the axis. */
  left: number;
  width: number;
}

/**
 * A turn's steps on one time axis.
 *
 * The turn runs its steps one after another (`turn.js` awaits each tool call
 * in order), so each starts where the one before ended. The axis is the whole
 * answer time, so what no step accounts for shows as space at the end rather
 * than being stretched into the bars.
 */
export function waterfall(turn: Pick<AgentTurnRow, "ms" | "trace">): WaterfallStep[] {
  const sum = turn.trace.reduce((total, step) => total + Math.max(0, step.ms), 0);
  const axis = Math.max(turn.ms, sum, 1);
  let start = 0;
  return turn.trace.map((step) => {
    const ms = Math.max(0, step.ms);
    const entry: WaterfallStep = {
      ...step,
      label: step.kind === "model" ? "Thinking" : toolLabel(step.tool ?? "tool"),
      left: (start / axis) * 100,
      width: (ms / axis) * 100,
    };
    start += ms;
    return entry;
  });
}

/**
 * The slowest step and one sentence about it, against that tool's typical
 * time over the window when the tab has one.
 */
export function slowestStep(
  trace: readonly AgentTraceStep[],
  typical: ReadonlyMap<string, number>,
): { index: number; sentence: string } | null {
  if (trace.length === 0) return null;
  let index = 0;
  trace.forEach((step, at) => {
    if (step.ms > trace[index].ms) index = at;
  });
  const step = trace[index];
  if (step.ms <= 0) return null;
  const took = formatSeconds(step.ms);
  if (step.kind === "model") return { index, sentence: `A thinking round was the slowest step, at ${took}.` };
  const name = toolLabel(step.tool ?? "tool");
  const usual = step.tool ? typical.get(step.tool) : undefined;
  if (usual === undefined || usual <= 0) return { index, sentence: `${name} was the slowest step, at ${took}.` };
  const ratio = step.ms / usual;
  if (ratio >= 1.5) {
    return { index, sentence: `${name} took ${took} here, about ${Math.round(ratio * 10) / 10}× its typical ${formatSeconds(usual)}.` };
  }
  return { index, sentence: `${name} took ${took} here, close to its typical ${formatSeconds(usual)}.` };
}

/** The tiny strip on a recent row: each step's share of the turn, in order. */
export function stepStrip(turn: Pick<AgentTurnRow, "ms" | "trace">): { kind: "model" | "tool"; ok: boolean; width: number }[] {
  return waterfall(turn).map((step) => ({ kind: step.kind, ok: step.ok, width: step.width }));
}
