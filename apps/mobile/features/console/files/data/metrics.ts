/**
 * A workspace's metrics: one note each in the data folder's `metrics/`, its
 * front matter `metric` (the name), `formula`, `every` and `format`, and the
 * areas whose `about.md` names it (the data sources boards, 01, 11 and 12;
 * `docs/decisions/data-and-metrics.md`).
 *
 * Pure. The formula is parsed with the gateway's own engine
 * (`apps/mcp/src/data/formula`), so the app and every agent read one grammar.
 */

import { parseFormula } from "../../../../../mcp/src/data/formula/index.js";
import { isNotePath, withoutTextExtension } from "@context/shared/src/fileKinds.cjs";
import type { ListNote } from "../listBlock/model";
import { ABOUT_NOTE, baseName } from "../paths";
import { areaTitle, metricKey, metricsOf, PEOPLE_FOLDER } from "../folderPage/areas/seat";
import { textOf } from "./sources";

/** A parsed formula's tree, as `parse.js` builds it. */
export type FormulaTree =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "binary"; readonly op: "+" | "-" | "*" | "/"; readonly left: FormulaTree; readonly right: FormulaTree }
  | {
      readonly type: "agg";
      readonly fn: string;
      /** `count(distinct …)`: each filled value once. */
      readonly distinct?: true;
      readonly source: string;
      readonly dataset: string;
      readonly expr: FormulaTree;
      readonly where: readonly { readonly column: string; readonly op: "=" | "!="; readonly value: string }[];
    }
  | { readonly type: "ref"; readonly source: string; readonly dataset: string; readonly column: string };

export type ParsedFormula = { readonly ok: true; readonly ast: FormulaTree } | { readonly ok: false; readonly message: string };

export interface MetricNote {
  readonly path: string;
  /** The note's file name without `.md`: `revenue-per-ai-dollar`. */
  readonly slug: string;
  /** `metric:`, else the note's first heading, else its file name as words. */
  readonly name: string;
  readonly formula: string;
  /** `day`, `week`, `month` or `N days`; `week` when the note says none. */
  readonly every: string;
  /** A display format (`$0.00`), or "" for the engine's plain number. */
  readonly format: string;
  readonly parsed: ParsedFormula;
}

/** The period a note gets when it names none. */
export const DEFAULT_EVERY = "week";

export function parse(formula: string): ParsedFormula {
  const result = parseFormula(formula) as { ok: boolean; ast?: FormulaTree; error?: { message: string } };
  return result.ok && result.ast !== undefined ? { ok: true, ast: result.ast } : { ok: false, message: result.error?.message ?? "The formula could not be read." };
}

/** One note as a metric. */
export function metricOf(note: ListNote): MetricNote {
  const slug = withoutTextExtension(baseName(note.path));
  const formula = textOf(note.properties.formula);
  return {
    path: note.path,
    slug,
    name: textOf(note.properties.metric) || note.heading?.trim() || areaTitle(slug),
    formula,
    every: textOf(note.properties.every) || DEFAULT_EVERY,
    format: textOf(note.properties.format),
    parsed: parse(formula),
  };
}

/**
 * Every metric note directly in `metricsFolder`, in `order` (the folder's
 * listing, so they read as the sidebar does) and then by path.
 */
export function metricsIn(metricsFolder: string, notes: readonly ListNote[], order: readonly string[] = []): MetricNote[] {
  const prefix = `${metricsFolder}/`;
  const rank = new Map(order.map((path, at) => [path, at]));
  return notes
    .filter((note) => {
      if (!note.path.startsWith(prefix)) return false;
      const rest = note.path.slice(prefix.length);
      return !rest.includes("/") && isNotePath(rest) && rest !== ABOUT_NOTE;
    })
    .sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(metricOf);
}

/** Whether `path` is a metric note: a Markdown note directly in the data folder's `metrics/`. */
export function isMetricNotePath(path: string | null, dataFolder: string): boolean {
  if (path === null || dataFolder === "") return false;
  const prefix = `${dataFolder}/metrics/`;
  if (!path.startsWith(prefix)) return false;
  const rest = path.slice(prefix.length);
  return !rest.includes("/") && isNotePath(rest) && rest !== ABOUT_NOTE;
}

export interface Use {
  /** The area as drawn: its folder name as a title. */
  readonly area: string;
  readonly folder: string;
  /** Its target as written (`over $5`, `under 30 min`), or null. */
  readonly target: string | null;
}

/**
 * Which areas use which metric, by name as `metricKey` matches it: an area's `about.md`
 * names one in its `metrics:` line (`Revenue per AI dollar · target over $5`),
 * or with `metric:` and `target:` (`seat.ts`, `metricsOf`). Read from the
 * reader's own notes of the Areas folder.
 */
export function usesByMetric(areasFolder: string, notes: readonly ListNote[]): ReadonlyMap<string, readonly Use[]> {
  const out = new Map<string, Use[]>();
  const prefix = areasFolder === "" ? "" : `${areasFolder}/`;
  const people = `${prefix}${PEOPLE_FOLDER}/`;
  for (const note of notes) {
    if (!note.path.startsWith(prefix) || note.path.startsWith(people) || baseName(note.path) !== ABOUT_NOTE) continue;
    const folder = note.path.slice(0, -ABOUT_NOTE.length - 1);
    if (folder === areasFolder || folder === "") continue;
    // The seat's own reading: `metrics:` items, and a `metric:` with its `target:` first (`seat.ts`).
    const parsed = metricsOf(note.properties);
    for (const metric of parsed) {
      const key = metricKey(metric.name);
      if (key === "") continue;
      const list = out.get(key) ?? [];
      if (!list.some((use) => use.folder === folder)) list.push({ area: areaTitle(baseName(folder)), folder, target: metric.target });
      out.set(key, list);
    }
  }
  return out;
}

/** "Velocity", "Engineering and Finance", or null for a metric no area uses yet. */
export function usedByWords(uses: readonly Use[] | undefined): string | null {
  if (uses === undefined || uses.length === 0) return null;
  if (uses.length === 1) return uses[0]!.area;
  return `${uses.slice(0, -1).map((use) => use.area).join(", ")} and ${uses[uses.length - 1]!.area}`;
}
