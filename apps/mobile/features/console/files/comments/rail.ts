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
 *  - **Wide** (the pane has room for the reading column and a 300px margin):
 *    the note shifts left to make room and every visible thread has a card
 *    beside its line. `stackCards` keeps them from overlapping and keeps the
 *    active one exactly level with its words.
 *  - **Narrow**: there is no margin to put cards in, so only the active thread
 *    (or the comment being written) opens, as a card under its line. Clicking a
 *    highlight is how a thread is opened.
 *
 * ## Plain DOM, and never `innerHTML`
 *
 * The rail lives inside CodeMirror's scroller so cards scroll with the text,
 * which rules out a React tree (it would have to be portalled into a node the
 * editor owns and re-rendered on every scroll). It is built with
 * `createElement` and `textContent` only. Every name and word in a card came
 * out of a Markdown file that anybody with write access — or any agent — could
 * have written, so a string never reaches the DOM as markup.
 */

import { ViewPlugin, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { CommentThread } from "@context/shared/src/comments.cjs";
import {
  addToThread,
  canComment,
  commentUi,
  commentsParsed,
  setActiveThread,
  setDraft,
  setShowResolved,
  startComment,
  submitDraft,
} from "./extension";
import { initialsFor, isPerson, messages, resolvedBy, stackCards, visibleThreads, whenLabel } from "./model";

/** The margin the note gives up when it has comments: the card width plus air. */
export const RAIL_RESERVE = 300;
const CARD_WIDTH = 256;
/** Below this pane width a margin would squeeze the reading column too far. */
const WIDE_MIN = 780;
const HEAD = "__head";
const DRAFT = "__draft";
const CHIP = "__chip";

interface CardSpec {
  id: string;
  /** Document position whose line the card sits beside. */
  pos: number;
  signature: string;
  build: () => HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("mousedown", (event) => event.preventDefault());
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
}

function message(author: string, at: string, text: string): HTMLElement {
  const row = el("div", "cm-cmt-msg");
  const avatar = el("span", isPerson(author) ? "cm-cmt-av" : "cm-cmt-av cm-cmt-av-agent", initialsFor(author));
  avatar.setAttribute("aria-hidden", "true");
  const main = el("div", "cm-cmt-main");
  const who = el("div", "cm-cmt-who");
  who.append(el("b", undefined, author));
  if (!isPerson(author)) who.append(el("span", "cm-cmt-tag", "agent"));
  const when = el("span", "cm-cmt-when", whenLabel(at));
  when.title = at;
  who.append(when);
  main.append(who, el("div", "cm-cmt-body", text));
  row.append(avatar, main);
  return row;
}

/**
 * A textarea that sends on Enter and takes a new line on Shift-Enter, the
 * convention of every chat box a person already knows.
 */
function composer(placeholder: string, onSend: (text: string) => string | null, onCancel: () => void): { root: HTMLElement; input: HTMLTextAreaElement } {
  const root = el("div", "cm-cmt-compose");
  const input = el("textarea", "cm-cmt-input");
  input.placeholder = placeholder;
  input.rows = 1;
  input.setAttribute("aria-label", placeholder);
  const problem = el("div", "cm-cmt-problem");
  problem.hidden = true;
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    const error = onSend(text);
    if (error === null) {
      input.value = "";
      problem.hidden = true;
    } else {
      problem.textContent = error;
      problem.hidden = false;
    }
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  });
  root.append(input, problem);
  return { root, input };
}

class Rail implements PluginValue {
  private readonly dom: HTMLDivElement;
  private readonly cards = new Map<string, { node: HTMLElement; signature: string; pos: number }>();
  private wide = false;
  private destroyed = false;

  constructor(private readonly view: EditorView) {
    this.dom = el("div", "cm-cmt-rail");
    this.dom.setAttribute("aria-label", "Comments");
    view.scrollDOM.append(this.dom);
    this.sync();
  }

  update(update: ViewUpdate) {
    const uiChanged = update.startState.field(commentUi) !== update.state.field(commentUi);
    if (update.docChanged || uiChanged || update.selectionSet || update.geometryChanged || update.viewportChanged) {
      this.sync();
    }
  }

  destroy() {
    this.destroyed = true;
    this.dom.remove();
    this.view.dom.classList.remove("cm-cmt-wide");
  }

