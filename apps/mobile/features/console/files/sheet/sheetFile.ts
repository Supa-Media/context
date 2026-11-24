import { isSheetPath } from "../../../../../mcp/src/sheets/csv.js";

/**
 * Whether a note opens in the sheet view rather than the Markdown editor.
 *
 * Decided by path, like a drawing, so it holds for a file still loading and
 * for an empty draft. An encrypted sheet is not drawn as a grid: it takes the
 * same locked path as any other encrypted note.
 */
export function isSheetDocument(path: string | null, encrypted: boolean): boolean {
  return !encrypted && path !== null && isSheetPath(path);
}
