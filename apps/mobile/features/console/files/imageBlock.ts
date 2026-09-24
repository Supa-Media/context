/**
 * Images in the note: the row that is drawn, and every decision it may write.
 *
 * `imageLine.ts` owns the grammar — what a row is, where a width lives, how
 * alignment survives in a file every other reader also opens. This owns the
 * editor half: which lines are drawn as rows, what a drag is allowed to change,
 * and the widget that puts a resize handle under somebody's pointer.
 *
 * ## Everything a gesture decides is a pure function
 *
 * `planResize`, `planAlign`, `planDrop` and `planInsert` take a state and
 * return a transaction spec. The DOM code below them does no arithmetic and
 * makes no decisions; it reads a pointer and calls one of them. That split is
 * deliberate and it is what `__tests__/imageBlock.test.ts` tests: snapping, the
 * refusal to drop a row onto a paragraph, where a paste lands relative to the
 * caret — all of it provable without a browser, which is the same argument
 * `livePreview.ts` makes for `revealedRanges`.
 *
 * ## The reveal rule still holds, and the handles are what made it subtle
 *
 * A row is drawn only while the selection is elsewhere, exactly like every
 * other mark in this editor: put the caret on the line and the embeds come
 * back as text, because you cannot edit syntax you cannot see. The handles
 * would have broken that — a pointer press on one would place the caret, the
 * row would vanish mid-drag and the drag would be over before it began. So the
 * controls call `preventDefault` on `pointerdown` and the widget reports
 * `ignoreEvent()` **true** for those events: a press on a handle never becomes
 * a selection, while a click on the image itself still does and still reveals
 * the markup.
 *
 * ## The bytes never come from a URL in the note
 *
 * The widget asks the host for the image by the target the note names, and the
 * host is the only thing that knows how to turn that into bytes — a Convex
 * action on the web, a bridge message inside the `WebView`. Nothing here builds
 * a network request, and a note that names `https://…` gets no request at all:
 * a remote image in a note somebody emailed you is a read receipt, which is the
 * rule `htmlPreviews`' CSP already enforces for a diagram.
 *
 * ## Facade
 *
 * The implementation is split by subject under `./imageBlock/`:
 *
 *  - `./imageBlock/model.ts` — the host contract, `ImageRow`, `imageRows`,
 *    `inCode` and the selection state field.
 *  - `./imageBlock/planning.ts` — every pure `plan*` function and the
 *    clipboard/drop file reading.
 *  - `./imageBlock/widget.ts` — `ImageRowWidget`, the DOM.
 *  - `./imageBlock/extension.ts` — the decoration, paste/drop handling and the
 *    `imageBlock` extension itself.
 *
 * Re-exported here so no existing import of `./imageBlock` needs to change.
 */

export type { ImageHostContext, ImageHostRef, ImageRow, ImagePick } from "./imageBlock/model";
export {
  imageHost,
  WIDTH_STEPS,
  MIN_IMAGE_WIDTH,
  inCode,
  imageRows,
  selectImage,
  imageSelection,
} from "./imageBlock/model";

export {
  widthFromDrag,
  planResize,
  planAlign,
  planDrop,
  cutBlock,
  planInsert,
  imageFilesFrom,
  planAlt,
  planReplace,
  planRemove,
} from "./imageBlock/planning";

export { ImageRowWidget } from "./imageBlock/widget";

export { imageRowDecoration, handleImageDrop, imageBlock } from "./imageBlock/extension";
