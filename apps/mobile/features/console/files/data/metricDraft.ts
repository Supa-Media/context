/**
 * The metric builder's draft (boards 04 and 04b): a name, a formula, a period and a format, written as one metric
 * note in the data folder's `metrics/`, and the column suggestions the formula box offers as a person types. Pure:
 * the text, the path and the suggestions, never a write.
 *
 * The note is the metric (`docs/decisions/data-and-metrics.md`): its front matter is everything the engine reads,
 * and its body is the formula's plain reading, so anyone can check it. No value is written anywhere.
 */

import { FUNCTIONS, parseFormula, plainReading } from "../../../../../mcp/src/data/formula/index.js";
import { freePath, slugOf } from "./dataWrites";
import type { DataSource } from "./sources";
import type { Sheet } from "./workOut";

/** The periods the builder offers, as `every:` says them. Others (`6 hours`, `30 days`) are written by hand. */
export const BUILDER_PERIODS = ["hour", "day", "week", "month"] as const;
export type BuilderPeriod = (typeof BUILDER_PERIODS)[number];

/** How a value is shown, as the builder offers it: the engine's plain number first. */
export const BUILDER_FORMATS = ["", "0", "0.0", "0%", "$0", "$0.00", "duration", "0.0k"] as const;

export interface MetricDraft {
  readonly name: string;
  readonly formula: string;
  readonly every: string;
  readonly format: string;
}

/**
 * One front matter value on one line, quoted so the app (which drops the quotes) and the gateway (which reads a
 * double-quoted value as JSON) read the same text: in double quotes when it holds no `"` or `\\`, else in single
 * quotes when it holds no `'`. Null for text holding both kinds of quote, which no quoting reads the same in both.
 */
export function frontValue(value: string): string | null {
  const line = value.replace(/\s+/g, " ").trim();
  if (!/["\\]/.test(line)) return `"${line}"`;
  if (!line.includes("'")) return `'${line}'`;
  return null;
}

/** The note a draft is saved as: front matter the engine reads, and the formula's plain reading under it. */
export function metricNoteText(draft: MetricDraft): string {
  const parsed = parseFormula(draft.formula) as { ok: boolean; ast?: unknown };
  const reading = parsed.ok ? `${plainReading(parsed.ast, draft.every)}.` : "Say in plain words what this counts, so anyone can check the formula.";
  return [
    "---",
    `metric: ${frontValue(draft.name) ?? '"New metric"'}`,
    `formula: ${frontValue(draft.formula) ?? '""'}`,
    `every: ${builderPeriod(draft.every)}`,
    ...(draft.format.trim() === "" ? [] : [`format: ${frontValue(draft.format) ?? '""'}`]),
    "---",
    "",
    reading,
    "",
  ].join("\n");
}

/** Where a draft is saved: `<metrics>/<name as a slug>.md`, or `-2` and on when taken. */
export function metricPathFor(metricsFolder: string, name: string, taken: ReadonlySet<string>): string {
  return freePath(metricsFolder, slugOf(name) || "new-metric", ".md", taken);
}

/** Why a draft can't be saved yet, in plain words; null when it can. */
export function draftProblem(draft: MetricDraft): string | null {
  if (draft.name.trim() === "") return "Give it a name.";
  if (draft.formula.trim() === "") return "Write its formula.";
  if (frontValue(draft.name) === null || frontValue(draft.formula) === null || frontValue(draft.format) === null) return "Use one kind of quote, \" or ', not both.";
  const parsed = parseFormula(draft.formula) as { ok: boolean; error?: { message: string } };
  return parsed.ok ? null : (parsed.error?.message ?? "The formula could not be read.");
}

/** One column the formula box offers: `insert` is what replaces the word being typed. */
export interface ColumnSuggestion {
  readonly source: DataSource;
  readonly dataset: string;
  readonly column: string;
  readonly type: string;
  readonly insert: string;
}

const MAX_SUGGESTIONS = 8;
/** Words the formula already means something by: a suggestion for them would swallow what was typed. */
const WORDS = new Set<string>([...(FUNCTIONS as readonly string[]), "where", "and"]);

/** A column as a formula writes it: as words when it is plain, in quotes when it holds anything else. */
export function columnWords(column: string): string {
  if (/^[A-Za-z0-9_]+(?:[ -][A-Za-z0-9_]+)*$/.test(column)) return column;
  return column.includes('"') ? `'${column}'` : `"${column}"`;
}

/** The word the caret is in or just after: from the last space, bracket, operator or comma before it. */
export function wordAt(formula: string, caret: number): { from: number; word: string } {
  const before = formula.slice(0, Math.max(0, Math.min(caret, formula.length)));
  // A word may hold `-`, `/` and `.` (`cloudflare/ai-spend.usd`), but never starts with one: `)-co` is a minus, then `co`.
  const word = (/[A-Za-z0-9_./-]*$/.exec(before)?.[0] ?? "").replace(/^[-./]+/, "");
  return { from: before.length - word.length, word };
}

/**
 * The columns that fit the word being typed: with a dot (`cloudflare/ai-spend.us`), that dataset's columns starting
 * with what follows it; otherwise every column whose source, dataset or name holds the word. Nothing for an empty
 * word, a function name already typed in full, or a number.
 */
export function columnSuggestions(sources: readonly DataSource[], sheets: ReadonlyMap<string, Sheet | null>, word: string): ColumnSuggestion[] {
  const typed = word.trim().toLowerCase();
  if (typed === "" || /^\d/.test(typed) || WORDS.has(typed)) return [];
  const out: ColumnSuggestion[] = [];
  const dot = typed.lastIndexOf(".");
  for (const source of sources) {
    for (const dataset of source.datasets) {
      const sheet = sheets.get(dataset.path);
      if (!sheet) continue;
      const name = `${source.slug}/${dataset.name}`.toLowerCase();
      for (const column of sheet.columns) {
        const col = column.name.toLowerCase();
        const fits = dot >= 0 ? typed.slice(0, dot) === name && col.startsWith(typed.slice(dot + 1)) : name.includes(typed) || col.includes(typed);
        if (!fits) continue;
        out.push({ source, dataset: dataset.name, column: column.name, type: column.type, insert: `${source.slug}/${dataset.name}.${columnWords(column.name)}` });
        if (out.length >= MAX_SUGGESTIONS) return out;
      }
    }
  }
  return out;
}

/** The formula with the word at the caret replaced by a suggestion, and where the caret goes after it. */
export function insertSuggestion(formula: string, caret: number, suggestion: ColumnSuggestion): { formula: string; caret: number } {
  const { from } = wordAt(formula, caret);
  const end = Math.max(caret, from);
  const next = `${formula.slice(0, from)}${suggestion.insert}${formula.slice(end)}`;
  return { formula: next, caret: from + suggestion.insert.length };
}

/** The period a draft starts with: the note's `every` when it is one the builder offers, else month. */
export function builderPeriod(every: string): BuilderPeriod {
  const word = every.trim().toLowerCase();
  return (BUILDER_PERIODS as readonly string[]).includes(word) ? (word as BuilderPeriod) : "month";
}

/** What the builder's preview says beside its value and over its chart: "this month, so far", "Last 6 months". */
export function previewWords(every: string, periods: number): { now: string; span: string } {
  const unit = builderPeriod(every);
  return { now: `this ${unit}, so far`, span: `Last ${periods} ${unit}s` };
}
