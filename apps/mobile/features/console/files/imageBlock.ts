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
  MapMode,
  RangeSet,
  StateEffect,
  StateField,
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
  lineWithAlt,
  lineWithTarget,
  lineWithWidth,
  lineWithout,
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
function pickFor(pick: ImagePick | null, row: ImageRow): number | null {
  if (pick === null || pick.from !== row.from) return null;
  return pick.index < row.line.images.length ? pick.index : null;
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
  const images = (list: readonly (File | null)[]): File[] =>
    list.filter((file): file is File => file !== null && file.type.startsWith("image/"));
  /*
    `files` FIRST, AND ONLY ITS ANSWER WHEN IT HAS ONE.

    Both lists describe the same clipboard, and the first version of this read
    both and de-duplicated by identity — which is wrong, because
    `DataTransferItem.getAsFile()` mints a NEW `File` object on every call. So a
    browser that fills both (Chrome, for one) handed back the same screenshot
    twice, it was uploaded twice, and the note got two embeds of one image.
    Reported as "images paste twice", with a screenshot of the duplicate.

    `items` is still read, because an older WebKit and some applications leave
    `files` empty and put the image only there — but as a fallback, never as a
    second source to merge.
  */
  const direct = images(Array.from(data.files ?? []));
  if (direct.length > 0) return direct;
  return images(
    Array.from(data.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile()),
  );
}

/* -------------------------------------------------------------------------- */
/*                                 the widget                                 */
/* -------------------------------------------------------------------------- */

const ALIGN_STYLE: Record<ImageAlign, string> = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
};

/* -------------------------------------------------------------------------- */
/*                                 the widget                                 */
/* -------------------------------------------------------------------------- */

/** An icon, drawn rather than named: three lines, aligned. */
function alignIcon(align: ImageAlign): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 12");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "12");
  svg.setAttribute("aria-hidden", "true");
  const widths = [16, 10, 16];
  widths.forEach((width, row) => {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    const x = align === "left" ? 0 : align === "right" ? 16 - width : (16 - width) / 2;
    line.setAttribute("x", String(x));
    line.setAttribute("y", String(row * 4.5));
    line.setAttribute("width", String(width));
    line.setAttribute("height", "2");
    line.setAttribute("rx", "1");
    line.setAttribute("fill", "currentColor");
    svg.append(line);
  });
  return svg;
}

/**
 * A row of images, drawn, with the selected one wearing its controls.
 *
 * `eq` compares the line's text **and which image is selected**, which is
 * load-bearing rather than an optimisation for the reason `HtmlPreviewWidget.eq`
 * gives: the decoration set is rebuilt on every keystroke and cursor move, and a
 * widget that called itself new each time would tear down its `<img>` elements
 * and reload the bytes under the reader.
 */
export class ImageRowWidget extends WidgetType {
  /*
    `canEdit`, not `editable`, and the name is load-bearing: `WidgetType`
    already owns `editable` — an internal getter with no setter, which
    `WidgetTile.of` reads to decide whether to put `contenteditable="false"` on
    the widget's DOM. A field of that name is an assignment to it, so the
    constructor threw `Cannot set property editable of #<WidgetType> which has
    only a getter` and took the whole note screen down with it.
  */
  constructor(
    private readonly row: ImageRow,
    private readonly host: ImageHostRef | null,
    private readonly canEdit: boolean,
    private readonly selected: number | null,
  ) {
    super();
  }

