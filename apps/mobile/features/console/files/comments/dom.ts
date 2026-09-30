/**
 * The pieces a comment card is built from, shared by the margin (`rail.ts`)
 * and the phone's bottom sheet (`sheet.ts`), so a thread reads the same in
 * both.
 *
 * Plain DOM with `createElement` and `textContent` only, never `innerHTML`:
 * every name and word here came out of a Markdown file that anybody with write
 * access, or any agent, could have written, so a string never reaches the DOM
 * as markup.
 */

import { faceNode, robotNode } from "../../faces/faceDom";
import { isPerson, whenLabel } from "./model";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A button that never takes the editor's selection away when pressed. */
export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("mousedown", (event) => event.preventDefault());
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return node;
}

/**
 * How a comment the viewer may delete is deleted. `thread` says the whole
 * thread goes with it (it is the first comment), which the confirmation says
 * out loud; `run` deletes and returns an error to show, or null.
 */
export interface Deletion {
  thread: boolean;
  run: () => string | null;
}

/**
 * One comment: who, when, and what they said. With `deletion`, a Delete link
 * sits at the end of the name row, and pressing it asks first, in the card
 * itself: the iOS web view draws no `window.confirm`, and a question beside
 * the comment says which comment it means.
 */
export function message(author: string, at: string, text: string, deletion?: Deletion): HTMLElement {
  const row = el("div", "cm-cmt-msg");
  // A person is their face (`faces/`), an agent the robot; never initials.
  const avatar = isPerson(author) ? faceNode(author, "cm-cmt-av") : robotNode("cm-cmt-av cm-cmt-av-agent");
  avatar.setAttribute("aria-hidden", "true");
  const main = el("div", "cm-cmt-main");
  const who = el("div", "cm-cmt-who");
  who.append(el("b", undefined, author));
  if (!isPerson(author)) who.append(el("span", "cm-cmt-tag", "agent"));
  const when = el("span", "cm-cmt-when", whenLabel(at));
  when.title = at;
  who.append(when);
  main.append(who, el("div", "cm-cmt-body", text));
  if (deletion) {
    const ask = button("Delete", "cm-cmt-del", () => {
      ask.hidden = true;
      main.append(confirmDelete(deletion, () => {
        ask.hidden = false;
        ask.focus();
      }));
    });
    ask.setAttribute("aria-label", deletion.thread ? "Delete this thread" : "Delete this comment");
    who.append(ask);
  }
  row.append(avatar, main);
  return row;
}

function confirmDelete(deletion: Deletion, onCancel: () => void): HTMLElement {
  const box = el("div", "cm-cmt-confirm");
  box.setAttribute("role", "group");
  const question = el("span", "cm-cmt-confirm-q", deletion.thread ? "Delete this thread and its replies?" : "Delete this comment?");
  const yes = button("Delete", "cm-cmt-danger", () => {
    const error = deletion.run();
    if (error !== null) {
      question.textContent = error;
      question.classList.add("cm-cmt-problem");
    }
  });
  const no = button("Cancel", "cm-cmt-link", () => {
    box.remove();
    onCancel();
  });
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    box.remove();
    onCancel();
  });
  box.append(question, el("span", "cm-cmt-confirm-actions"));
  box.lastElementChild!.append(no, yes);
  queueMicrotask(() => no.focus());
  return box;
}

/**
 * A textarea that sends on Enter and takes a new line on Shift-Enter, the
 * convention of every chat box a person already knows.
 */
export function composer(
  placeholder: string,
  onSend: (text: string) => string | null,
  onCancel: () => void,
): { root: HTMLElement; input: HTMLTextAreaElement } {
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

/** Show `error` at the foot of `card`, or nothing when there is none. */
export function report(card: HTMLElement, error: string | null) {
  if (error === null) return;
  let problem = card.querySelector<HTMLElement>(":scope > .cm-cmt-problem");
  if (!problem) {
    problem = el("div", "cm-cmt-problem");
    card.append(problem);
  }
  problem.textContent = error;
}

/** Keep somebody's half-typed reply, and their focus, across a rebuild. */
export function carryOver(from: HTMLElement, to: HTMLElement) {
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
