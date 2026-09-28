/**
 * Comments where there is no margin: a phone, or any pane too thin for cards.
 *
 * Dev2 approved this on 2026-09-27 (phone artboards 3 and 4):
 *
 *  - **Tapping highlighted words opens their thread in a bottom sheet**: the
 *    quoted words, every message with its author and age, whether it was
 *    resolved, and a reply field. There is no count badge in the text, which
 *    would sit inside headings; the highlight is the affordance.
 *  - **A visitor reads threads, and the field says "Sign in to reply".**
 *  - **Selecting text offers a floating Comment chip** beside the selection.
 *    It is not a key on the keyboard bar, which already carries seven, and
 *    Mobile Safari will not let a page add to its own text menu. Tapping the
 *    chip opens the same sheet with an empty composer.
 *  - **Every field in it is 16px**, the size below which iOS zooms the page
 *    when a field takes focus.
 *
 * The margin (`rail.ts`) and this read one width rule, `hasMargin`, so a pane
 * shows cards or a sheet and never both.
 *
 * ## Two placements
 *
 * `"viewport"` is a real bottom sheet, fixed to the screen, for a browser. Its
 * layer lives on `<body>` rather than inside the editor, so typing a reply is
 * not "focus in the note": the keyboard bar, which acts on the note, stands
 * down while somebody writes a comment.
 *
 * `"inline"` is for the iOS app's web view, which is laid out as tall as its
 * note and scrolled by the app around it. The bottom of that document is the
 * bottom of the note, not of the screen, so a fixed sheet would sit pages
 * below the reader. There the same panel opens under the thread's line and
 * scrolls with the text.
 *
 * Built from `dom.ts`, with `textContent` only, for the reason given there.
 */

