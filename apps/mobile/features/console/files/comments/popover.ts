/**
 * The thread popover: on a wide pane, the open thread (or the comment being
 * written) as a card under its words, the way the mock draws it
 * (https://claude.ai/artifact/G8Udcec7fUh8jD7dnHkUN7). It replaces the margin
 * of cards beside the words: the note stays where it is, and one thread is open
 * at a time.
 *
 * A phone or a thin pane shows nothing here (`hasMargin`): `sheet.ts` opens
 * the same thread in a bottom sheet instead, so exactly one of them is showing
 * a thread.
 *
 * The card's content is `popoverDom.ts`; this file decides what it shows,
 * writes what the person sends through the same commands the sheet uses, and
 * places the card under the words (8px under their bottom, its left edge
 * clamped inside the pane, as `placeCt` in the mock does). It is rebuilt only
 * when its data changes, so a half-typed comment survives the note being typed
 * into and the runner's live updates.
 */

import type { EditorView, PluginValue, ViewUpdate } from "@codemirror/view";
import { ViewPlugin } from "@codemirror/view";
import type { CommentThread } from "@context/shared/src/comments.cjs";
import {
  addToThread,
  canComment,
  canDeleteComment,
  commentHost,
  commentUi,
  commentsParsed,
  removeFromThread,
  setActiveThread,
  setDraft,
  sendComment,
} from "./extension";
import { hasMargin } from "./model";
import { buildCard, type CardActions, type CardModel } from "./popoverDom";
import { TEX_AUTHOR, texInNoteHost } from "./tex/contract";
import { keepPending, texMessageState, texRuns, undoPending } from "./tex/runner";

/** The gap between the words and the card. */
const GAP = 8;

type Target = { kind: "draft"; from: number; to: number; prefill: string } | { kind: "thread"; thread: CommentThread; from: number; to: number };

interface Placement {
  top: number;
  left: number;
}

class Popover implements PluginValue {
  private card: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private key = "";
  private signature = "";
  /** The input to focus once the card is placed (a new draft, or the one that had focus). */
  private pendingFocus: HTMLInputElement | null = null;
  private destroyed = false;
  private readonly actions: CardActions;

  private readonly onScroll = () => {
    if (this.card) this.view.requestMeasure({ key: this, read: () => this.measure(), write: (place) => this.place(place) });
  };

  constructor(private readonly view: EditorView) {
    this.actions = {
      send: (body) => this.send(body),
      close: () => this.close(),
      resolve: (thread, resolve) => addToThread(this.view, thread, resolve ? "resolved" : "reopened"),
      keep: (thread) => keepPending(this.view, thread),
      undo: (thread) => undoPending(this.view, thread),
      remove: (thread, index, event) => removeFromThread(this.view, thread, index, event),
    };
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.sync();
  }

  update(update: ViewUpdate) {
    const { startState, state } = update;
    if (
      update.docChanged ||
      update.selectionSet ||
      update.geometryChanged ||
      update.viewportChanged ||
      update.focusChanged ||
      startState.field(commentUi) !== state.field(commentUi) ||
      startState.field(texRuns, false) !== state.field(texRuns, false)
    ) {
      this.sync();
    }
  }

  destroy() {
    this.destroyed = true;
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.remove();
  }

  private sync() {
    if (this.destroyed) return;
    const target = this.target();
    if (target === null || !hasMargin(this.view.scrollDOM.clientWidth)) {
      this.remove();
      return;
    }
    const model = this.model(target);
    const key = target.kind === "draft" ? `draft:${target.prefill}` : `thread:${target.thread.id}`;
    const signature = JSON.stringify([key, model]);
    if (signature !== this.signature) this.rebuild(model, key);
    this.signature = signature;
    this.view.requestMeasure({ key: this, read: () => this.measure(), write: (place) => this.place(place) });
  }

  /** What the card is about right now: a comment being written, or the active thread. */
  private target(): Target | null {
    const state = this.view.state;
    const ui = state.field(commentUi);
    if (ui.draft !== null) return { kind: "draft", from: ui.draft.from, to: ui.draft.to, prefill: ui.draft.prefill ?? "" };
    if (ui.active === null) return null;
    const parsed = state.field(commentsParsed);
    const thread = parsed.threads.find((one) => one.id === ui.active);
    if (thread === undefined) return null;
    const anchor = parsed.anchors.get(thread.id);
    return { kind: "thread", thread, from: anchor?.from ?? 0, to: anchor?.to ?? 0 };
  }

