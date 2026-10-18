/**
 * Mail in the editor: the ```mail log at the end of a note
 * (`packages/shared/src/mail.cjs`, `docs/decisions/note-mail.md`), drawn as
 * one quiet line under everything that opens in place into the log, oldest
 * first, with a box at its end to write back (Dev2 picked board A,
 * 2026-10-15).
 *
 * The block is replaced the way the comments block is (`comments/extension.ts`):
 * a person never edits the log's raw lines from here, and the caret steps
 * over it. Writing is one ordinary transaction that appends a line, so it
 * travels through the collaboration binding, autosave and undo like typing.
 *
 * Who writes is the comments' host (`commentHost`): a person signs mail with
 * the same `@handle` they comment with, and where nobody may comment, nobody
 * may write mail either. Agents send through the gateway's `write_note mail`.
 */

import { Prec, StateEffect, StateField, type EditorState, type Extension, type Range, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { appendMail, parseMail, type MailEvent } from "@context/shared/src/mail.cjs";
import type { CommentsBlock } from "@context/shared/src/comments.cjs";
import { commentHost } from "../comments/extension";
import { avatar, button, el } from "../comments/dom";
import { foldedSummary, recipients, timeLabel } from "./model";

export interface ParsedMail {
  block: CommentsBlock | null;
  events: MailEvent[];
}

export const mailParsed = StateField.define<ParsedMail>({
  create: (state) => parseMail(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? parseMail(tr.state.doc.toString()) : value),
});

export const setMailOpen = StateEffect.define<boolean>();

export const mailOpen = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMailOpen)) value = effect.value;
    return value;
  },
});

/** Whether this editor may write mail: somebody signed, on a note they may write. */
export function canSendMail(state: EditorState): boolean {
  return !state.readOnly && state.facet(commentHost).author() !== null;
}

/** The transaction that sends `text` to `to`, or the reason it cannot. */
export function sendTransaction(state: EditorState, text: string, to: string, at?: string): TransactionSpec | { error: string } {
  const author = state.facet(commentHost).author();
  if (author === null || state.readOnly) return { error: "You can't write mail on this note." };
  if (!text.trim()) return { error: "Write something first." };
  if (!recipients(state.field(mailParsed).events).includes(to)) return { error: `Nobody joined this note's mail as ${to}.` };
  const result = appendMail(state.doc.toString(), { at, from: author, kind: "mail", to, text });
  if (result.error !== undefined) return { error: result.error };
  return { changes: result.changes, userEvent: "input.mail" };
}

/** The block's lines, plus the blank lines just above it. */
function hiddenRange(state: EditorState, block: CommentsBlock): { from: number; to: number } {
  const doc = state.doc;
  let first = doc.lineAt(block.start);
  while (first.number > 1) {
    const above = doc.line(first.number - 1);
    if (above.text.trim() !== "") break;
    first = above;
  }
  const last = doc.lineAt(Math.max(block.start, block.end - 1));
  return { from: first.from, to: last.to };
}

/** What a person had typed, kept per editor so a rebuild (new mail arriving) does not lose it. */
const drafts = new WeakMap<EditorView, { text: string; to: string; focused: boolean }>();

class MailWidget extends WidgetType {
  constructor(
    readonly events: MailEvent[],
    readonly open: boolean,
    readonly writable: boolean,
  ) {
    super();
  }

