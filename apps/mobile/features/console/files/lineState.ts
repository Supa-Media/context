/**
 * What the caret's line is, as the Aa panel lights it (board 3 of
 * `meeting-2026-10-17/phone-inbox/`): Title, Heading or Body, and which list
 * it is in, if any.
 *
 * Read off the line's own text, so both editors answer it the same way: the
 * web one calls it from a CodeMirror listener, the phone's from inside its web
 * view, and the host only ever sees the answer.
 */
export type LineStyle = "title" | "heading" | "body";
export type LineList = "bullet" | "number" | "task" | null;

export interface LineState {
  style: LineStyle;
  list: LineList;
  /**
   * Whether words are selected. The writing bar swaps its keys for bold,
   * italic and underline while they are (owner, 2026-11-08).
   */
  selected: boolean;
}

export const BODY_LINE: LineState = { style: "body", list: null, selected: false };

export function lineStateOf(text: string, selected = false): LineState {
  const heading = /^(#{1,6}) /.exec(text);
  const style: LineStyle = heading === null ? "body" : heading[1]!.length === 1 ? "title" : "heading";
  const list: LineList = /^\s*[-*+] \[[ xX]\] /.test(text)
    ? "task"
    : /^\s*[-*+] /.test(text)
      ? "bullet"
      : /^\s*\d+[.)] /.test(text)
        ? "number"
        : null;
  return { style, list, selected };
}

export function sameLineState(a: LineState, b: LineState): boolean {
  return a.style === b.style && a.list === b.list && a.selected === b.selected;
}

/** A line state that came over a bridge, or `null` if it is not one. */
export function decodeLineState(value: unknown): LineState | null {
  if (typeof value !== "object" || value === null) return null;
  const { style, list, selected } = value as { style?: unknown; list?: unknown; selected?: unknown };
  if (style !== "title" && style !== "heading" && style !== "body") return null;
  if (list !== null && list !== "bullet" && list !== "number" && list !== "task") return null;
  // A web view bundle older than the field never says; that is "nothing selected".
  return { style, list, selected: selected === true };
}
