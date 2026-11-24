/**
 * Changing a sheet's rows: `write` action `rows` (`write_note` with `rows`).
 *
 * The rows are changed in the text and the whole sheet is saved through
 * `toolWriteNote`, so every check a note's save makes (who may write here, the
 * folder's tier, the etag, the audit line) is the one that holds for a sheet;
 * nothing here decides access. A change that does not fit the sheet's types is
 * refused whole (`changeRows`), and nothing is written.
 *
 * An append that loses a race is read again and tried once more: appends from
 * two agents both land. An update or delete never retries, since what it
 * matched may have changed; it carries the etag the caller read when given one.
 */

import { toolError, toolText } from "../results.js";
import { normalizePath } from "../../notes/paths.js";
import { canSee } from "../../privacy/engine.js";
import { getWithLegacyFallback } from "../../storageLayout.js";
import { changeRows, isSheetPath, parseSheet, serializeSheet } from "../../sheets/csv.js";
import { toolWriteNote } from "./write.js";

const MAX_APPEND = 500;

function rowsProblem(rows) {
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) return "rows must be an object: { append: [{...}] }, { update: { match, set } } or { delete: { match } }";
  const known = new Set(["append", "update", "delete"]);
  const extra = Object.keys(rows).filter((k) => !known.has(k));
  if (extra.length) return `rows takes append, update and delete, not ${extra.join(", ")}`;
  if (rows.append !== undefined && (!Array.isArray(rows.append) || rows.append.some((r) => !r || typeof r !== "object" || Array.isArray(r)))) {
    return "rows.append is a list of rows, each { column: value }";
  }
  if ((rows.append?.length ?? 0) > MAX_APPEND) return `at most ${MAX_APPEND} rows are appended in one call`;
  if (rows.append === undefined && rows.update === undefined && rows.delete === undefined) return "rows needs append, update or delete";
  return null;
}

const etagLine = (result) => /^etag: (\S+)$/m.exec(result?.content?.map((p) => p.text).join("") ?? "")?.[1];

async function readSheet(store, scope, rules, overrides, path) {
  if (!canSee(path, scope, rules, overrides)) return null;
  const obj = await getWithLegacyFallback(store, path);
  if (!obj) return null;
  return { text: await obj.text(), etag: obj.etag };
}

export async function toolWriteSheetRows(store, scope, rules, overrides, args, options = {}) {
  const path = normalizePath(args.path);
  if (!path || !isSheetPath(path)) return toolError("rows changes a sheet: call it again with the path of a .csv file.");
  const problem = rowsProblem(args.rows);
  if (problem) return toolError(problem);
  const appendOnly = args.rows.update === undefined && args.rows.delete === undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readSheet(store, scope, rules, overrides, path);
    if (!current) return toolError("not found: save the sheet first with its header row (content \"date:date,value:number\\n\"), then add rows.");
    const sheet = parseSheet(current.text);
    if (sheet.tooLarge || sheet.errors.length) {
      const lines = sheet.errors.slice(0, 3).map((e) => `line ${e.line}: ${e.message}`).join("; ");
      return toolError(`fix the sheet with write save, then change rows again: it does not read back whole (${lines}).`);
    }
    const changed = changeRows(sheet, args.rows);
    if (!changed.ok) return toolError(`nothing was written: ${changed.errors.slice(0, 8).join("; ")}. Call it again with values that fit each column.`);
    const expected = attempt === 0 && typeof args.expected_etag === "string" ? args.expected_etag : current.etag;
    const saved = await toolWriteNote(store, scope, rules, overrides, {
      path,
      content: serializeSheet(changed.sheet),
      expected_etag: expected,
      ...(typeof args.summary === "string" ? { summary: args.summary } : {}),
    }, options);
    const conflicted = saved?.isError && /conflict|etag/i.test(saved.content?.map((p) => p.text).join("") ?? "");
    if (conflicted && appendOnly && attempt === 0 && args.expected_etag === undefined) continue;
    if (saved?.isError) return saved;
    const parts = [
      changed.appended ? `appended ${changed.appended}` : "",
      changed.updated !== undefined && args.rows.update ? `updated ${changed.updated}` : "",
      changed.deleted !== undefined && args.rows.delete ? `deleted ${changed.deleted}` : "",
    ].filter(Boolean);
    return toolText(`path: ${path}\netag: ${etagLine(saved) ?? ""}\nrows: ${changed.sheet.rows.length}\n\n${parts.join(", ") || "no change"}.`);
  }
  return toolError("conflict: the sheet kept changing while this was written; fetch it again, then try again.");
}