  private specs(): CardSpec[] {
    const state = this.view.state;
    const parsed = state.field(commentsParsed);
    const ui = state.field(commentUi);
    const editable = canComment(state);
    const threads = visibleThreads(parsed.threads, ui.showResolved);
    const specs: CardSpec[] = [];
    const resolvedCount = parsed.threads.filter((thread) => thread.status === "resolved").length;

    if (this.wide && resolvedCount > 0) {
      specs.push({
        id: HEAD,
        pos: 0,
        signature: `head:${resolvedCount}:${ui.showResolved}`,
        build: () => this.header(resolvedCount, ui.showResolved),
      });
    }
    for (const thread of threads) {
      if (!this.wide && ui.active !== thread.id) continue;
      const anchor = parsed.anchors.get(thread.id);
      const active = ui.active === thread.id;
      specs.push({
        id: thread.id,
        pos: anchor?.from ?? 0,
        signature: JSON.stringify([thread.events, thread.status, thread.anchored, active, editable, this.wide]),
        build: () => this.threadCard(thread, active, editable),
      });
    }
    if (ui.draft !== null) {
      specs.push({ id: DRAFT, pos: ui.draft.from, signature: "draft", build: () => this.draftCard() });
    } else if (this.wide && editable) {
      const selection = state.selection.main;
      const inBlock = parsed.block !== null && selection.from >= parsed.block.start;
      if (!selection.empty && !inBlock && state.sliceDoc(selection.from, selection.to).trim() !== "") {
        specs.push({ id: CHIP, pos: selection.from, signature: "chip", build: () => this.chip() });
      }
    }
    return specs;
  }

  private sync() {
    if (this.destroyed) return;
    const parsed = this.view.state.field(commentsParsed);
    const ui = this.view.state.field(commentUi);
    // The mode is read from the scroller's width alone, never from the content
    // column, so reserving the margin cannot flip it back.
    this.wide = this.view.scrollDOM.clientWidth >= WIDE_MIN;
    const reserve = this.wide && (parsed.threads.length > 0 || ui.draft !== null);
    this.view.dom.classList.toggle("cm-cmt-wide", reserve);
    this.dom.classList.toggle("cm-cmt-rail-narrow", !this.wide);

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
        carryOver(existing.node, node);
        existing.node.replaceWith(node);
      } else {
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
    const columnLeft = contentRect.left - scrollerRect.left + scroller.scrollLeft + parseFloat(style.paddingLeft || "0");
    const columnRight = contentRect.right - scrollerRect.left + scroller.scrollLeft - parseFloat(style.paddingRight || "0");
    const length = view.state.doc.length;
    const cards = [...this.cards].map(([id, card]) => {
      const block = view.lineBlockAt(Math.min(card.pos, length));
      return { id, top: block.top + offset, bottom: block.bottom + offset, height: card.node.offsetHeight };
    });
    return { cards, columnLeft, columnRight, offset };
  }

  private place(layout: ReturnType<Rail["measure"]>) {
    if (this.destroyed) return;
    const active = this.view.state.field(commentUi).active;
    if (this.wide) {
      const left = layout.columnRight + (RAIL_RESERVE - CARD_WIDTH) / 2;
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
      }
    } else {
      const width = Math.min(360, layout.columnRight - layout.columnLeft);
      for (const card of layout.cards) {
        const node = this.cards.get(card.id)?.node;
        if (!node) continue;
        node.style.top = `${card.bottom + 6}px`;
        node.style.left = `${layout.columnLeft}px`;
        node.style.width = `${width}px`;
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
    for (const event of messages(thread)) card.append(message(event.author, event.at, event.text));
    const closed = resolvedBy(thread);
    if (closed) {
      const line = el("div", "cm-cmt-resolved", `Resolved by ${closed.author}`);
      line.title = closed.at;
      if (editable) {
        line.append(button("Reopen", "cm-cmt-link", () => this.report(card, addToThread(this.view, thread.id, "reopened"))));
      }
      card.append(line);
      return card;
    }
    if (!editable) return card;
    const actions = el("div", "cm-cmt-actions");
    actions.append(button("Resolve", "cm-cmt-resolve", () => this.report(card, addToThread(this.view, thread.id, "resolved"))));
    if (active) {
      const reply = composer("Reply…", (text) => addToThread(this.view, thread.id, "comment", text), () => this.view.dispatch({ effects: setActiveThread.of(null) }));
      card.append(reply.root);
    }
    card.append(actions);
    return card;
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
        if (error !== null) this.report(card, error);
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

  private report(card: HTMLElement, error: string | null) {
    if (error === null) return;
    let problem = card.querySelector<HTMLElement>(":scope > .cm-cmt-problem");
    if (!problem) {
      problem = el("div", "cm-cmt-problem");
      card.append(problem);
    }
    problem.textContent = error;
  }
}

/** Keep somebody's half-typed reply, and their focus, across a card rebuild. */
function carryOver(from: HTMLElement, to: HTMLElement) {
  const before = from.querySelector("textarea");
  const after = to.querySelector("textarea");
  if (!before || !after || !before.value) return;
  after.value = before.value;
  if (document.activeElement === before) {
    const { selectionStart, selectionEnd } = before;
    queueMicrotask(() => {
      after.focus();
      after.setSelectionRange(selectionStart, selectionEnd);
    });
  }
}

export const commentRail = ViewPlugin.fromClass(Rail);
