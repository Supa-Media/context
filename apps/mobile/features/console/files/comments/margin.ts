/**
 * The comments margin: on a pane wide enough for it, a column beside the note
 * where its threads live, each next to its words (Dev2, 2026-11-21, artifact
 * MVahUoUgRPthkPk5NMGzXc: "the comment box blocks what's being edited"; "a
 * comment side panel … current comment and old comments … resolved").
 *
 * When the note has a thread, or one is being written, the text column steps
 * left (`.cm-cmt-margin` on the scroller) and the margin opens on its right:
 *
 *  - a head, "Comments", and a "Resolved (N)" toggle that shows the resolved
 *    threads too;
 *  - a small card per other thread, at its words' line, pushed down so cards
 *    never overlap each other or the open one; a press opens it;
 *  - the open thread itself is `popover.ts`'s card, placed in this column by
 *    `marginColumn`.
 *
 * A pane too thin for the column keeps the note centred, and `popover.ts`
 * docks the open card to the bottom instead. A phone has the sheet.
 *
 * Built with `textContent` only, as `dom.ts` is.
 */

import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { CommentThread } from "@context/shared/src/comments.cjs";
import { commentUi, commentsParsed, setActiveThread } from "./extension";
import { avatar, el } from "./dom";
import { MARGIN_PX, hasMargin, messages } from "./model";
import { texRuns } from "./tex/runner";

/** The gap between the text column and the cards. */
const INSET = 16;
/** The least space the text keeps beside the column, so the column never squeezes it to nothing. */
const SPARE = 32;
const STACK_GAP = 8;
/** Room at the column's top for its head. */
const HEAD_PX = 36;

/** Whether this pane can hold the column beside the note's measure. */
function roomFor(view: EditorView): boolean {
  const content = view.contentDOM;
  const style = getComputedStyle(content);
  const measureEm = parseFloat(style.getPropertyValue("--lp-measure")) || 0;
  const fontPx = parseFloat(style.fontSize) || 16;
  const width = content.clientWidth;
  if (!hasMargin(view.scrollDOM.clientWidth)) return false;
  return width >= measureEm * fontPx + MARGIN_PX + SPARE;
}

/** Whether the note has anything for the margin: a thread, or one being written. */
function wanted(view: EditorView): boolean {
  const state = view.state;
  const ui = state.field(commentUi, false);
  const parsed = state.field(commentsParsed, false);
  if (ui === undefined || parsed === undefined) return false;
  return ui.draft !== null || ui.active !== null || parsed.threads.some((thread) => parsed.anchors.has(thread.id));
}

/**
 * Where the column is, in the scroller's own coordinates (its scroll included),
 * or null when this pane shows no column.
 */
export function marginColumn(view: EditorView): { left: number } | null {
  if (!view.scrollDOM.classList.contains("cm-cmt-margin")) return null;
  const box = view.scrollDOM.getBoundingClientRect();
  const content = view.contentDOM.getBoundingClientRect();
  return { left: content.right - box.left + view.scrollDOM.scrollLeft - MARGIN_PX + INSET };
}

interface Placed {
  id: string;
  top: number;
}

/** Each card's top: at its words, below the card above it, and clear of the open one. */
export function stack(wants: { id: string; top: number; height: number }[], open: { top: number; height: number } | null, floor: number): Placed[] {
  const placed: Placed[] = [];
  let next = floor;
  for (const one of [...wants].sort((a, b) => a.top - b.top)) {
    let top = Math.max(one.top, next);
    if (open !== null && top < open.top + open.height + STACK_GAP && top + one.height + STACK_GAP > open.top) top = open.top + open.height + STACK_GAP;
    placed.push({ id: one.id, top });
    next = top + one.height + STACK_GAP;
  }
  return placed;
}

