/**
 * The image row's model: the host contract, the rows the grammar finds in a
 * document, and which image is selected.
 *
 * Split out of `imageBlock.ts` — see that file's header for the whole
 * picture. This holds the state a row is drawn from; `./planning.ts` holds
 * what a gesture is allowed to change, and `./widget.ts` is the DOM.
 */

import {
  Facet,
  MapMode,
  StateEffect,
  StateField,
  type EditorState,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

import { parseImageLine, type ImageLine } from "../imageLine";

/** What the editor needs from its host to draw and to store an image. */
export interface ImageHostContext {
  /**
   * A URL the widget may put in an `<img>` for the target a note names, or
   * `null` when there is nothing to show.
   *
   * Asynchronous because the bytes live in the customer's bucket, and the host
   * caches: this is called again on every redraw, and a row that refetched on
   * every keystroke would be a request per character.
   */
  load: (target: string) => Promise<string | null>;
  /**
   * Store bytes, and answer with the target to embed.
   *
   * The name is the host's to choose, not the editor's — it is content-addressed
   * in the bucket and the editor has no business inventing a key.
   */
  upload: (image: {
    bytes: ArrayBuffer;
    contentType: string;
  }) => Promise<{ target: string } | { error: string }>;
  /** Hand the file to the OS. Absent where there is nowhere to hand it. */
  open?: (target: string) => void;
}

/** Read at call time, for `HandlerRef`'s reason: extensions are built once. */
export interface ImageHostRef {
  current: ImageHostContext | null;
}

/**
 * The host, as a facet rather than an argument, so `imageRows` stays a pure
 * function of the state and the widget can still reach out — the same shape
 * `formHost` uses and for the same reason.
 */
export const imageHost = Facet.define<ImageHostRef, ImageHostRef | null>({
  combine: (values) => values[0] ?? null,
});

/** The widths the chips offer, as fractions of the reading measure. */
export const WIDTH_STEPS = [0.25, 0.5, 0.75, 1] as const;

/** Below this an image is a favicon, and a drag that reaches it was a mistake. */
export const MIN_IMAGE_WIDTH = 96;

/** One drawn row: the line it is, and what the grammar read off it. */
export interface ImageRow {
  from: number;
  to: number;
  text: string;
  line: ImageLine;
}

/**
 * Is `pos` inside code, where an embed is a quoted example rather than an image?
 *
 * Walked up the tree rather than matched on the text, because the failure this
 * prevents is a fenced block of Markdown documentation drawing its own
 * examples — and the tree already knows where every fence is.
 */
export function inCode(state: EditorState, pos: number): boolean {
  for (
    let node = syntaxTree(state).resolveInner(pos, 1);
    node !== null;
    node = node.parent!
  ) {
    if (
      node.name === "FencedCode" ||
      node.name === "CodeBlock" ||
      node.name === "InlineCode"
    ) {
      return true;
    }
    if (node.parent === null) return false;
  }
  return false;
}

/**
 * The rows to draw: every line that is nothing but embeds, minus anything
 * inside code.
 *
 * **There is no reveal rule here, and that is a deliberate exception to this
 * editor's central one.** Everywhere else, the line the selection is in shows
 * its markup, because you cannot edit syntax you cannot see. An image is where
 * that stops being true: the markup is a filename nobody types by hand, and
 * clicking a picture to have it turn into `![[paste-971e….png]]` was reported
 * as "really weird" the first day it shipped — which it is. What replaces it is
 * the toolbar: select the image and every edit the line can carry — width,
 * alignment, alt text, replace, remove — is a control on the image itself.
 *
 * The line is still ordinary text to everything else: a selection over it
 * deletes it, undo undoes it, and a note opened in any other editor shows the
 * embed. What is gone is only the *accidental* reveal.
 */
export function imageRows(state: EditorState, frontEnd = 0): ImageRow[] {
  const rows: ImageRow[] = [];
  for (let pos = frontEnd; pos <= state.doc.length; ) {
    const line = state.doc.lineAt(pos);
    pos = line.to + 1;
    if (!line.text.includes("![")) continue;
    const parsed = parseImageLine(line.text);
    if (parsed === null) continue;
    if (inCode(state, line.from + 1)) continue;
    rows.push({ from: line.from, to: line.to, text: line.text, line: parsed });
    if (line.to >= state.doc.length) break;
  }
  return rows;
}

/** Which image is selected: the line it is on, and which one along that line. */
export interface ImagePick {
  from: number;
  index: number;
}

/** Select an image, or `null` for none. */
export const selectImage = StateEffect.define<ImagePick | null>();

/**
 * The selected image, which is editor state rather than DOM state.
 *
 * In the field rather than in the widget, because a widget is rebuilt on every
 * transaction: a selection kept inside one would be lost by the first resize it
 * was used for. Mapped through changes so the toolbar stays on the image while
 * its own line is being rewritten, and dropped when that line goes.
 */
export const imageSelection = StateField.define<ImagePick | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(selectImage)) return effect.value;
    }
    if (value === null) return null;
    /*
      PUTTING THE IMAGE DOWN IS THE CARET BEING PUT SOMEWHERE ELSE.

      Clicking into the text, arrowing away, starting to type — all of them move
      the editor's own selection, and all of them mean the person is done with
      the picture. Reading that rather than watching for a press outside the
      widget is both simpler and more honest: there is one definition of "the
      cursor is elsewhere" in this editor and it already exists.

      A resize, an alignment or an alt-text edit carries no selection of its
      own, so the image stays picked through its own toolbar — which is the
      behaviour this rule has to get right to be worth having.
    */
    if (transaction.selection !== undefined) return null;
    if (!transaction.docChanged) return value;
    const from = transaction.changes.mapPos(value.from, -1, MapMode.TrackDel);
    return from === null ? null : { from, index: value.index };
  },
});

/** The selected image on this row, if the selection is on this row at all. */
export function pickFor(pick: ImagePick | null, row: ImageRow): number | null {
  if (pick === null || pick.from !== row.from) return null;
  return pick.index < row.line.images.length ? pick.index : null;
}