  private model(target: Target): CardModel {
    const state = this.view.state;
    const host = state.facet(texInNoteHost);
    const runs = state.field(texRuns, false);
    const thread = target.kind === "thread" ? target.thread : null;
    return {
      draft: target.kind === "draft",
      thread,
      prefill: target.kind === "draft" ? target.prefill : "",
      viewer: state.facet(commentHost).author(),
      editable: canComment(state),
      tex: host !== null,
      people: host ? host.people() : [],
      run: thread && runs ? (runs.get(thread.id) ?? null) : null,
      texStates: thread
        ? thread.events.map((event, index) => (event.kind === "comment" && event.author === TEX_AUTHOR ? texMessageState(thread, index) : null))
        : [],
      deletable: thread ? thread.events.map((event) => event.kind === "comment" && canDeleteComment(state, event)) : [],
    };
  }

  private rebuild(model: CardModel, key: string) {
    const doc = this.view.dom.ownerDocument;
    const old = this.input;
    const hadFocus = old !== null && doc.activeElement === old;
    const sameCard = this.card !== null && this.key === key && old !== null;
    const kept = sameCard ? { value: old.value, start: old.selectionStart, end: old.selectionEnd } : null;

    const { root, input } = buildCard(model, this.actions);
    if (this.card) {
      // The new card takes the old one's place, so it does not flash at the top.
      root.style.cssText = this.card.style.cssText;
      // Only a card that is new pops in: the same thread redrawn (a run's
      // steps, Tex's words typing in) must not restart the fade on every redraw,
      // which kept it invisible for as long as Tex was writing.
      root.style.animation = this.key === key ? "none" : "";
      this.card.replaceWith(root);
    } else {
      root.style.visibility = "hidden";
      this.view.scrollDOM.append(root);
    }
    if (input !== null && kept !== null) {
      input.value = kept.value;
      if (kept.start !== null && kept.end !== null) input.setSelectionRange(kept.start, kept.end);
      input.dispatchEvent(new Event("input"));
    }
    // A focus still waiting for the card to be placed moves to the new input:
    // the old one is gone, and sending a message must leave the cursor in the box.
    if (input !== null && ((model.draft && !sameCard) || hadFocus || this.pendingFocus !== null)) this.pendingFocus = input;
    this.card = root;
    this.input = input;
    this.key = key;
  }

  private remove() {
    this.card?.remove();
    this.card = null;
    this.input = null;
    this.key = "";
    this.signature = "";
    this.pendingFocus = null;
  }

  /** Where the card goes, read in one frame and written in the next. */
  private measure(): Placement | null {
    const target = this.target();
    const card = this.card;
    if (target === null || card === null) return null;
    const view = this.view;
    const scroller = view.scrollDOM;
    const start = view.coordsAtPos(target.from, 1);
    const end = view.coordsAtPos(target.to, -1);
    if (!start || !end) return null;
    const box = scroller.getBoundingClientRect();
    const width = card.offsetWidth;
    // Clamped inside the pane, like `placeCt`: a card at the right edge moves left.
    const left = Math.max(0, Math.min(start.left - box.left - GAP, scroller.clientWidth - width));
    // A pending edit's new words are drawn after the anchor and can run over
    // several lines: the card goes under them, so it never covers what it
    // asks the reader to keep or undo.
    const id = target.kind === "thread" ? target.thread.id : null;
    const inserted = id === null ? null : view.contentDOM.querySelector(`.cm-tex-ins[data-thread="${id}"]`);
    const bottom = Math.max(end.bottom, inserted?.getBoundingClientRect().bottom ?? 0);
    let top = bottom - box.top + GAP;
    // A thread on the last lines in view opens above its words instead of
    // running off the bottom of the pane, and is never pushed above its top.
    const height = card.offsetHeight;
    if (top + height > scroller.clientHeight) {
      const above = start.top - box.top - GAP - height;
      top = above >= 0 ? above : Math.max(0, scroller.clientHeight - height);
    }
    return { top: top + scroller.scrollTop, left: left + scroller.scrollLeft };
  }

  private place(placement: Placement | null) {
    if (this.destroyed || this.card === null) return;
    if (placement === null) {
      this.card.style.visibility = "hidden";
      return;
    }
    this.card.style.visibility = "";
    this.card.style.top = `${placement.top}px`;
    this.card.style.left = `${placement.left}px`;
    if (this.pendingFocus !== null) {
      this.pendingFocus.focus({ preventScroll: true });
      this.pendingFocus = null;
    }
  }

  /** Writes what the person sent: a new thread from the draft, or a reply (Tex hears of it through `commentSent`). */
  private send(body: string): string | null {
    const ui = this.view.state.field(commentUi);
    if (ui.draft !== null) return sendComment(this.view, null, body);
    if (ui.active === null) return "Nothing is open to comment on.";
    return sendComment(this.view, ui.active, body);
  }

  /** Esc or ✕: a draft is dropped (nothing is written); a thread is put away. */
  private close() {
    const ui = this.view.state.field(commentUi);
    if (ui.draft !== null) this.view.dispatch({ effects: setDraft.of(null) });
    else if (ui.active !== null) this.view.dispatch({ effects: setActiveThread.of(null) });
  }
}

export const popover = ViewPlugin.fromClass(Popover);