  eq(other: MailWidget): boolean {
    return (
      other.open === this.open &&
      other.writable === this.writable &&
      other.events.length === this.events.length &&
      other.events.every((event, i) => event.at === this.events[i].at && event.text === this.events[i].text && event.from === this.events[i].from)
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const root = el("div", `cm-mail${this.open ? " cm-mail-open" : ""}`);
    root.setAttribute("contenteditable", "false");
    const toggle = () => view.dispatch({ effects: setMailOpen.of(!this.open) });
    const head = button("", "cm-mail-head", toggle);
    head.setAttribute("aria-expanded", String(this.open));
    head.append(el("span", "cm-mail-icon", "✉"), el("span", "cm-mail-summary", foldedSummary(this.events)), el("span", "cm-mail-chev", this.open ? "Hide" : "⌄"));
    root.append(head);
    if (!this.open) return root;

    const log = el("div", "cm-mail-log");
    for (const event of this.events) log.append(entry(event));
    root.append(log);
    if (this.writable) root.append(this.writeBox(view));
    root.append(el("div", "cm-mail-note", "Mail is kept in the note. Nothing here can be changed or removed."));
    return root;
  }

  private writeBox(view: EditorView): HTMLElement {
    const box = el("div", "cm-mail-write");
    const input = el("textarea", "cm-mail-input");
    input.rows = 1;
    input.placeholder = "Write mail…";
    input.setAttribute("aria-label", "Write mail");
    const select = el("select", "cm-mail-to");
    select.setAttribute("aria-label", "Send to");
    for (const name of recipients(this.events)) {
      const option = el("option", undefined, `to ${name}`);
      option.value = name;
      select.append(option);
    }
    const problem = el("div", "cm-mail-problem");
    problem.hidden = true;
    const kept = drafts.get(view);
    if (kept) {
      input.value = kept.text;
      if ([...select.options].some((option) => option.value === kept.to)) select.value = kept.to;
      if (kept.focused) queueMicrotask(() => input.focus({ preventScroll: true }));
    }
    const remember = () => drafts.set(view, { text: input.value, to: select.value, focused: document.activeElement === input });
    const send = () => {
      const spec = sendTransaction(view.state, input.value, select.value);
      if ("error" in spec && typeof spec.error === "string") {
        problem.textContent = spec.error;
        problem.hidden = false;
        return;
      }
      drafts.set(view, { text: "", to: select.value, focused: true });
      view.dispatch(spec as TransactionSpec);
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
      problem.hidden = true;
      remember();
    });
    input.addEventListener("focus", remember);
    input.addEventListener("blur", remember);
    select.addEventListener("change", remember);
    const row = el("div", "cm-mail-row");
    row.append(input, select, button("Send", "cm-mail-send", send));
    box.append(row, problem);
    return box;
  }

  ignoreEvent(): boolean {
    // The box and the toggle handle their own clicks and keys.
    return true;
  }
}

function entry(event: MailEvent): HTMLElement {
  const row = el("div", `cm-mail-entry${event.kind === "joined" ? " cm-mail-joined" : ""}`);
  const face = avatar(event.from);
  face.setAttribute("aria-hidden", "true");
  const main = el("div", "cm-mail-main");
  const who = el("div", "cm-mail-who");
  who.append(el("span", "cm-mail-from", event.from));
  if (event.app) who.append(el("span", "cm-mail-app", ` · ${event.app}`));
  if (event.kind === "joined") {
    who.append(el("span", "cm-mail-app", " joined"));
  } else {
    who.append(el("span", "cm-mail-app", " to "), el("span", "cm-mail-target", event.to ?? ""));
  }
  who.append(el("span", "cm-mail-time", timeLabel(event.at)));
  main.append(who);
  if (event.kind === "mail") main.append(el("div", "cm-mail-text", event.text));
  row.append(face, main);
  return row;
}

function build(state: EditorState): { set: DecorationSet; writable: boolean } {
  const { block, events } = state.field(mailParsed);
  const writable = canSendMail(state);
  if (block === null) return { set: Decoration.none, writable };
  const range = hiddenRange(state, block);
  const widget = new MailWidget(events, state.field(mailOpen), writable);
  const ranges: Range<Decoration>[] = [Decoration.replace({ block: true, widget }).range(range.from, range.to)];
  return { set: Decoration.set(ranges), writable };
}

const mailDecorations = StateField.define<{ set: DecorationSet; writable: boolean }>({
  create: build,
  // Who may write can change with nothing in the document changing (a
  // sign-in resolving after mount), so that is checked on every update.
  update: (value, tr) =>
    tr.docChanged || tr.startState.field(mailOpen) !== tr.state.field(mailOpen) || canSendMail(tr.state) !== value.writable
      ? build(tr.state)
      : value,
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.set),
    EditorView.atomicRanges.of((view) => view.state.field(field).set),
  ],
});

/** The editor's mail section. Needs `comments(...)` installed for who signs. */
export function noteMail(): Extension {
  return [mailParsed, mailOpen, Prec.high(mailDecorations)];
}
