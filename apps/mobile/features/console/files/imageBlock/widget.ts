/**
 * The widget: a row of images, drawn, with the selected one wearing its
 * controls.
 *
 * Split out of `imageBlock.ts` — see that file's header for the whole
 * picture, in particular the reveal rule and why the handles report
 * `ignoreEvent()`.
 */

import type { TransactionSpec } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";

import { parseImageLine, type ImageAlign } from "../imageLine";
import { MIN_IMAGE_WIDTH, WIDTH_STEPS, selectImage, type ImageHostRef, type ImageRow } from "./model";
import { planAlign, planAlt, planDrop, planRemove, planReplace, planResize, widthFromDrag } from "./planning";

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
