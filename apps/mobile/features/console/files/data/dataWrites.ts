/**
 * What the Data page's two buttons write: a metric note from a template, and
 * a push source's folder (its about.md and its one dataset). Pure: the text
 * and the paths, never a write.
 *
 * Nothing written here carries a value or a credential. A metric note's body
 * is a plain reading for a person to fill in; a push source's key is made
 * afterwards by the sheet's own key flow and kept in the control plane, never
 * in a file (`docs/decisions/app-and-console/sheet-sources.md`).
 */

import { parseHeaderCell, renderHeaderCell } from "../../../../../mcp/src/sheets/csv.js";
import type { DataSource } from "./sources";
import type { Sheet } from "./workOut";

/** "Eval CI" → `eval-ci`; "" when nothing usable is left. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** `<folder>/<base><ext>`, or `<base>-2<ext>` and on, whichever is not taken. */
export function freePath(folder: string, base: string, ext: string, taken: ReadonlySet<string>): string {
  const at = (name: string) => `${folder}/${name}${ext}`;
  if (!taken.has(at(base))) return at(base);
  for (let n = 2; n < 1000; n += 1) if (!taken.has(at(`${base}-${n}`))) return at(`${base}-${n}`);
  return at(`${base}-${Date.now()}`);
}

/** A formula to start from: a count over the first sheet this reader has, else a shape to fill in. */
export function startingFormula(sources: readonly DataSource[], sheets: ReadonlyMap<string, Sheet | null>): string {
  for (const source of sources) {
    for (const dataset of source.datasets) {
      const column = sheets.get(dataset.path)?.columns[0]?.name;
      if (column !== undefined && /^[a-z0-9 _-]+$/i.test(column) && /^[a-z0-9_-]+$/i.test(source.slug) && /^[a-z0-9_-]+$/i.test(dataset.name)) {
        return `count(${source.slug}/${dataset.name}.${column})`;
      }
    }
  }
  return "count(source/dataset.column)";
}

/** A new metric note: its name, formula, period and format in front matter, and a line asking for its plain reading. */
export function newMetricText(formula: string): string {
  return [
    "---",
    "metric: New metric",
    `formula: ${JSON.stringify(formula)}`,
    "every: week",
    "---",
    "",
    "Say in plain words what this counts, so anyone can check the formula. A value is never written here: it is worked out when the metric is read.",
    "",
  ].join("\n");
}

/** The columns a person typed, `suite, p95 ms:number`, as header cells, with a date column first when they named none. */
export function datasetHeader(typed: string): string {
  const columns = typed
    .split(",")
    .map((cell) => cell.trim())
    .filter((cell) => cell !== "")
    .map((cell) => parseHeaderCell(cell) as { name: string; type: string });
  const seen = new Set<string>();
  const unique = columns.filter((column) => {
    const key = column.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!unique.some((column) => column.type === "date")) unique.unshift({ name: "date", type: "date" });
  return `${unique.map((column) => renderHeaderCell(column) as string).join(",")}\n`;
}

export interface PushSourceFiles {
  readonly folder: string;
  readonly about: { readonly path: string; readonly text: string };
  readonly sheet: { readonly path: string; readonly text: string };
}

/** A push source's folder: `<data>/<slug>/about.md` saying `source: push`, and its one dataset. */
export function pushSourceFiles(dataFolder: string, name: string, dataset: string, columns: string, taken: ReadonlySet<string>): PushSourceFiles | string {
  const slug = slugOf(name);
  const sheetSlug = slugOf(dataset);
  if (slug === "" || slug === "metrics") return "Give the source a name with a letter or a number in it.";
  if (sheetSlug === "") return "Give the dataset a name with a letter or a number in it.";
  const folder = `${dataFolder}/${slug}`;
  if ([...taken].some((path) => path === folder || path.startsWith(`${folder}/`))) return `There is already a source called ${slug}.`;
  const display = name.replace(/[\r\n]+/g, " ").trim();
  return {
    folder,
    about: {
      path: `${folder}/about.md`,
      text: [
        "---",
        "source: push",
        `name: ${JSON.stringify(display)}`,
        "---",
        "",
        "Rows sent from your code. Anything with a key can add rows here; nothing can read them back with it.",
        "",
      ].join("\n"),
    },
    sheet: { path: `${folder}/${sheetSlug}.csv`, text: datasetHeader(columns) },
  };
}