  eq(other: ImageRowWidget): boolean {
    return (
      other.row.text === this.row.text &&
      other.canEdit === this.canEdit &&
      other.selected === this.selected
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-images";
    wrap.style.justifyContent = ALIGN_STYLE[this.row.line.align];
    this.row.line.images.forEach((image, index) => {
      wrap.append(this.drawImage(view, image.target, image.alt, image.width, index));
    });
    return wrap;
  }

  private drawImage(
    view: EditorView,
    target: string,
    alt: string,
    width: number | null,
    index: number,
  ): HTMLElement {
    const chosen = this.selected === index;
    const figure = document.createElement("figure");
    /*
      `cm-lp-image-live` is what the cursor and the hover handles hang off: a
      reader gets a picture, a writer gets a picture they can grab. Saying it in
      a class rather than in inline style keeps the whole affordance in the
      stylesheet, where the `--lp-*` contract already lives.
    */
    figure.className = [
      "cm-lp-image",
      this.canEdit ? "cm-lp-image-live" : "",
      chosen ? "cm-lp-image-on" : "",
    ]
      .filter((name) => name !== "")
      .join(" ");
    if (width !== null) figure.style.width = `${width}px`;

    const img = document.createElement("img");
    img.className = "cm-lp-image-img";
    /*
      The alt text is the note's own, and an image with none says so rather than
      being announced as an unlabelled graphic: a screen reader reading "image"
      is worse than one reading the file's name, which is at least what the
      writer chose to call it.
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

    /*
      THE WHOLE INTERACTION, AND WHY IT IS THIS ONE.

      An image in a note is a thing you point at, so the pointer decides between
      the two verbs by what it does rather than by which tiny target it found:

        - press and release without moving  → SELECT it (ring, handles, toolbar)
        - press and drag past a few pixels  → MOVE it (insertion caret, drop)

      That is Notion's and Craft's behaviour and it is the reason the separate
      grip button is gone: a 26px square with six dots in it is a second target
      to find for a gesture the image itself can carry. Resizing needs no
      selection at all — the side handles appear on hover — so the fast path is
      one drag, and the toolbar is there for everything a drag cannot say.

      `preventDefault` keeps CodeMirror from putting a caret under the press,
      which is what used to turn the picture back into `![[paste-….png]]`.
    */
    if (this.canEdit) {
      figure.addEventListener("pointerdown", (event) => {
        if ((event.target as HTMLElement).closest(".cm-lp-image-bar") !== null) return;
        if ((event.target as HTMLElement).closest(".cm-lp-image-handle") !== null) return;
        if ((event.target as HTMLElement).closest(".cm-lp-image-alt") !== null) return;
        event.preventDefault();
        event.stopPropagation();
        this.beginPress(view, figure, index, event);
      });
    }

    if (this.canEdit) {
      /*
        The side handles are on every image, hidden until the pointer is over it
        — resizing is the commonest thing anybody does to a picture and it should
        not need a click first. The corners, the badge and the bar belong to the
        selected one, because a picture wearing all of that permanently reads as
        a form control rather than as a picture.
      */
      figure.append(this.drawHandle(view, index, width, "w"));
      figure.append(this.drawHandle(view, index, width, "e"));
      if (chosen) {
        figure.append(this.drawBar(view, index, width, alt));
        for (const corner of ["nw", "ne", "sw", "se"] as const) {
          figure.append(this.drawHandle(view, index, width, corner));
        }
        figure.append(this.drawBadge(img, width));
      }
    }
    return figure;
  }

  /**
   * One press on the image: a click if it stays still, a move if it travels.
   *
   * The threshold is what makes both gestures live on one target without either
   * getting in the other's way — a hand on a trackpad never presses perfectly
   * still, and four pixels is under what anybody means by "I moved it".
   */
  private beginPress(
    view: EditorView,
    figure: HTMLElement,
    index: number,
    event: PointerEvent | MouseEvent,
  ): void {
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let at: number | null = null;
    const caret = document.createElement("div");
    caret.className = "cm-lp-image-caret";

    const move = (moveEvent: PointerEvent | MouseEvent) => {
      const travelled =
        Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY);
      if (!dragging && travelled < 4) return;
      if (!dragging) {
        dragging = true;
        figure.classList.add("cm-lp-image-moving");
      }
      at = view.posAtCoords({ x: moveEvent.clientX, y: moveEvent.clientY });
      if (at === null) {
        caret.remove();
        return;
      }
      // Drawn at the foot of the line under the pointer, which is where the
      // line would land — a caret anywhere else is a promise the drop breaks.
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
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
      caret.remove();
      figure.classList.remove("cm-lp-image-moving");
      if (!dragging) {
        view.dispatch({ effects: selectImage.of({ from: this.row.from, index }) });
        return;
      }
      if (at === null) return;
      this.dispatch(view, planDrop(view.state, this.rowNow(view), index, at));
      view.dispatch({ effects: selectImage.of(null) });
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    /*
      And the mouse pair as well: a `WebView` on an older iOS delivers mouse
      events for a trackpad and no pointer events at all, and a drag that only
      listens for one of the two is a drag that never ends on that device.
    */
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
  }

  private drawMissing(message: string): HTMLElement {
    const note = document.createElement("span");
    note.className = "cm-lp-image-missing";
    note.textContent = message;
    return note;
  }

  /** The size, as the file will hold it: the badge in the artifact's corner. */
  private drawBadge(img: HTMLImageElement, width: number | null): HTMLElement {
    const badge = document.createElement("span");
    badge.className = "cm-lp-image-badge";
    const say = (): void => {
      const shown = width ?? Math.round(img.getBoundingClientRect().width);
      const ratio = img.naturalWidth > 0 ? img.naturalHeight / img.naturalWidth : 0;
      badge.textContent =
        ratio > 0 ? `${shown} × ${Math.round(shown * ratio)}` : `${shown}px`;
    };
    say();
    // The natural size is unknown until the bytes are decoded, so the badge
    // says what it knows now and the rest when it knows it.
    img.addEventListener("load", say);
    return badge;
  }

  /**
   * The bar: every edit the line can carry, on the image it belongs to.
   *
   * This is what replaced the reveal rule. The width chips are fractions of the
   * reading measure — the fast path — and the handles are the exact one; the
   * three alignment buttons are drawn icons rather than letters, because the
   * first version shipped three empty squares; and Remove takes the image out
   * of the note while leaving the object in the bucket, which is what its own
   * decision says.
   */
  private drawBar(
    view: EditorView,
    index: number,
    width: number | null,
    alt: string,
  ): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-lp-image-bar";
    const measure = this.measureOf(view);

    const press = (element: HTMLElement, run: () => void): void => {
      element.addEventListener("pointerdown", (event) => {
        // Never a caret, and never a lost selection: the bar belongs to the
        // image it is on, and a press on it must not put the cursor in the note.
        event.preventDefault();
        event.stopPropagation();
        run();
      });
    };

    const chip = (label: string, fraction: number): HTMLButtonElement => {
      const target = Math.round(measure * fraction);
      const button = document.createElement("button");
      button.type = "button";
      const on = width !== null && Math.abs(width - target) <= 2;
      button.className = on ? "cm-lp-image-chip cm-lp-image-chip-on" : "cm-lp-image-chip";
      button.textContent = label;
      button.setAttribute("aria-pressed", String(on));
      button.setAttribute("aria-label", `${label} — ${target} pixels wide`);
      press(button, () =>
        this.dispatch(view, planResize(view.state, this.rowNow(view), index, target)),
      );
      return button;
    };

    bar.append(chip("S", WIDTH_STEPS[0]));
    bar.append(chip("M", WIDTH_STEPS[1]));
    bar.append(chip("L", WIDTH_STEPS[2]));
    bar.append(chip("Full", WIDTH_STEPS[3]));
    bar.append(this.divider());

    for (const align of ["left", "center", "right"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      const on = this.row.line.align === align;
      button.className = on ? "cm-lp-image-tool cm-lp-image-tool-on" : "cm-lp-image-tool";
      button.setAttribute(
        "aria-label",
        align === "center" ? "Centre" : `Align ${align}`,
      );
      button.setAttribute("aria-pressed", String(on));
      button.append(alignIcon(align));
      press(button, () =>
        this.dispatch(view, planAlign(view.state, this.rowNow(view), align)),
      );
      bar.append(button);
    }
    bar.append(this.divider());

    const altButton = document.createElement("button");
    altButton.type = "button";
    altButton.className = "cm-lp-image-tool cm-lp-image-tool-text";
    altButton.textContent = "Alt";
    altButton.setAttribute("aria-label", "Alt text");
    press(altButton, () => this.askAlt(view, index, alt));
    bar.append(altButton);

    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "cm-lp-image-tool cm-lp-image-tool-text";
    replace.textContent = "Replace";
    replace.setAttribute("aria-label", "Replace this image");
    press(replace, () => this.askReplacement(view, index));
    bar.append(replace);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cm-lp-image-tool cm-lp-image-tool-text cm-lp-image-remove";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", "Remove this image from the note");
    press(remove, () => this.remove(view, index));
    bar.append(remove);

    return bar;
  }