import { type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { CommentThread } from "@context/shared/src/comments.cjs";
import {
  addToThread,
  canComment,
  commentHost,
  commentUi,
  commentableSelection,
  commentsParsed,
  setActiveThread,
  setDraft,
  startCommentOn,
  submitDraft,
} from "./extension";
import { button, carryOver, composer, el, message, report } from "./dom";
import { hasMargin, messages, quoteLabel, resolvedBy } from "./model";

export type SheetPlacement = "viewport" | "inline";

type Content =
  | { kind: "draft"; quote: string; pos: number }
  | { kind: "thread"; thread: CommentThread; pos: number };

/** What the sheet shows for this state, or null when it is closed. */
export function sheetContent(view: EditorView): Content | null {
  const state = view.state;
  const ui = state.field(commentUi);
  if (ui.draft !== null) {
    return { kind: "draft", quote: state.sliceDoc(ui.draft.from, ui.draft.to), pos: ui.draft.to };
  }
  if (ui.active === null) return null;
  const parsed = state.field(commentsParsed);
  const thread = parsed.threads.find((one) => one.id === ui.active);
  if (thread === undefined) return null;
  return { kind: "thread", thread, pos: parsed.anchors.get(thread.id)?.to ?? 0 };
}

class Sheet implements PluginValue {
  private readonly layer: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly chip: HTMLButtonElement;
  private signature: string | null = null;
  /** The selection the chip was pressed on; see `startCommentOn`. */
  private pressed: { from: number; to: number } | null = null;
  private destroyed = false;
  private readonly viewport: VisualViewport | null;

  constructor(
    private readonly view: EditorView,
    private readonly placement: SheetPlacement,
  ) {
    const doc = view.dom.ownerDocument;
    this.layer = el("div", `cm-cmt-sheet-layer cm-cmt-sheet-${placement}`);
    this.layer.hidden = true;
    this.panel = el("div", "cm-cmt-sheet");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Comment thread");
    this.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.close();
    });
    if (placement === "viewport") {
      const scrim = el("div", "cm-cmt-scrim");
      scrim.addEventListener("click", () => this.close());
      this.layer.append(scrim, this.panel);
      doc.body.append(this.layer);
    } else {
      this.layer.append(this.panel);
      view.scrollDOM.append(this.layer);
    }

    this.chip = button("Comment", "cm-cmt-float", () => {
      const range = this.pressed ?? commentableSelection(this.view.state);
      this.pressed = null;
      if (range !== null) startCommentOn(this.view, range);
    });
    this.chip.hidden = true;
    this.chip.setAttribute("aria-label", "Comment on the selection");
    // Remember the words at the moment of the press: on a phone the tap can
    // collapse the selection before the click arrives.
    this.chip.addEventListener("pointerdown", (event) => {
      this.pressed = commentableSelection(this.view.state);
      event.preventDefault();
    });
    view.scrollDOM.append(this.chip);

    this.viewport = placement === "viewport" ? (doc.defaultView?.visualViewport ?? null) : null;
    this.viewport?.addEventListener("resize", this.keepAboveKeyboard);
    this.viewport?.addEventListener("scroll", this.keepAboveKeyboard);
    this.sync();
  }

  update(update: ViewUpdate) {
    const uiChanged = update.startState.field(commentUi) !== update.state.field(commentUi);
    if (update.docChanged || uiChanged || update.selectionSet || update.geometryChanged || update.focusChanged) this.sync();
  }

  destroy() {
    this.destroyed = true;
    this.viewport?.removeEventListener("resize", this.keepAboveKeyboard);
    this.viewport?.removeEventListener("scroll", this.keepAboveKeyboard);
    this.layer.remove();
    this.chip.remove();
  }

  private close() {
    const ui = this.view.state.field(commentUi);
    const effects = [];
    if (ui.draft !== null) effects.push(setDraft.of(null));
    if (ui.active !== null) effects.push(setActiveThread.of(null));
    if (effects.length > 0) this.view.dispatch({ effects });
  }

  private sync() {
    if (this.destroyed) return;
    const narrow = !hasMargin(this.view.scrollDOM.clientWidth);
    const content = narrow ? sheetContent(this.view) : null;
    const editable = canComment(this.view.state);
    const signIn = this.view.state.facet(commentHost).signIn?.() !== undefined;

    if (content === null) {
      this.layer.hidden = true;
      this.panel.replaceChildren();
      this.signature = null;
    } else {
      const signature = JSON.stringify(
        content.kind === "draft"
          ? ["draft"]
          : [content.thread.id, content.thread.events, content.thread.status, content.thread.anchored, editable, signIn],
      );
      if (signature !== this.signature) {
        const opening = this.signature === null;
        const next = el("div", "cm-cmt-sheet-body");
        this.fill(next, content, editable, signIn);
        const previous = this.panel.firstElementChild as HTMLElement | null;
        if (previous) carryOver(previous, next);
        this.panel.replaceChildren(next);
        this.signature = signature;
        this.layer.hidden = false;
        if (opening && content.kind === "draft") queueMicrotask(() => this.panel.querySelector("textarea")?.focus());
      }
      this.keepAboveKeyboard();
    }

    const chipRange = narrow && content === null ? commentableSelection(this.view.state) : null;
    this.chip.hidden = chipRange === null;
    this.view.requestMeasure({
      key: this,
      read: () => this.measure(content, chipRange),
      write: (at) => this.place(at),
    });
  }

  private fill(body: HTMLElement, content: Content, editable: boolean, signIn: boolean) {
    body.append(el("div", "cm-cmt-grab"));
    const head = el("div", "cm-cmt-sheet-head");
    const quote = content.kind === "draft" ? content.quote : content.thread.quote;
    head.append(el("h3", "cm-cmt-sheet-title", `On “${quoteLabel(quote)}”`));
    if (content.kind === "thread" && content.thread.status === "resolved") {
      head.append(el("span", "cm-cmt-badge", "Resolved"));
    }
    const close = button("×", "cm-cmt-close", () => this.close());
    close.setAttribute("aria-label", "Close");
    head.append(close);
    body.append(head);

    if (content.kind === "draft") {
      const { root } = composer("Add a comment…", (text) => submitDraft(this.view, text), () => this.close());
      const actions = el("div", "cm-cmt-actions");
      actions.append(
        button("Cancel", "cm-cmt-link", () => this.close()),
        button("Comment", "cm-cmt-primary", () => {
          const input = body.querySelector("textarea");
          const text = input?.value.trim() ?? "";
          if (!text) return input?.focus();
          report(body, submitDraft(this.view, text));
        }),
      );
      body.append(root, actions);
      return;
    }

    const thread = content.thread;
    const list = el("div", "cm-cmt-sheet-list");
    if (!thread.anchored) list.append(el("div", "cm-cmt-detached", "The highlighted text was deleted"));
    for (const event of messages(thread)) list.append(message(event.author, event.at, event.text));
    body.append(list);

    const closed = resolvedBy(thread);
    if (closed) {
      const line = el("div", "cm-cmt-resolved", `Resolved by ${closed.author}`);
      line.title = closed.at;
      if (editable) line.append(button("Reopen", "cm-cmt-link", () => report(body, addToThread(this.view, thread.id, "reopened"))));
      body.append(line);
      return;
    }
    if (editable) {
      const { root } = composer("Reply…", (text) => addToThread(this.view, thread.id, "comment", text), () => this.close());
      const actions = el("div", "cm-cmt-actions");
      actions.append(
        button("Resolve", "cm-cmt-resolve", () => report(body, addToThread(this.view, thread.id, "resolved"))),
        button("Reply", "cm-cmt-primary", () => {
          const input = body.querySelector("textarea");
          const text = input?.value.trim() ?? "";
          if (!text) return input?.focus();
          const error = addToThread(this.view, thread.id, "comment", text);
          if (error === null && input) input.value = "";
          report(body, error);
        }),
      );
      body.append(root, actions);
      return;
    }
    if (signIn) {
      // Drawn as the field it stands in for, so a visitor sees where a reply
      // would go; pressing it is the way to be able to write one.
      body.append(
        button("Sign in to reply", "cm-cmt-signin", () => this.view.state.facet(commentHost).signIn?.()?.()),
      );
    }
  }

  private measure(content: Content | null, chipRange: { from: number; to: number } | null) {
    const view = this.view;
    const scroller = view.scrollDOM;
    try {
      const box = scroller.getBoundingClientRect();
      const offset = view.documentTop - box.top + scroller.scrollTop;
      const contentRect = view.contentDOM.getBoundingClientRect();
      const style = getComputedStyle(view.contentDOM);
      const left = contentRect.left - box.left + scroller.scrollLeft + (parseFloat(style.paddingLeft) || 0);
      const right = contentRect.right - box.left + scroller.scrollLeft - (parseFloat(style.paddingRight) || 0);
      const length = view.state.doc.length;
      const panelTop =
        this.placement === "inline" && content !== null ? view.lineBlockAt(Math.min(content.pos, length)).bottom + offset + 6 : null;
      let chip: { top: number; left: number } | null = null;
      if (chipRange !== null) {
        const end = view.coordsAtPos(chipRange.to, -1);
        if (end !== null) {
          const width = this.chip.offsetWidth || 96;
          const x = end.left - box.left + scroller.scrollLeft - width / 2;
          chip = {
            // Under the end of the selection: the phone's own Copy menu sits above it.
            top: end.bottom - box.top + scroller.scrollTop + 14,
            left: Math.max(8, Math.min(x, scroller.clientWidth - width - 8)),
          };
        }
      }
      return { panelTop, left, width: Math.max(0, right - left), chip };
    } catch {
      // Measuring reads layout through range APIs, which can fail mid-reflow
      // (and are absent under jsdom). A misplaced chip is not worth a crash.
      return { panelTop: null, left: 0, width: 0, chip: null };
    }
  }

  private place(at: ReturnType<Sheet["measure"]>) {
    if (this.destroyed) return;
    if (at.panelTop !== null) {
      this.layer.style.top = `${at.panelTop}px`;
      this.layer.style.left = `${at.left}px`;
      this.layer.style.width = `${at.width}px`;
    }
    if (at.chip !== null) {
      this.chip.style.top = `${at.chip.top}px`;
      this.chip.style.left = `${at.chip.left}px`;
    }
  }

  /**
   * Lift the sheet over the on-screen keyboard. iOS Safari draws the keyboard
   * over the page without shrinking the layout viewport, so a sheet fixed to
   * the bottom would sit under it with the reply field hidden.
   */
  private readonly keepAboveKeyboard = () => {
    const viewport = this.viewport;
    const win = this.view.dom.ownerDocument.defaultView;
    if (viewport === null || win === null) return;
    const covered = Math.max(0, win.innerHeight - (viewport.height + viewport.offsetTop));
    this.panel.style.bottom = covered > 0 ? `${Math.round(covered)}px` : "";
  };
}

/** The phone's comment sheet and selection chip; see the header. */
export function commentSheet(options: { placement: SheetPlacement }): Extension {
  return ViewPlugin.define((view) => new Sheet(view, options.placement));
}
