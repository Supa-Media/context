/**
 * The selection toolbar: a small dark bar above a selection on a wide pane,
 * with a Comment button and, where Tex is in the note, a Tex button. Each shows
 * its shortcut (⌘M and ⌘L; Ctrl on other systems), as in the mock
 * (https://claude.ai/artifact/G8Udcec7fUh8jD7dnHkUN7).
 *
 * It is drawn only when there is something to comment on (`commentableSelection`),
 * the editor has focus, and no comment is being written or open. It is never
 * drawn on a phone: the sheet has its own Comment chip there. The buttons
 * keep the selection (mousedown is prevented), and Escape hides the bar until
 * the selection changes.
 */

import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import { isApplePlatform } from "../../../design/applePlatform";
import { el } from "./dom";
import { commentableSelection, commentUi, startComment, startTexComment } from "./extension";
import { hasMargin } from "./model";
import { chatIcon } from "./popoverDom";
import { texInNoteHost } from "./tex/contract";
import { texMarkNode } from "../../../chaos/texMarkDom";

/** How far above the selection's start the bar sits. */
const LIFT = 42;

function toolButton(view: EditorView, label: string, shortcut: string, face: Node, run: (view: EditorView) => boolean): HTMLButtonElement {
  const node = el("button", "cm-seltool-btn");
  node.type = "button";
  node.title = `${label} (${shortcut})`;
  node.setAttribute("aria-label", `${label}, ${shortcut}`);
  node.append(face, el("kbd", undefined, shortcut));
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    run(view);
  });
  return node;
}

class SelTool implements PluginValue {
  private readonly node = el("div", "cm-seltool");
  private built: "tex" | "plain" | null = null;
  private dismissed = false;

  private readonly onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !this.node.hidden) {
      this.dismissed = true;
      this.node.hidden = true;
    }
  };

  constructor(private readonly view: EditorView) {
    this.node.hidden = true;
    this.node.setAttribute("role", "toolbar");
    this.node.setAttribute("aria-label", "Selection");
    // The bar's buttons never take the selection away.
    this.node.addEventListener("mousedown", (event) => event.preventDefault());
    view.scrollDOM.append(this.node);
    view.contentDOM.addEventListener("keydown", this.onKeydown);
    this.sync();
  }

  update(update: ViewUpdate) {
    if (update.selectionSet || update.docChanged) this.dismissed = false;
    if (
      update.selectionSet ||
      update.docChanged ||
      update.focusChanged ||
      update.geometryChanged ||
      update.viewportChanged ||
      update.startState.field(commentUi) !== update.state.field(commentUi)
    ) {
      this.sync();
    }
  }

  destroy() {
    this.view.contentDOM.removeEventListener("keydown", this.onKeydown);
    this.node.remove();
  }

  private sync() {
    const view = this.view;
    const state = view.state;
    const range = this.dismissed || !view.hasFocus || state.field(commentUi).active !== null ? null : commentableSelection(state);
    if (range === null || !hasMargin(view.scrollDOM.clientWidth)) {
      this.node.hidden = true;
      return;
    }
    this.buttons(state.facet(texInNoteHost) !== null);
    this.node.hidden = false;
    view.requestMeasure({
      key: this,
      read: () => this.measure(range.from),
      write: (place) => {
        if (place === null) {
          this.node.hidden = true;
          return;
        }
        this.node.style.top = `${place.top}px`;
        this.node.style.left = `${place.left}px`;
      },
    });
  }

  /** Above the selection's start, clamped inside the pane. */
  private measure(from: number): { top: number; left: number } | null {
    const scroller = this.view.scrollDOM;
    const start = this.view.coordsAtPos(from, 1);
    if (!start) return null;
    const box = scroller.getBoundingClientRect();
    const width = this.node.offsetWidth;
    const left = Math.max(0, Math.min(start.left - box.left, scroller.clientWidth - width));
    const top = Math.max(0, start.top - box.top - LIFT);
    return { top: top + scroller.scrollTop, left: left + scroller.scrollLeft };
  }

  private buttons(tex: boolean) {
    const kind = tex ? "tex" : "plain";
    if (this.built === kind) return;
    this.built = kind;
    const mac = isApplePlatform();
    const comment = toolButton(this.view, "Comment", mac ? "⌘M" : "Ctrl+M", chatIcon(), startComment);
    const nodes: HTMLElement[] = [comment];
    if (tex) {
      nodes.push(toolButton(this.view, "Ask Tex", mac ? "⌘L" : "Ctrl+L", texMarkNode("cm-texbtn", 18), startTexComment));
    }
    this.node.replaceChildren(...nodes);
  }
}

export const seltool = ViewPlugin.fromClass(SelTool);