  private divider(): HTMLElement {
    const line = document.createElement("span");
    line.className = "cm-lp-image-divider";
    return line;
  }

  /**
   * Alt text, in a field that opens under the bar.
   *
   * Drawn here rather than kept in the widget's own state, because the widget
   * is rebuilt on every transaction: a panel remembered in a field would blink
   * out on the first keystroke somewhere else in the note. It is torn down when
   * it is committed or dismissed, which is the whole of its lifetime.
   */
  private askAlt(view: EditorView, index: number, current: string): void {
    const figure = view.dom.querySelector(".cm-lp-image-on");
    if (figure === null || figure.querySelector(".cm-lp-image-alt") !== null) return;
    const panel = document.createElement("div");
    panel.className = "cm-lp-image-alt";
    const label = document.createElement("label");
    label.textContent = "Alt text";
    label.className = "cm-lp-image-alt-label";
    const field = document.createElement("input");
    field.type = "text";
    field.value = current;
    field.className = "cm-lp-image-alt-field";
    label.append(field);
    panel.append(label);
    const hint = document.createElement("span");
    hint.className = "cm-lp-image-alt-hint";
    hint.textContent = "Read aloud, searchable, and what a reader that cannot fetch the file shows.";
    panel.append(hint);
    figure.append(panel);
    field.focus();
    const commit = (): void => {
      const value = field.value;
      panel.remove();
      this.dispatch(view, planAlt(view.state, this.rowNow(view), index, value));
    };
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        panel.remove();
      }
    });
    field.addEventListener("blur", commit);
  }

  /** Replace: the same line, a different object, every other note untouched. */
  private askReplacement(view: EditorView, index: number): void {
    const host = this.host?.current ?? null;
    if (host === null) return;
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "image/*";
    picker.style.display = "none";
    picker.addEventListener("change", () => {
      const file = picker.files?.[0] ?? null;
      picker.remove();
      if (file === null) return;
      void (async () => {
        const stored = await host.upload({
          bytes: await file.arrayBuffer(),
          contentType: file.type,
        });
        if ("error" in stored) return;
        this.dispatch(
          view,
          planReplace(view.state, this.rowNow(view), index, stored.target),
        );
      })();
    });
    view.dom.append(picker);
    picker.click();
  }

  /** Remove: the line, or one image of it, and never the object in the bucket. */
  private remove(view: EditorView, index: number): void {
    this.dispatch(view, planRemove(view.state, this.rowNow(view), index));
    view.dispatch({ effects: selectImage.of(null) });
  }

  /**
   * A resize handle. Six of them, and all six change the width only.
   *
   * Aspect is locked because height is never written down, so a corner and a
   * side do the same thing — what differs is which way the drag reads, and the
   * cursor over each says so.
   */
  private drawHandle(
    view: EditorView,
    index: number,
    width: number | null,
    corner: "nw" | "ne" | "sw" | "se" | "w" | "e",
  ): HTMLElement {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = `cm-lp-image-handle cm-lp-image-handle-${corner}`;
    handle.setAttribute("aria-label", "Resize image");
    const leftward = corner === "nw" || corner === "sw" || corner === "w";
    handle.addEventListener("pointerdown", (event) => {
      // Never a selection: a press that placed the caret would take this button
      // out of the document mid-drag.
      event.preventDefault();
      event.stopPropagation();
      const measure = this.measureOf(view);
      const startWidth = width ?? this.shownWidth(handle, measure);
      const startX = event.clientX;
      const move = (moveEvent: PointerEvent) => {
        const delta = (moveEvent.clientX - startX) * (leftward ? -1 : 1);
        const next = widthFromDrag({
          startWidth,
          deltaX: delta,
          measure,
          precise: moveEvent.altKey,
        });
        this.dispatch(view, planResize(view.state, this.rowNow(view), index, next));
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
      const step = (event.shiftKey ? 32 : 8) * (event.key === "ArrowRight" ? 1 : -1);
      const current = width ?? this.shownWidth(handle, measure);
      this.dispatch(
        view,
        planResize(
          view.state,
          this.rowNow(view),
          index,
          widthFromDrag({ startWidth: current, deltaX: step, measure, precise: true }),
        ),
      );
    });
    return handle;
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
  private shownWidth(handle: HTMLElement, measure: number): number {
    const figure = handle.parentElement;
    const shown = figure?.getBoundingClientRect().width ?? 0;
    return shown > MIN_IMAGE_WIDTH ? Math.round(shown) : measure;
  }

  /*
    True for the pointer and key events the controls handle, so a press on the
    image or on a control is never also a click into the line. The widget is
    not editable DOM and nothing inside it is text of the note.
  */
  ignoreEvent(event: Event): boolean {
    return event.type === "pointerdown" || event.type === "keydown";
  }
}

/** Set alt text on image `index` of `row`. */
export function planAlt(
  state: EditorState,
  row: ImageRow,
  index: number,
  alt: string,
): TransactionSpec | null {
  return replaceLine(state, row, lineWithAlt(row.text, index, alt));
}

/** Point image `index` of `row` at another object. */
export function planReplace(
  state: EditorState,
  row: ImageRow,
  index: number,
  target: string,
): TransactionSpec | null {
  return replaceLine(state, row, lineWithTarget(row.text, index, target));
}

/**
 * Take image `index` out of the note.
 *
 * The last image on a line takes the line with it — a blank line where a
 * picture was is a gap somebody has to tidy by hand — and the **object stays in
 * the bucket** either way: deleting a paragraph should not delete somebody's
 * screenshot, and the unreferenced sweep offers it by name later.
 */
export function planRemove(
  state: EditorState,
  row: ImageRow,
  index: number,
): TransactionSpec | null {
  const rest = lineWithout(row.text, index);
  if (rest === null) return { changes: { ...cutBlock(state, row.from), insert: "" } };
  return replaceLine(state, row, rest);
}

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
