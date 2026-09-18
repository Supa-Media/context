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
 */

import {
  Facet,
  type EditorState,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

import {
  embedFor,
  joinRows,
  lineWithAlign,
  lineWithWidth,
  parseImageLine,
  type ImageAlign,
  type ImageLine,
} from "./imageLine";

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
 * The rows to draw: every line that is nothing but embeds, minus the one the
 * selection is in and minus anything inside code.
 *
 * `selection` is passed in rather than read here so the caller can hand over
 * the same reveal ranges every other pass in `livePreview.ts` uses — two
 * definitions of "the selection touches this" is how half a document ends up
 * half revealed.
 */
export function imageRows(
  state: EditorState,
  touched: (range: { from: number; to: number }) => boolean,
  frontEnd = 0,
): ImageRow[] {
  const rows: ImageRow[] = [];
  for (let pos = frontEnd; pos <= state.doc.length;) {
    const line = state.doc.lineAt(pos);
    pos = line.to + 1;
    if (!line.text.includes("![")) continue;
    const parsed = parseImageLine(line.text);
    if (parsed === null) continue;
    if (touched({ from: line.from, to: line.to })) continue;
    if (inCode(state, line.from + 1)) continue;
    rows.push({ from: line.from, to: line.to, text: line.text, line: parsed });
    if (line.to >= state.doc.length) break;
  }
  return rows;
}

/**
 * The width a drag has reached, snapped to the quarters of the measure.
 *
 * Snapping is a default and not a cage: `precise` — the ⌥ key at the call site
 * — skips it. The tolerance is in pixels rather than a fraction so it feels the
 * same on a phone-width measure as on a wide one.
 */
export function widthFromDrag(options: {
  startWidth: number;
  deltaX: number;
  measure: number;
  precise?: boolean;
}): number {
  const { startWidth, deltaX, measure, precise = false } = options;
  const raw = Math.round(startWidth + deltaX);
  const bounded = Math.max(MIN_IMAGE_WIDTH, Math.min(measure, raw));
  if (precise) return bounded;
  for (const step of WIDTH_STEPS) {
    const snap = Math.round(measure * step);
    if (Math.abs(bounded - snap) <= 14) return snap;
  }
  return bounded;
}

/** The whole-line replacement every planner below ends in. */
function replaceLine(
  state: EditorState,
  row: ImageRow,
  text: string,
): TransactionSpec | null {
  if (text === row.text) return null;
  return {
    changes: { from: row.from, to: row.to, insert: text },
    // The selection is deliberately left where it was: a resize that moved the
    // caret onto the line would reveal the markup and take the handle out from
    // under the pointer mid-drag.
    scrollIntoView: false,
  };
}

/** Resize image `index` of `row`. */
export function planResize(
  state: EditorState,
  row: ImageRow,
  index: number,
  width: number | null,
): TransactionSpec | null {
  return replaceLine(state, row, lineWithWidth(row.text, index, width));
}

/** Set the row's alignment. */
export function planAlign(
  state: EditorState,
  row: ImageRow,
  align: ImageAlign,
): TransactionSpec | null {
  return replaceLine(state, row, lineWithAlign(row.text, align));
}

/**
 * What dropping image `index` of `row` at `dropPos` should do.
 *
 * Two outcomes, and the difference is what is already at the drop:
 *
 *  - dropped on another **image line** → the two rows join, and the image sits
 *    beside the ones already there. This is the side-by-side gesture, and it is
 *    one line edit because a row is a line.
 *  - dropped anywhere else → the whole line moves there, which is the ordinary
 *    "move a block" and is what `⌥↑`/`⌥↓` do without a pointer.
 *
 * A drop inside the row's own line is `null` — nothing moved — rather than a
 * no-op edit, so it never lands in the undo history.
 */
export function planDrop(
  state: EditorState,
  row: ImageRow,
  index: number,
  dropPos: number,
): TransactionSpec | null {
  const target = state.doc.lineAt(Math.max(0, Math.min(state.doc.length, dropPos)));
  if (target.from === row.from) return null;
  const joined = joinRows(target.text, row.text, index);
  if (joined !== null) {
    const changes: Array<{ from: number; to: number; insert: string }> = [
      { from: target.from, to: target.to, insert: joined.onto },
    ];
    if (joined.from === "") {
      // The source row is empty now, so the block goes with it rather than
      // leaving a blank line behind: a drag that tidied nothing is a drag
      // somebody has to finish by hand.
      changes.push({ ...cutBlock(state, row.from), insert: "" });
    } else {
      changes.push({ from: row.from, to: row.to, insert: joined.from });
    }
    return { changes };
  }
  /*
    A plain move. Both ranges are positions in the document as it is now, which
    is what CodeMirror maps a change set against — computing the insert against
    the post-cut document is the classic off-by-a-line in this shape.

    The blank line is not cosmetic: `one\ntwo` is one paragraph with a soft
    break in CommonMark, so an image line pushed directly under a sentence would
    join that sentence in every other reader of the file, however this editor
    chose to draw it.
  */
  return {
    changes: [
      { ...cutBlock(state, row.from), insert: "" },
      { from: target.to, to: target.to, insert: `\n\n${row.text}` },
    ],
  };
}

/**
 * The range that deletes the block a line is, blank line and all.
 *
 * Deleting only the line leaves the blank lines that separated it from its
 * neighbours stacked on each other, which is a visible gap in the note and a
 * diff nobody asked for. Which side the blank line is taken from depends on
 * where the line sits, and the three cases are exactly the three positions a
 * block can be in: with something after it, at the end of the note, or packed
 * against its neighbours with no blank lines at all.
 */
export function cutBlock(state: EditorState, at: number): { from: number; to: number } {
  const doc = state.doc;
  const line = doc.lineAt(at);
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
  const previous = line.number > 1 ? doc.line(line.number - 1) : null;
  if (next !== null && next.text.trim() === "") {
    return { from: line.from, to: Math.min(doc.length, next.to + 1) };
  }
  if (next === null && previous !== null && previous.text.trim() === "") {
    return { from: Math.max(0, previous.from - 1), to: line.to };
  }
  return { from: line.from, to: Math.min(doc.length, line.to + 1) };
}

/**
 * Where a pasted image lands, and where the caret goes after it.
 *
 * On its own line, always, because a row is a line and an embed dropped into
 * the middle of a sentence would be prose rather than an image this editor can
 * lay out.
 *
 * **The caret goes to the line *after* it, and that is the whole of the second
 * version of this function.** The first put the caret after the embed, which is
 * on the image's own line — and the reveal rule then does exactly what it is
 * supposed to do: the line the selection is in shows its markup. So a paste
 * ended with the raw `![[…]]` on screen, drawn as a link, and the image
 * appeared only once somebody clicked somewhere else. Reported as "just pasted
 * an image, and got this", with a screenshot of a link.
 *
 * A blank line is written under the embed when there is not already one, so
 * there is somewhere for the caret to be that is not the image's line — and
 * it is where you would keep typing anyway.
 */
export function planInsert(
  state: EditorState,
  target: string,
  width: number | null,
): TransactionSpec {
  const embed = embedFor(target, width);
  const line = state.doc.lineAt(state.selection.main.head);
  const onEmptyLine = line.text.trim() === "";
  const from = onEmptyLine ? line.from : line.to;
  const insert = `${onEmptyLine ? "" : "\n"}${embed}\n`;
  return {
    changes: { from, to: onEmptyLine ? line.to : line.to, insert },
    // After the newline this just wrote: the image's own line is left alone, so
    // the row draws the moment the paste lands.
    selection: { anchor: from + insert.length },
  };
}

/**
 * The image files on a clipboard or drop event, in the order they arrive.
 *
 * **Both lists, because neither is always the one with the image in it.**
 * `files` is populated for a drag from the desktop and for a screenshot pasted
 * by current Chrome and Safari; `items` is what an older WebKit and some
 * applications put a pasted image in, with `files` left empty. Reading one and
 * not the other is a paste that works on the machine it was written on.
 *
 * De-duplicated by identity, since a browser that populates both populates them
 * with the same `File`.
 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const files: File[] = [];
  const keep = (file: File | null): void => {
    if (file === null) return;
    if (!file.type.startsWith("image/")) return;
    if (files.includes(file)) return;
    files.push(file);
  };
  for (const file of Array.from(data.files ?? [])) keep(file);
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    keep(item.getAsFile());
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/*                                 the widget                                 */
/* -------------------------------------------------------------------------- */

const ALIGN_STYLE: Record<ImageAlign, string> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

/**
 * A row of images, drawn.
 *
 * `eq` compares the line's text, which is load-bearing rather than an
 * optimisation for the reason `HtmlPreviewWidget.eq` gives: the decoration set
 * is rebuilt on every keystroke, and a widget that called itself new each time
 * would tear down its `<img>` elements and reload the bytes under the reader.
 */
export class ImageRowWidget extends WidgetType {
  constructor(
    private readonly row: ImageRow,
    private readonly host: ImageHostRef | null,
    private readonly editable: boolean,
  ) {
    super();
  }

  eq(other: ImageRowWidget): boolean {
    return other.row.text === this.row.text && other.editable === this.editable;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-images";
    wrap.style.justifyContent = ALIGN_STYLE[this.row.line.align];
    this.row.line.images.forEach((image, index) => {
      wrap.append(
        this.drawImage(view, image.target, image.alt, image.width, index),
      );
    });
    if (this.editable) wrap.append(this.drawAlignBar(view));
    return wrap;
  }

  private drawImage(
    view: EditorView,
    target: string,
    alt: string,
    width: number | null,
    index: number,
  ): HTMLElement {
    const figure = document.createElement("figure");
    figure.className = "cm-lp-image";
    if (width !== null) figure.style.width = `${width}px`;

    const img = document.createElement("img");
    img.className = "cm-lp-image-img";
    /*
      The alt text is the note's own, and an image with none says so rather
      than being announced as an unlabelled graphic: a screen reader reading
      "image" is worse than one reading the file's name, which is at least what
      the writer chose to call it.
    */
    img.alt = alt === "" ? target : alt;
    img.draggable = false;
    figure.append(img);

    const host = this.host?.current ?? null;
    if (host === null) {
      figure.append(this.drawMissing("This surface cannot load images."));
    } else {
      void host
        .load(target)
        .then((src) => {
          if (src === null) {
            figure.append(this.drawMissing(`Not in this bucket: ${target}`));
            return;
          }
          img.src = src;
        })
        .catch(() => {
          figure.append(this.drawMissing(`Could not load ${target}`));
        });
    }

    if (this.editable) {
      figure.append(this.drawHandle(view, index, width));
      figure.append(this.drawGrip(view, index));
    }
    return figure;
  }

  private drawMissing(message: string): HTMLElement {
    const note = document.createElement("span");
    note.className = "cm-lp-image-missing";
    note.textContent = message;
    return note;
  }

  /**
   * The resize handle: a real `<button>`, so a keyboard reaches it.
   *
   * Arrow keys move the width 8px, with shift 32px — the same pair the drag
   * snaps to, and the reason the handle is a button rather than a styled div is
   * that a pointer is not the only way people edit a note.
   */
  private drawHandle(
    view: EditorView,
    index: number,
    width: number | null,
  ): HTMLElement {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "cm-lp-image-handle";
    handle.setAttribute("aria-label", "Resize image");
    handle.addEventListener("pointerdown", (event) => {
      // Never a selection: see the header. A press that placed the caret would
      // reveal the markup and take this button out of the document mid-drag.
      event.preventDefault();
      event.stopPropagation();
      const measure = this.measureOf(view);
      const startWidth = width ?? this.naturalWidth(handle, measure);
      const startX = event.clientX;
      const move = (moveEvent: PointerEvent) => {
        const next = widthFromDrag({
          startWidth,
          deltaX: moveEvent.clientX - startX,
          measure,
          precise: moveEvent.altKey,
        });
        this.dispatch(
          view,
          planResize(view.state, this.rowNow(view), index, next),
        );
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const measure = this.measureOf(view);
      const step =
        (event.shiftKey ? 32 : 8) * (event.key === "ArrowRight" ? 1 : -1);
      const current = width ?? this.naturalWidth(handle, measure);
      this.dispatch(
        view,
        planResize(
          view.state,
          this.rowNow(view),
          index,
          widthFromDrag({
            startWidth: current,
            deltaX: step,
            measure,
            precise: true,
          }),
        ),
      );
    });
    return handle;
  }

  /**
   * The grip: drag the image somewhere else in the note.
   *
   * Two outcomes, decided by `planDrop` from where the pointer let go — beside
   * the images already on another line, or on a line of its own between two
   * blocks. Both are one line edit, because a row is a line.
   *
   * The insertion point is `posAtCoords`, CodeMirror's own answer to "what is
   * under this pointer", so a drop lands where the editor itself would put a
   * caret. `null` from it — a pointer outside the content — is a cancelled drag
   * rather than a guess at the nearest line.
   */
  private drawGrip(view: EditorView, index: number): HTMLElement {
    const grip = document.createElement("button");
    grip.type = "button";
    grip.className = "cm-lp-image-grip";
    grip.setAttribute("aria-label", "Move image");
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const figure = grip.parentElement;
      figure?.classList.add("cm-lp-image-moving");
      const caret = document.createElement("div");
      caret.className = "cm-lp-image-caret";
      let at: number | null = null;
      const move = (moveEvent: PointerEvent) => {
        at = view.posAtCoords({ x: moveEvent.clientX, y: moveEvent.clientY });
        if (at === null) {
          caret.remove();
          return;
        }
        // Drawn at the top of the line under the pointer, which is where the
        // line would land — a caret somewhere else is a promise the drop does
        // not keep.
        const line = view.state.doc.lineAt(at);
        const box = view.coordsAtPos(line.from);
        if (box === null) return;
        const scroller = view.scrollDOM.getBoundingClientRect();
        caret.style.top = `${box.bottom - scroller.top + view.scrollDOM.scrollTop}px`;
        view.scrollDOM.append(caret);
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        caret.remove();
        figure?.classList.remove("cm-lp-image-moving");
        if (at === null) return;
        this.dispatch(view, planDrop(view.state, this.rowNow(view), index, at));
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
    });
    /*
      The keyboard equivalent is not here and does not need to be: `⌥↑` / `⌥↓`
      move the line, which CodeMirror's own `defaultKeymap` already binds, and
      the line is the unit. A second implementation of "move a block" for images
      alone would be a second answer to the same question.
    */
    return grip;
  }

  /** Left, centre, right — the only three positions the file can carry. */
  private drawAlignBar(view: EditorView): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-lp-image-bar";
    const options: Array<{ align: ImageAlign; label: string }> = [
      { align: "left", label: "Align left" },
      { align: "center", label: "Centre" },
      { align: "right", label: "Align right" },
    ];
    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        option.align === this.row.line.align
          ? "cm-lp-image-align cm-lp-image-align-on"
          : "cm-lp-image-align";
      button.setAttribute("aria-label", option.label);
      button.setAttribute(
        "aria-pressed",
        String(option.align === this.row.line.align),
      );
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.dispatch(
          view,
          planAlign(view.state, this.rowNow(view), option.align),
        );
      });
      bar.append(button);
    }
    return bar;
  }

  /**
   * The row as the document has it *now*.
   *
   * A widget holds the row it was built from, and a drag dispatches several
   * transactions: using the captured row for the second one would write the
   * first one's text back. The line is looked up by position instead, which is
   * where CodeMirror has already mapped it to.
   */
  private rowNow(view: EditorView): ImageRow {
    const line = view.state.doc.lineAt(this.row.from);
    const parsed = parseImageLine(line.text);
    return {
      from: line.from,
      to: line.to,
      text: line.text,
      line: parsed ?? this.row.line,
    };
  }

  private dispatch(view: EditorView, spec: TransactionSpec | null): void {
    if (spec === null) return;
    if (view.state.readOnly) return;
    view.dispatch(spec);
  }

  /** The reading measure, which is what a width is a fraction of. */
  private measureOf(view: EditorView): number {
    const width = view.contentDOM.clientWidth;
    return width > MIN_IMAGE_WIDTH ? width : 640;
  }

  /** An image with no width in the file starts its first drag from what it is. */
  private naturalWidth(handle: HTMLElement, measure: number): number {
    const figure = handle.parentElement;
    const shown = figure?.getBoundingClientRect().width ?? 0;
    return shown > MIN_IMAGE_WIDTH ? Math.round(shown) : measure;
  }

  /*
    True for the pointer events the controls handle, so a press on a handle is
    never also a click into the line. False for everything else, so clicking
    the image itself still places the caret and still reveals the markup —
    which is the escape hatch that keeps this editor one where you can always
    reach the text.
  */
  ignoreEvent(event: Event): boolean {
    return event.type === "pointerdown" || event.type === "keydown";
  }
}

/** The decoration a row becomes: a block widget over the whole line. */
export function imageRowDecoration(
  row: ImageRow,
  host: ImageHostRef | null,
  editable: boolean,
): Decoration {
  return Decoration.replace({
    widget: new ImageRowWidget(row, host, editable),
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

/** Paste, drop and the styles, as one extension. */
export function imageBlock(
  host: ImageHostRef,
  report: (message: string) => void,
): Extension {
  return [
    imageHost.of(host),
    EditorView.domEventHandlers({
      paste: (event, view) =>
        handleImageDrop(view, event.clipboardData, report),
      drop: (event, view) => {
        const took = handleImageDrop(view, event.dataTransfer, report);
        if (took) event.preventDefault();
        return took;
      },
    }),
  ];
}
