/**
 * What a sync run may write into a dataset sheet (stage E of
 * `docs/decisions/data-and-metrics.md`). Pure: the sync object reads the
 * sheet, calls `mergeSynced`, and writes the text it returns, or nothing.
 *
 * - Rows are matched by a key column (a pull request's number, a charge's
 *   id), so a run that sees a row again changes it in place instead of
 *   adding it twice.
 * - A dataset keeps a rolling `KEEP_DAYS` (400) by its date column; older
 *   rows are dropped. A row whose date cannot be read is kept: the sync never
 *   guesses a row away.
 * - A result past `MAX_SHEET_ROWS` or `MAX_SHEET_BYTES` writes nothing and
 *   names the sheet (non-negotiable 2: a sheet that would not fit is held
 *   back and named, never cut short).
 */

import { cellText, dateMs, MAX_SHEET_BYTES, MAX_SHEET_ROWS, serializeSheet } from "../../sheets/csv.js";

export const KEEP_DAYS = 400;
const DAY_MS = 86_400_000;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

function rowOf(columns, source) {
  const row = Object.create(null);
  for (const column of columns) {
    row[column.name] = source && Object.hasOwn(source, column.name) ? cellText(source[column.name]) : "";
  }
  return row;
}

/**
 * Merge a run's rows into a dataset sheet.
 *
 * `sheet` is the parsed sheet (`{ columns, rows }`) or null for a new one;
 * `columns` the source's own columns, which win for a new sheet and must all
 * be present in an old one; `incoming` the rows the source read.
 *
 * → `{ ok: true, text, added, changed, dropped, rows }`, or
 *   `{ ok: false, refused }` with a plain sentence naming `path`.
 */
export function mergeSynced({ path, sheet, columns, incoming, key, dateColumn, now = Date.now(), keepDays = KEEP_DAYS }) {
  if (!Array.isArray(columns) || !columns.length) return { ok: false, refused: `${path} has no columns to write` };
  for (const column of columns) {
    if (!column || typeof column.name !== "string" || column.name.trim() === "" || RESERVED.has(column.name.trim().toLowerCase())) {
      return { ok: false, refused: `${path} has a column that can't be a name` };
    }
  }
  const names = new Set(columns.map((c) => c.name));
  if (!names.has(key) || !names.has(dateColumn)) return { ok: false, refused: `${path} needs its ${key} and ${dateColumn} columns` };

  const kept = sheet && Array.isArray(sheet.columns) && sheet.columns.length ? sheet.columns : columns;
  const keptNames = new Set(kept.map((c) => c.name));
  const missing = columns.filter((c) => !keptNames.has(c.name)).map((c) => c.name);
  if (missing.length) return { ok: false, refused: `${path} is missing the column ${missing.join(", ")}; it was changed by hand, so the sync left it alone` };

  const byKey = new Map();
  const order = [];
  for (const row of sheet?.rows ?? []) {
    const id = cellText(row?.[key]).trim();
    const copy = rowOf(kept, row);
    if (id === "") { order.push(copy); continue; }
    if (!byKey.has(id)) order.push(copy);
    byKey.set(id, copy);
  }
  let added = 0;
  let changed = 0;
  for (const source of Array.isArray(incoming) ? incoming : []) {
    const id = cellText(source?.[key]).trim();
    if (id === "") continue;
    const fresh = rowOf(kept, source);
    const old = byKey.get(id);
    if (!old) {
      byKey.set(id, fresh);
      order.push(fresh);
      added += 1;
      continue;
    }
    let different = false;
    for (const column of columns) {
      if (old[column.name] !== fresh[column.name]) { old[column.name] = fresh[column.name]; different = true; }
    }
    if (different) changed += 1;
  }

  const at = typeof now === "number" ? now : Date.parse(now);
  const cutoff = at - keepDays * DAY_MS;
  // Keyed rows may have been replaced in the map after `order` took them; read the live copy.
  const live = order.map((row) => { const id = cellText(row[key]).trim(); return id === "" ? row : byKey.get(id); });
  const unique = [...new Set(live)];
  const rows = unique.filter((row) => { const t = dateMs(row[dateColumn]); return !Number.isFinite(t) || t >= cutoff; });
  const dropped = unique.length - rows.length;
  rows.sort((a, b) => {
    const ta = dateMs(a[dateColumn]);
    const tb = dateMs(b[dateColumn]);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Number.isFinite(ta) ? -1 : Number.isFinite(tb) ? 1 : 0;
    return ta - tb;
  });

  if (rows.length > MAX_SHEET_ROWS) return { ok: false, refused: `${path} would pass ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows, so nothing was written` };
  const text = serializeSheet({ columns: kept, rows });
  if (new TextEncoder().encode(text).byteLength > MAX_SHEET_BYTES) return { ok: false, refused: `${path} would pass 5 MB, so nothing was written` };
  return { ok: true, text, added, changed, dropped, rows: rows.length };
}
