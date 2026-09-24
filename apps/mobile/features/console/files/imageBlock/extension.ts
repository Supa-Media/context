/**
 * The decoration a row becomes, paste and drop, and the CodeMirror extension
 * that wires the whole feature together.
 *
 * Split out of `imageBlock.ts` — see that file's header for the whole
 * picture.
 */

import { RangeSet, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

import {
  imageHost,
  imageRows,
  imageSelection,
  pickFor,
  type ImageHostRef,
  type ImagePick,
  type ImageRow,
} from "./model";
import { imageFilesFrom, planInsert } from "./planning";
import { ImageRowWidget } from "./widget";

/** The decoration a row becomes: a block widget over the whole line. */
export function imageRowDecoration(
  row: ImageRow,
  host: ImageHostRef | null,
  editable: boolean,
  pick: ImagePick | null,
): Decoration {
  return Decoration.replace({
    widget: new ImageRowWidget(row, host, editable, pickFor(pick, row)),
    block: true,
  });
}

/**
 * Paste and drop, which are the same act with a different verb.
 *
 * Returns true when it took the event, which is what stops CodeMirror from
 * also inserting the clipboard's text fallback — a screenshot pasted from some
 * applications carries a filename in `text/plain`, and without this the note
 * would get both the image and the word `Screenshot`.
 */
export function handleImageDrop(
  view: EditorView,
  data: DataTransfer | null,
  report: (message: string) => void,
): boolean {
  if (view.state.readOnly) return false;
  const files = imageFilesFrom(data);
  if (files.length === 0) return false;
  const host = view.state.facet(imageHost)?.current ?? null;
  if (host === null) return false;
  void (async () => {
    for (const file of files) {
      const bytes = await file.arrayBuffer();
      const stored = await host.upload({ bytes, contentType: file.type });
      if ("error" in stored) {
        report(stored.error);
        return;
      }
      view.dispatch(planInsert(view.state, stored.target, null));
    }
  })();
  return true;
}

/**
 * Everything the editor needs for images: the host, the selection, the atomic
 * ranges that keep a caret out of a drawn row, and paste and drop.
 */
export function imageBlock(
  host: ImageHostRef,
  report: (message: string) => void,
): Extension {
  return [
    imageHost.of(host),
    imageSelection,
    /*
      A drawn row is one object rather than a run of characters: without this,
      arrowing along a line of images walks an invisible caret through markup
      that is not on screen, which is the failure the reveal rule used to hide.
      With it, the caret steps over the row and a selection takes the whole
      thing — so Backspace still deletes an image, which is the one editing
      gesture the toolbar does not own.
    */
    EditorView.atomicRanges.of((view) =>
      RangeSet.of(
        imageRows(view.state).map((row) => ({
          from: row.from,
          to: row.to,
          value: Decoration.mark({}),
        })),
        true,
      ),
    ),
    EditorView.domEventHandlers({
      paste: (event, view) => handleImageDrop(view, event.clipboardData, report),
      drop: (event, view) => {
        const took = handleImageDrop(view, event.dataTransfer, report);
        if (took) event.preventDefault();
        return took;
      },
    }),
  ];
}