class Margin implements PluginValue {
  private layer: HTMLElement | null = null;
  private showResolved = false;
  private readonly cardsKey = {};
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.schedule();
  }

  update(update: ViewUpdate) {
    const { startState, state } = update;
    if (
      update.docChanged ||
      update.geometryChanged ||
      update.viewportChanged ||
      startState.field(commentUi, false) !== state.field(commentUi, false) ||
      // The open card grows as Tex works, and the cards under it move down.
      startState.field(texRuns, false) !== state.field(texRuns, false)
    ) {
      this.schedule();
    }
  }

  destroy() {
    this.destroyed = true;
    this.view.scrollDOM.classList.remove("cm-cmt-margin");
    this.layer?.remove();
    this.layer = null;
  }

  private schedule() {
    this.view.requestMeasure({
      key: this,
      // The text's padding moves with the column, never its width, so the room is the same either way.
      read: () => wanted(this.view) && roomFor(this.view),
      write: (on) => this.draw(on),
    });
  }

  private draw(on: boolean) {
    if (this.destroyed) return;
    const scroller = this.view.scrollDOM;
    const was = scroller.classList.contains("cm-cmt-margin");
    if (on !== was) {
      scroller.classList.toggle("cm-cmt-margin", on);
      // The text column moved: measure again with it where it now is.
      this.view.requestMeasure();
    }
    if (!on) {
      this.layer?.remove();
      this.layer = null;
      return;
    }
    this.view.requestMeasure({ key: this.cardsKey, read: () => this.positions(), write: (placed) => this.render(placed) });
  }

  private threads(): { thread: CommentThread; from: number }[] {
    const state = this.view.state;
    const parsed = state.field(commentsParsed);
    const active = state.field(commentUi).active;
    return parsed.threads
      .filter((thread) => thread.id !== active && (thread.status === "open" || this.showResolved))
      .map((thread) => ({ thread, from: parsed.anchors.get(thread.id)?.from ?? -1 }))
      .filter((one) => one.from >= 0);
  }

  private positions(): { head: { left: number }; cards: { thread: CommentThread; top: number }[]; resolved: number } | null {
    const column = marginColumn(this.view);
    if (column === null) return null;
    const scroller = this.view.scrollDOM;
    const box = scroller.getBoundingClientRect();
    const open = scroller.querySelector<HTMLElement>(":scope > .cm-cw");
    const openBox = open !== null && open.style.visibility !== "hidden" ? { top: open.offsetTop, height: open.offsetHeight } : null;
    const wants = this.threads().map(({ thread, from }) => {
      const at = this.view.coordsAtPos(from, 1);
      return { thread, id: thread.id, top: at ? at.top - box.top + scroller.scrollTop - 6 : 0, height: this.heightOf(thread.id) };
    });
    const placed = stack(wants, openBox, HEAD_PX);
    const parsed = this.view.state.field(commentsParsed);
    const resolved = parsed.threads.filter((thread) => thread.status === "resolved" && parsed.anchors.has(thread.id)).length;
    return {
      head: { left: column.left },
      cards: placed.map((one) => ({ thread: wants.find((want) => want.id === one.id)!.thread, top: one.top })),
      resolved,
    };
  }

  /** A card's height as last drawn, or a guess for one not drawn yet. */
  private heightOf(id: string): number {
    const node = this.layer?.querySelector<HTMLElement>(`[data-margin-thread="${CSS.escape(id)}"]`);
    return node?.offsetHeight ?? 56;
  }

  private render(placed: ReturnType<Margin["positions"]>) {
    if (this.destroyed || placed === null) return;
    const layer = el("div", "cm-cmargin");
    layer.setAttribute("aria-label", "Comments");
    const head = el("div", "cm-cmargin-head");
    head.style.left = `${placed.head.left}px`;
    head.append(el("b", undefined, "Comments"));
    if (placed.resolved > 0) {
      const toggle = el("button", "cm-cmargin-toggle", this.showResolved ? `Hide resolved (${placed.resolved})` : `Resolved (${placed.resolved})`);
      toggle.type = "button";
      toggle.setAttribute("aria-pressed", String(this.showResolved));
      toggle.addEventListener("mousedown", (event) => event.preventDefault());
      toggle.addEventListener("click", () => {
        this.showResolved = !this.showResolved;
        this.schedule();
      });
      head.append(toggle);
    }
    layer.append(head);
    for (const { thread, top } of placed.cards) layer.append(this.card(thread, top, placed.head.left));
    if (this.layer) this.layer.replaceWith(layer);
    else this.view.scrollDOM.append(layer);
    this.layer = layer;
  }

  private card(thread: CommentThread, top: number, left: number): HTMLElement {
    const all = messages(thread);
    const first = all[0];
    const card = el("button", thread.status === "resolved" ? "cm-cmini cm-cmini-resolved" : "cm-cmini");
    card.type = "button";
    card.dataset.marginThread = thread.id;
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
    const who = el("div", "cm-cmini-who");
    if (first) {
      const face = avatar(first.author);
      face.setAttribute("aria-hidden", "true");
      who.append(face, el("b", undefined, first.author.replace(/^@/, "")));
    }
    if (all.length > 1) who.append(el("span", "cm-cmini-more", `${all.length - 1} ${all.length === 2 ? "reply" : "replies"}`));
    if (thread.status === "resolved") who.append(el("span", "cm-cmini-more", "Resolved"));
    card.append(who, el("div", "cm-cmini-body", first?.text ?? thread.quote));
    card.setAttribute("aria-label", `Open the comment on ${thread.quote}`);
    card.addEventListener("mousedown", (event) => event.preventDefault());
    card.addEventListener("click", () => this.view.dispatch({ effects: setActiveThread.of(thread.id) }));
    return card;
  }
}

export const commentMargin = ViewPlugin.fromClass(Margin);
