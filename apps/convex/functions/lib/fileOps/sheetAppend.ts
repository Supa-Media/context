/**
 * Rows added to a sheet by a sheet source (`functions/sheetSources.ts`): the
 * one write a source key can make.
 *
 * Read, change, write, at the caller's clearance, through the same
 * `readFile` and `writeFile` every console save uses, so who may see and
 * write this path is decided there and nowhere else. The rows are checked
 * against the sheet's columns by the gateway's own sheet module, so a row the
 * app or an agent would refuse is refused here too, and a refusal writes
 * nothing.
 *
 * Append only. Nothing here updates or deletes a row, and the sheet's text
 * never goes back to the caller: a source may add to a sheet it cannot read.
 * An append that loses a race to another writer is read again and tried once
 * more, as the gateway's `rows` action does, so two sources sending at once
 * both land.
 */

// The gateway's sheet module, as the console's readers already import it: one definition of a row.
import { changeRows, isSheetPath, parseSheet, serializeSheet } from "../../../../mcp/src/sheets/csv.js";
import type { Clearance } from "../clearance";
import { FileOpError } from "./errors";
import { readFile } from "./reading";
import type { FileStore } from "./store";
import { writeFile } from "./writing";

/** The most rows one call adds. A source sends readings, not imports. */
export const MAX_SOURCE_ROWS = 100;

export interface SheetAppended {
  kind: "sheetAppended";
  path: string;
  etag: string;
  appended: number;
}

type Row = Record<string, string>;

interface Column {
  name: string;
  type: string;
}

/** Today as the sheet's `date` column writes it, in UTC. */
function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** A row with the sheet's `date` column filled with today when the sender left it out. */
function withDate(columns: readonly Column[], row: Row, now: number): Row {
  const date = columns.find((column) => column.name.toLowerCase() === "date");
  if (date === undefined) return row;
  const given = Object.keys(row).find((key) => key.toLowerCase() === "date");
  if (given !== undefined && String(row[given]).trim() !== "") return row;
  return { ...row, [date.name]: today(now) };
}

export async function appendSheetRows(
  store: FileStore,
  options: { path: string; rows: readonly Row[]; clearance: Clearance; now: number },
): Promise<SheetAppended> {
  if (!isSheetPath(options.path)) throw new FileOpError("NOT_A_SHEET", "A source adds rows to a sheet: a .csv file.");
  if (options.rows.length === 0) throw new FileOpError("SHEET_ROWS_REFUSED", "Send at least one row.");
  if (options.rows.length > MAX_SOURCE_ROWS) {
    throw new FileOpError("SHEET_ROWS_REFUSED", `Send at most ${MAX_SOURCE_ROWS} rows at a time.`);
  }

  for (let attempt = 0; ; attempt += 1) {
    const file = await readFile(store, { path: options.path, clearance: options.clearance });
    if (file.encrypted) throw new FileOpError("NOTE_ENCRYPTED", "This sheet is encrypted, so rows cannot be added to it.");
    const sheet = parseSheet(file.text) as { columns: Column[]; rows: Row[]; errors: unknown[]; tooLarge?: boolean };
    if (sheet.tooLarge === true || sheet.errors.length > 0) {
      throw new FileOpError("NOT_A_SHEET", "This sheet does not read back whole; open it in the app and fix it first.");
    }
    const rows = options.rows.map((row) => withDate(sheet.columns, row, options.now));
    const changed = (changeRows as (sheet: unknown, change: { append: Row[] }) => unknown)(sheet, { append: rows }) as
      | { ok: true; sheet: { columns: Column[]; rows: Row[] }; appended: number }
      | { ok: false; errors: string[] };
    if (!changed.ok) {
      // Column names and the sender's own values only: never another row of the sheet.
      throw new FileOpError("SHEET_ROWS_REFUSED", `Nothing was added: ${changed.errors.slice(0, 5).join("; ")}.`);
    }
    try {
      const written = await writeFile(store, {
        path: file.path,
        text: serializeSheet(changed.sheet),
        expectedEtag: file.etag,
        clearance: options.clearance,
        now: options.now,
      });
      return { kind: "sheetAppended", path: written.path, etag: written.etag, appended: changed.appended };
    } catch (error) {
      if (attempt === 0 && error instanceof FileOpError && error.code === "CONFLICT") continue;
      throw error;
    }
  }
}
