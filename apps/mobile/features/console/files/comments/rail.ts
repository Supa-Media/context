/**
 * The comment margin: one card per thread, level with the words it is about.
 *
 * Dev2 chose this over a Comments tab (2026-09-27, artboard
 * https://claude.ai/artifact/NXsmw6ntLoFpmrK62NESfB) because the link between a
 * card and its line is the point: you see which words a comment is about
 * without clicking anything.
 *
 * ## Two layouts, decided by the pane's width
 *
 *  - **Wide**: every visible thread has a card beside its line. `stackCards`
 *    keeps them from overlapping and keeps the active one exactly level with
 *    its words.
 *
 *    **The text never moves when a card opens** (Dev2, 2026-09-27, mockup
 *    https://claude.ai/artifact/42zcZ2oQ5dBEmhw4SJDhGJ). On a desktop window
 *    the space right of the centred column is already wider than a card, so
 *    the cards sit there and the note stays put. A pane with a little less room
 *    moves the column left by just the shortfall, and decides that from its
 *    width and whether the note has comments at all, never from which card is
 *    open. Cards fade in and glide to their lines instead of appearing.
 *  - **Narrow** (a phone, a thin pane): there is no margin to put cards in, so
 *    the rail draws nothing and `sheet.ts` takes over: tapping a highlight
 *    opens its thread in a bottom sheet, and a selection offers a floating
 *    Comment chip. The rail and the sheet read the same width rule
 *    (`hasMargin`), so exactly one of them is showing threads at a time.
 *
 * ## Plain DOM, and never `innerHTML`
 *
 * The rail lives inside CodeMirror's scroller so cards scroll with the text,
 * which rules out a React tree (it would have to be portalled into a node the
 * editor owns and re-rendered on every scroll). Cards are built from `dom.ts`,
 * which uses `createElement` and `textContent` only.
 */

import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { CommentEvent, CommentThread } from "@context/shared/src/comments.cjs";
import {
  addToThread,
  canComment,
  canDeleteComment,
  commentHost,
  commentUi,
  commentableSelection,
  commentsParsed,
  setActiveThread,
  setDraft,
  removeFromThread,
  setShowResolved,
  startComment,
  submitDraft,
} from "./extension";
import { button, carryOver, composer, el, message, report, type Deletion } from "./dom";
import { eventsKey, hasMargin, messages, resolvedBy, stackCards, visibleThreads } from "./model";

/** The margin the note gives up when it has comments: the card width plus air. */
export const RAIL_RESERVE = 300;
const CARD_WIDTH = 256;
/** The air between the reading column and a card, and between a card and the edge. */
const CARD_GAP = 20;
const HEAD = "__head";
const DRAFT = "__draft";
const CHIP = "__chip";

/**
 * How far (px) the reading column moves left to make room for the cards; 0 when
 * the space beside it is already enough. A state field rather than a class
 * toggled on the editor's element: CodeMirror owns that element's attributes
 * and rewrites them on update, which dropped a hand-added class between frames
 * and let the text slide back under the cards.
 */
const setMarginShift = StateEffect.define<number>();
const marginShift = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMarginShift)) value = effect.value;
    return value;
  },
  provide: (field) =>
    EditorView.editorAttributes.from(field, (shift): Record<string, string> => (shift > 0 ? { class: "cm-cmt-wide", style: `--cmt-shift: ${shift}px` } : {})),
});

/** The column's shift for a given room beside it, in steps so small resizes don't churn. */
export function shiftFor(gutter: number): number {
  const shortfall = CARD_WIDTH + 2 * CARD_GAP - gutter;
  return shortfall <= 0 ? 0 : Math.min(RAIL_RESERVE, Math.ceil(shortfall / 8) * 8);
}

interface CardSpec {
  id: string;
  /** Document position whose line the card sits beside. */
  pos: number;
  signature: string;
  build: () => HTMLElement;
}

