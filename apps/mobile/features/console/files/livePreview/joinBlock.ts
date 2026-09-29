/**
 * ```` ```join ```` fences: the homepage's waitlist field, placed by the page.
 *
 * An author writes an empty `join` fence where the field belongs
 * (`packages/shared/src/websiteJoin.ts`). This draws it as a box the homepage
 * fills with its join card (`joinSlot.ts`), and anywhere nothing fills it, as
 * a quiet row naming what goes there. The source comes back when the caret
 * reaches it, the reveal rule every folded block here follows.
 *
 * Part of the Live Preview extension; `../livePreview.ts` is the facade.
 */

import type { EditorState } from "@codemirror/state";
import { EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { JOIN_OPEN } from "@context/shared/src/websiteJoin";
import { revealSelection } from "./engagement";
import { selectionTouches } from "./reveal";
import { addJoinSlot, removeJoinSlot } from "./joinSlot";

export interface JoinFence {
  readonly from: number;
  readonly to: number;
}

/** Every closed join fence at the margin that the selection does not touch. */
export function joinFences(state: EditorState, frontEnd = 0): JoinFence[] {
  const found: JoinFence[] = [];
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter(node) {
      if (node.name !== "FencedCode") return;
      if (node.from < frontEnd) return false;
      const open = state.doc.lineAt(node.from);
      if (open.from !== node.from || !JOIN_OPEN.test(open.text)) return false;
      if (state.doc.lineAt(node.to).to !== node.to) return false;
      if (node.node.getChildren("CodeMark").length < 2) return false;
      found.push({ from: node.from, to: node.to });
      return false;
    },
  });
  if (found.length === 0) return [];
  const selection = revealSelection(state);
  return found.filter((fence) => !selectionTouches(fence, selection));
}

export const JOIN_LABEL = "Waitlist sign-up";

/**
 * The box. Every instance is equal, so CodeMirror keeps one box across redraws
 * and the card in it keeps its focus and whatever was typed.
 */
export class JoinWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("div");
    box.className = "cm-lp-join";
    const label = document.createElement("div");
    label.className = "cm-lp-cast";
    label.setAttribute("role", "button");
    label.setAttribute("aria-label", `${JOIN_LABEL}. Shown on the homepage.`);
    const name = document.createElement("span");
    name.className = "cm-lp-cast-name";
    name.textContent = JOIN_LABEL;
    const where = document.createElement("span");
    where.className = "cm-lp-cast-count";
    where.textContent = "· shown on the homepage";
    label.append(name, where);
    label.addEventListener("click", (event) => {
      event.preventDefault();
      if (view.state.readOnly) return;
      view.dispatch({
        selection: { anchor: view.posAtDOM(box) },
        userEvent: "select.pointer",
        scrollIntoView: true,
      });
      view.focus();
    });
    box.append(label);
    addJoinSlot({ box, label });
    return box;
  }

  destroy(dom: HTMLElement): void {
    removeJoinSlot(dom);
  }

  /* The card inside takes its own typing and presses. */
  ignoreEvent(): boolean {
    return true;
  }
}
