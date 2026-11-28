/** Types for `sheetCsv.cjs` (the sheet functions); see that file for the format and the reasons. */

/** A column's type: one of `COLUMN_TYPES`, typed as a string because a header's type is read from text and may be any word. */
export type ColumnType = string;

export interface SheetColumn {
  name: string;
  type: ColumnType;
  wrap?: boolean;
  width?: number;
}

/** One row: every cell as its stored text, keyed by column name. */
export type SheetRow = Record<string, string>;

export interface Sheet {
  columns: SheetColumn[];
  rows: SheetRow[];
}

export interface SheetError {
  line: number;
  message: string;
  lossy?: boolean;
}

export interface ParsedSheet extends Sheet {
  errors: SheetError[];
  tooLarge: boolean;
}

export interface SheetFilter {
  column: string;
  op?: string;
  value?: unknown;
}

export type ChangeResult =
  | { ok: false; errors: string[]; sheet: Sheet }
  | { ok: true; errors: []; sheet: Sheet; appended: number; updated: number; deleted: number };

export declare const SHEET_EXTENSION: ".csv";
export declare const COLUMN_TYPES: readonly ColumnType[];
export declare const MAX_SHEET_BYTES: number;
export declare const MAX_SHEET_ROWS: number;
export declare const MIN_COLUMN_WIDTH: number;
export declare const MAX_COLUMN_WIDTH: number;
export declare const FILTER_OPS: readonly string[];
export declare function dateMs(value: unknown): number;
export declare function isSheetPath(path: unknown): boolean;
export declare function parseHeaderCell(cell: unknown): SheetColumn;
export declare function renderHeaderCell(column: Partial<SheetColumn>): string;
export declare function setColumnLayout(sheet: Sheet, name: string, options?: { wrap?: boolean; width?: number | null }): Sheet;
export declare function parseCsvRecords(text: unknown): { records: { line: number; cells: string[] }[]; unterminated: boolean };
export declare function cellText(value: unknown): string;
export declare function cellProblem(type: string, value: unknown): string;
export declare function typedValue(type: string, value: unknown): string | number | boolean;
export declare function parseSheet(text: unknown): ParsedSheet;
export declare function serializeSheet(sheet: Sheet): string;
export declare function splitOptions(value: unknown): string[];
export declare function joinOptions(options: unknown): string;
export declare function selectOptions(sheet: Sheet, name: string): string[];
export declare function rowMatches(sheet: Sheet, row: SheetRow, filter: SheetFilter): boolean;
export declare function queryProblems(
  sheet: Sheet,
  options?: { where?: SheetFilter[]; sort?: { column: string; direction?: string }; columns?: string[] },
): string[];
export declare function querySheet(
  sheet: Sheet,
  options?: { where?: SheetFilter[]; sort?: { column: string; direction?: string }; last?: number; limit?: number; columns?: string[] },
): { columns: SheetColumn[]; total: number; rows: ({ line: number } & SheetRow)[] };
export declare function latestByGroup(sheet: Sheet, options: { groupBy: string; dateColumn: string }): Map<string, SheetRow>;
export declare function changeRows(
  sheet: Sheet,
  options?: {
    append?: Record<string, unknown>[];
    update?: { match: Record<string, unknown>; set?: Record<string, unknown> };
    delete?: { match: Record<string, unknown> };
  },
): ChangeResult;
export declare function addColumn(
  sheet: Sheet,
  options?: { name?: string; type?: string; at?: number },
): { columns: SheetColumn[]; rows: SheetRow[]; column: SheetColumn };
export declare function renameColumn(sheet: Sheet, from: string, to: string): Sheet;
export declare function isCommentsColumn(column: unknown): boolean;
export declare function commentsColumnOf(sheet: Sheet): SheetColumn | null;
export declare function setColumnType(sheet: Sheet, name: string, type: string): { sheet: Sheet; misfits: number };
export declare function deleteColumn(sheet: Sheet, name: string): Sheet;
export declare function moveColumn(sheet: Sheet, name: string, to: number): Sheet;
export declare function newSheetText(columns?: { name: string; type: string }[]): string;
