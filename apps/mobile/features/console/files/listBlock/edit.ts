/**
 * Writing a list's filters back into its block.
 *
 * The popover never keeps a filter of its own: every change renders the whole
 * config through the grammar's renderer and replaces the fence body, so what
 * the note says is what the list shows, on every surface and to every agent
 * that reads the note. See "The filter lives in the block" in
 * `docs/decisions/folder-lists.md`.
 */

import type { EditorState, TransactionSpec } from "@codemirror/state";
import { parseList, renderList, type ListConfig } from "./model";

/**
 * The change that makes the fence opening at `fenceFrom` say `config`, or an
 * error when the config would not read back as itself.
 *
 * The fence lines are kept as written — a ```` ```` ```` or `~~~` fence stays
 * one — and only the body between them changes.
 */
export function planListRewrite(
  state: EditorState,
  fenceFrom: number,
  config: ListConfig,
): { spec: TransactionSpec } | { error: string } {
  const body = renderList(config);
  const check = parseList(body);
  if (check.config === null) return { error: check.error ?? "the list could not be written" };
  const open = state.doc.lineAt(fenceFrom);
  if (open.from !== fenceFrom || open.number >= state.doc.lines) {
    return { error: "the list moved; try again" };
  }
  const marker = /^(`{3,}|~{3,})/.exec(open.text)?.[1];
  if (marker === undefined) return { error: "the list moved; try again" };
  for (let n = open.number + 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    // A closing fence is the same character, at least as many, and nothing after.
    const close = /^(`{3,}|~{3,})\s*$/.exec(line.text)?.[1];
    if (close !== undefined && close[0] === marker[0] && close.length >= marker.length) {
      const from = open.to + 1;
      const to = line.from;
      const insert = `${body}\n`;
      if (state.doc.sliceString(from, to) === insert) return { spec: {} };
      return { spec: { changes: { from, to, insert }, userEvent: "input.list" } };
    }
  }
  return { error: "the list moved; try again" };
}