class Rail implements PluginValue {
  private readonly dom: HTMLDivElement;
  private readonly cards = new Map<string, { node: HTMLElement; signature: string; pos: number }>();
  private wide = false;
  private hasComments = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.dom = el("div", "cm-cmt-rail");
    this.dom.setAttribute("aria-label", "Comments");
    view.scrollDOM.append(this.dom);
    this.sync();
  }

  update(update: ViewUpdate) {
    const uiChanged = update.startState.field(commentUi) !== update.state.field(commentUi);
    // The column's shift moves every card with it, so a new shift is a new
    // layout even though nothing else about the note changed.
    const shiftChanged = update.startState.field(marginShift) !== update.state.field(marginShift);
    if (update.docChanged || uiChanged || shiftChanged || update.selectionSet || update.geometryChanged || update.viewportChanged) {
      this.sync();
    }
  }

  destroy() {
    this.destroyed = true;
    this.dom.remove();
  }

  private specs(): CardSpec[] {
    // No margin: the phone's bottom sheet (`sheet.ts`) shows threads instead.
    if (!this.wide) return [];
    const state = this.view.state;
    const parsed = state.field(commentsParsed);
    const ui = state.field(commentUi);
    const editable = canComment(state);
    const moderator = state.facet(commentHost).moderator?.() ?? false;
    const threads = visibleThreads(parsed.threads, ui.showResolved);
    const specs: CardSpec[] = [];
    const resolvedCount = parsed.threads.filter((thread) => thread.status === "resolved").length;

    if (resolvedCount > 0) {
      specs.push({
        id: HEAD,
        pos: 0,
        signature: `head:${resolvedCount}:${ui.showResolved}`,
        build: () => this.header(resolvedCount, ui.showResolved),
      });
    }
    for (const thread of threads) {
      const anchor = parsed.anchors.get(thread.id);
      const active = ui.active === thread.id;
      specs.push({
        id: thread.id,
        pos: anchor?.from ?? 0,
        signature: JSON.stringify([eventsKey(thread), thread.status, thread.anchored, active, editable, moderator]),
        build: () => this.threadCard(thread, active, editable),
      });
    }
    if (ui.draft !== null) {
      specs.push({ id: DRAFT, pos: ui.draft.from, signature: "draft", build: () => this.draftCard() });
    } else {
      const selection = commentableSelection(state);
      if (selection !== null) specs.push({ id: CHIP, pos: selection.from, signature: "chip", build: () => this.chip() });
    }
    return specs;
  }

  private sync() {
    if (this.destroyed) return;
    const parsed = this.view.state.field(commentsParsed);
    const ui = this.view.state.field(commentUi);
    // The mode is read from the scroller's width alone, never from the content
    // column, so reserving the margin cannot flip it back.
    this.wide = hasMargin(this.view.scrollDOM.clientWidth);
    this.hasComments = parsed.threads.length > 0 || ui.draft !== null;

    const specs = this.specs();
    const keep = new Set(specs.map((spec) => spec.id));
    for (const [id, card] of this.cards) {
      if (!keep.has(id)) {
        card.node.remove();
        this.cards.delete(id);
      }
    }
    for (const spec of specs) {
      const existing = this.cards.get(spec.id);
      if (existing && existing.signature === spec.signature) {
        existing.pos = spec.pos;
        continue;
      }
      const node = spec.build();
      if (existing) {
        // A rebuilt card (it became active, a reply arrived) keeps its place
        // and does not play its entrance again.
        carryOver(existing.node, node);
        node.style.cssText = existing.node.style.cssText;
        node.classList.add("cm-cmt-placed");
        existing.node.replaceWith(node);
      } else {
        node.classList.add("cm-cmt-enter");
        this.dom.append(node);
      }
      this.cards.set(spec.id, { node, signature: spec.signature, pos: spec.pos });
      if (spec.id === DRAFT && !existing) queueMicrotask(() => node.querySelector("textarea")?.focus());
    }
    this.view.requestMeasure({ key: this, read: () => this.measure(), write: (layout) => this.place(layout) });
  }

  private measure() {
    const view = this.view;
    const scroller = view.scrollDOM;
    const scrollerRect = scroller.getBoundingClientRect();
    const contentRect = view.contentDOM.getBoundingClientRect();
    const style = getComputedStyle(view.contentDOM);
    const offset = view.documentTop - scrollerRect.top + scroller.scrollTop;
    const columnRight = contentRect.right - scrollerRect.left + scroller.scrollLeft - parseFloat(style.paddingRight || "0");
    // The room right of the column when the note keeps its usual centred
    // layout. Read from the content box's full width and the measure, neither
    // of which the margin changes, so reserving it cannot undo the decision.
    const measure = parseFloat(style.getPropertyValue("--lp-measure")) * parseFloat(style.fontSize);
    const gutter = Number.isFinite(measure) ? (contentRect.width - measure) / 2 : 0;
    // Where the column's right edge is when centred, whatever padding it has
    // this frame: the shift eases in over 220ms, and a card placed against the
    // column mid-ease would be left behind (off the pane's edge) until the next
    // update moved it.
    const centredRight =
      Number.isFinite(measure) && gutter >= 0 ? contentRect.left - scrollerRect.left + scroller.scrollLeft + gutter + measure : null;
    const length = view.state.doc.length;
    const cards = [...this.cards].map(([id, card]) => {
      const block = view.lineBlockAt(Math.min(card.pos, length));
      return { id, top: block.top + offset, height: card.node.offsetHeight };
    });
    return { cards, columnRight, centredRight, offset, gutter };
  }

  private place(layout: ReturnType<Rail["measure"]>) {
    if (this.destroyed) return;
    const active = this.view.state.field(commentUi).active;
    const shift = this.wide && this.hasComments ? shiftFor(layout.gutter) : 0;
    if (shift !== this.view.state.field(marginShift)) {
      // Not from inside a measure cycle; the next frame lays the note out once
      // and places the cards against the new column.
      requestAnimationFrame(() => {
        if (!this.destroyed && this.view.state.field(marginShift) !== shift) {
          this.view.dispatch({ effects: setMarginShift.of(shift) });
        }
      });
    }
    if (this.wide) {
      // Against where the column is going, not where it is mid-ease.
      const left = (layout.centredRight === null ? layout.columnRight : layout.centredRight - shift) + CARD_GAP;
      const focus = this.cards.has(DRAFT) ? DRAFT : active;
      const placed = stackCards(
        layout.cards.map((card) => ({ id: card.id, want: card.id === HEAD ? layout.offset : card.top, height: card.height })),
        focus,
      );
      for (const { id, top } of placed) {
        const node = this.cards.get(id)?.node;
        if (!node) continue;
        node.style.top = `${Math.max(0, top)}px`;
        node.style.left = `${left}px`;
        // The Comment button sits at the margin's edge at its own size.
        node.style.width = id === CHIP ? "auto" : `${CARD_WIDTH}px`;
        settle(node);
      }
    }
  }

  private header(resolvedCount: number, showResolved: boolean): HTMLElement {
    const head = el("div", "cm-cmt-head");
    const toggle = button(
      showResolved ? `Hide resolved (${resolvedCount})` : `Show resolved (${resolvedCount})`,
      "cm-cmt-link",
      () => this.view.dispatch({ effects: setShowResolved.of(!showResolved) }),
    );
    toggle.setAttribute("aria-pressed", String(showResolved));
    head.append(toggle);
    return head;
  }

  private threadCard(thread: CommentThread, active: boolean, editable: boolean): HTMLElement {
    const resolved = thread.status === "resolved";
    const card = el("div", `cm-cmt-card${active ? " cm-cmt-card-active" : ""}${resolved ? " cm-cmt-card-resolved" : ""}`);
    card.dataset.thread = thread.id;
    card.addEventListener("mousedown", (event) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement) return;
      if (this.view.state.field(commentUi).active !== thread.id) {
        this.view.dispatch({ effects: setActiveThread.of(thread.id) });
      }
    });
    if (!thread.anchored) {
      card.append(el("div", "cm-cmt-quote", thread.quote));
      card.append(el("div", "cm-cmt-detached", "The highlighted text was deleted"));
    }
    messages(thread).forEach((event, index) => card.append(message(event.author, event.at, event.text, this.deletion(thread, index, event))));
    const closed = resolvedBy(thread);
    if (closed) {
      const line = el("div", "cm-cmt-resolved", `Resolved by ${closed.author}`);
      line.title = closed.at;
      if (editable) {
        line.append(button("Reopen", "cm-cmt-link", () => report(card, addToThread(this.view, thread.id, "reopened"))));
      }
      card.append(line);
      return card;
    }
    if (!editable) return card;
    const actions = el("div", "cm-cmt-actions");
    actions.append(button("Resolve", "cm-cmt-resolve", () => report(card, addToThread(this.view, thread.id, "resolved"))));
    if (active) {
      const reply = composer("Reply…", (text) => addToThread(this.view, thread.id, "comment", text), () => this.view.dispatch({ effects: setActiveThread.of(null) }));
      card.append(reply.root);
    }
    card.append(actions);
    return card;
  }

  private deletion(thread: CommentThread, index: number, event: CommentEvent): Deletion | undefined {
    if (!canDeleteComment(this.view.state, event)) return undefined;
    return { thread: index === 0, run: () => removeFromThread(this.view, thread.id, index, event) };
  }

  private draftCard(): HTMLElement {
    const card = el("div", "cm-cmt-card cm-cmt-card-active");
    const { root } = composer(
      "Add a comment…",
      (text) => submitDraft(this.view, text),
      () => this.view.dispatch({ effects: setDraft.of(null) }),
    );
    const actions = el("div", "cm-cmt-actions");
    actions.append(
      button("Comment", "cm-cmt-primary", () => {
        const input = card.querySelector("textarea");
        const text = input?.value.trim() ?? "";
        if (!text) return input?.focus();
        const error = submitDraft(this.view, text);
        if (error !== null) report(card, error);
      }),
      button("Cancel", "cm-cmt-link", () => this.view.dispatch({ effects: setDraft.of(null) })),
    );
    card.append(root, actions);
    return card;
  }

  private chip(): HTMLElement {
    const chip = button("Comment", "cm-cmt-chip", () => {
      startComment(this.view);
    });
    chip.title = "Comment on the selection (⌘⌥M)";
    return chip;
  }

}

/**
 * After a card's first placement: let it fade in where it now stands, and from
 * then on glide rather than jump when the cards around it move.
 */
function settle(node: HTMLElement) {
  if (!node.classList.contains("cm-cmt-enter")) return;
  requestAnimationFrame(() => {
    node.classList.remove("cm-cmt-enter");
    node.classList.add("cm-cmt-placed");
  });
}


export const commentRail = [marginShift, ViewPlugin.fromClass(Rail)];
