/**
 * The popover's DOM: the card a thread, or a comment being written, is shown
 * in on a wide pane (`popover.ts`). Built the way `dom.ts` builds the margin's
 * cards: `createElement` and `textContent` only, never `innerHTML`, because
 * every word here came from a note that anybody with write access could have
 * edited.
 *
 * The card reads a `CardModel`, plain data the plugin derives from the state,
 * and reports what the person did through `CardActions`. Its log is the
 * thread's comments only (suggestion, kept and undid lines are the runner's),
 * with a Keep and Undo under each Tex message that carries a pending edit.
 */

import type { CommentEvent, CommentThread } from "@context/shared/src/comments.cjs";
import { avatar, button, el, report as reportTo } from "./dom";
import { resolvedBy } from "./model";
import { TEX_AUTHOR, type Mentionable } from "./tex/contract";
import { texMarkNode } from "../../../chaos/texMarkDom";
import type { TexRunLive } from "./tex/runner";
import { createDictationEngine } from "../../../voice/engine.web";
import type { DictationEngine } from "../../../voice/engine";
import { joinDictated } from "../../../voice/dictation";
import { reasonFor } from "../../../voice/audience";

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(paths: string[], strokeWidth: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** The speech bubble of a comment. */
export function chatIcon(): SVGSVGElement {
  return icon(["M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"], 2);
}

/** The round send button's arrow. */
export function sendIcon(): SVGSVGElement {
  return icon(["M12 19V5M5 12l7-7 7 7"], 2.4);
}

/** The microphone: a capsule, its cradle and a stem, drawn as the app's own mic is. */
export function micIcon(): SVGSVGElement {
  return icon(["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z", "M19 10v2a7 7 0 0 1-14 0v-2", "M12 19v3"], 2);
}

/** Tex's avatar: its one mark, the blue googly-eyed # (`texMarkNode`). */
export function texAvatar(): HTMLElement {
  return texMarkNode("cm-cav cm-cav-tex", 22);
}

/** The mention menu's bold `@handle`s and the highlight of them in a body. */
const MENTION = /(^|[^\w@])(@[a-z0-9_][\w-]*)/gi;

/** A message's text as nodes: plain text, with each `@name` in its own span. */
export function bodyNodes(text: string): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  MENTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION.exec(text)) !== null) {
    const start = match.index + match[1]!.length;
    if (start > last) nodes.push(document.createTextNode(text.slice(last, start)));
    nodes.push(el("span", "cm-at", match[2]!));
    last = start + match[2]!.length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

export type TexState = "decide" | "kept" | "undone" | null;

/** The plain data a card is drawn from. Equal data draws an equal card. */
export interface CardModel {
  /** A comment being written (no thread yet), or the thread shown. */
  draft: boolean;
  thread: CommentThread | null;
  /** What a new comment starts with ("@Tex " from ⌘L), or "". */
  prefill: string;
  viewer: string | null;
  /** Whether the viewer can write here at all. */
  editable: boolean;
  /** Whether Tex is in this note (its button and its name in the menu). */
  tex: boolean;
  people: Mentionable[];
  /** A run going in this thread, or null. */
  run: TexRunLive | null;
  /** Per event of `thread.events`: the Tex message's state, or null. */
  texStates: TexState[];
  /** Per event of `thread.events`: whether the viewer may delete it. */
  deletable: boolean[];
}

/** What the card asks the editor to do. Each returns an error to show, or null. */
export interface CardActions {
  /** Write the message: a new thread from the draft, or a reply. */
  send(body: string): string | null;
  close(): void;
  resolve(thread: string, resolve: boolean): string | null;
  keep(thread: string): string | null;
  undo(thread: string): string | null;
  remove(thread: string, index: number, event: CommentEvent): string | null;
}

export interface BuiltCard {
  root: HTMLElement;
  input: HTMLInputElement | null;
}

export function buildCard(model: CardModel, actions: CardActions): BuiltCard {
  const root = el("div", model.draft ? "cm-cw cm-cw-draft" : "cm-cw cm-ct");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Comment");
  const report = (error: string | null) => reportTo(root, error);

  root.append(header(model, actions, report));
  const log = el("div", "cm-cwlog");
  if (model.thread) log.append(...threadRows(model, actions, report));
  root.append(log);
  let input: HTMLInputElement | null = null;
  const writable = model.editable && (model.draft || model.thread?.status !== "resolved");
  if (writable) {
    const composed = composer(model, actions, report);
    root.append(composed.menu, composed.box);
    input = composed.input;
  }
  return { root, input };
}

function subtitle(model: CardModel): string {
  // As in the mock, Tex is in the thread from the moment a message asks it, before it has answered.
  if (model.run !== null || model.thread?.events.some((event) => event.author === TEX_AUTHOR || /(^|\s)@tex\b/i.test(event.text ?? ""))) {
    return "Tex is in this thread";
  }
  const parts: string[] = [];
  if (model.tex) parts.push("Tex");
  if (model.people[0]) parts.push(model.people[0].name);
  return parts.length > 0 ? `Type @ to bring in ${parts.join(" or ")}` : "";
}

function header(model: CardModel, actions: CardActions, report: (error: string | null) => void): HTMLElement {
  const head = el("div", "cm-cwh");
  const mark = el("span", "cm-cti");
  mark.append(chatIcon());
  mark.setAttribute("aria-hidden", "true");
  const title = el("div", "cm-cwt");
  title.append(el("b", undefined, "Comment"), el("span", "cm-ctsub", subtitle(model)));
  head.append(mark, title);
  const thread = model.thread;
  if (thread && model.editable) {
    const closed = resolvedBy(thread) !== null;
    head.append(
      button(closed ? "Reopen" : "Resolve", "cm-btn cm-btn-sec", () => report(actions.resolve(thread.id, !closed))),
    );
  }
  const close = button("✕", "cm-cwx", () => actions.close());
  close.setAttribute("aria-label", "Close");
  head.append(close);
  return head;
}

/** The thread's comments, Tex's run, and how a resolved thread ended. */
function threadRows(model: CardModel, actions: CardActions, report: (error: string | null) => void): Node[] {
  const thread = model.thread!;
  const rows: Node[] = [];
  thread.events.forEach((event, index) => {
    if (event.kind !== "comment") return;
    if (event.author === TEX_AUTHOR) rows.push(texRow(model, thread, event, index, actions, report));
    else rows.push(personRow(model, thread, event, index, actions));
  });
  if (model.run !== null) rows.push(runRow(model.run, thread.quote));
  const closed = resolvedBy(thread);
  if (closed) rows.push(el("div", "cm-cwresolved", `Resolved by ${closed.author}`));
  return rows;
}

function row(face: HTMLElement, name: string, text: Node[], extra: Node[] = []): HTMLElement {
  const node = el("div", "cm-cmsg");
  const main = el("div", "cm-cmsg-main");
  const who = el("div", "cm-cwho");
  who.append(el("b", undefined, name));
  const body = el("div", "cm-cbody");
  body.append(...text);
  main.append(who, body, ...extra);
  node.append(face, main);
  return node;
}

function personRow(model: CardModel, thread: CommentThread, event: CommentEvent, index: number, actions: CardActions): HTMLElement {
  const face = avatar(event.author);
  face.setAttribute("aria-hidden", "true");
  const name = event.author === model.viewer ? "You" : event.author;
  const node = row(face, name, bodyNodes(event.text));
  if (model.deletable[index]) {
    const who = node.querySelector(".cm-cwho")!;
    const main = node.querySelector(".cm-cmsg-main")!;
    const ask = button("Delete", "cm-cdel", () => {
      ask.hidden = true;
      const box = el("div", "cm-cconfirm");
      const question = el("span", "cm-cconfirm-q", index === 0 ? "Delete this thread and its replies?" : "Delete this comment?");
      const no = button("Cancel", "cm-btn cm-btn-sec", () => {
        box.remove();
        ask.hidden = false;
      });
      const yes = button("Delete", "cm-btn cm-btn-danger", () => {
        const error = actions.remove(thread.id, index, event);
        if (error !== null) {
          question.textContent = error;
          question.classList.add("cm-cmt-problem");
        }
      });
      box.append(question, no, yes);
      main.append(box);
    });
    ask.setAttribute("aria-label", index === 0 ? "Delete this thread" : "Delete this comment");
    who.append(ask);
  }
  return node;
}

function texRow(
  model: CardModel,
  thread: CommentThread,
  event: CommentEvent,
  index: number,
  actions: CardActions,
  report: (error: string | null) => void,
): HTMLElement {
  const extra: Node[] = [];
  const state = model.texStates[index] ?? null;
  if (state === "decide" && model.editable) {
    const acts = el("div", "cm-cacts");
    acts.append(
      button("Keep", "cm-btn cm-btn-pri", () => report(actions.keep(thread.id))),
      button("Undo", "cm-btn cm-btn-sec", () => report(actions.undo(thread.id))),
    );
    extra.push(acts);
  } else if (state === "kept") {
    extra.push(el("div", "cm-cdone", "Kept"));
  } else if (state === "undone") {
    extra.push(el("div", "cm-cdone", "Undone"));
  }
  return row(texAvatar(), TEX_AUTHOR, bodyNodes(event.text), extra);
}

/**
 * The run's step, naming the words where it says "the selected words": Writing
 * after “honest”, as the artifact draws it. A long quote keeps the generic words.
 */
export function stepLabel(label: string, quote: string): string {
  const words = quote.replace(/\s+/g, " ").trim();
  const base = label || "Working";
  if (words === "" || words.length > 40) return base;
  return base.replace(/the selected words$/, `“${words}”`);
}

/** Tex's working line while a run goes, or the sentence it failed with. */
function runRow(run: TexRunLive, quote: string): HTMLElement {
  if (run.error !== null) return row(texAvatar(), TEX_AUTHOR, [el("span", "cm-cwerr", run.error)]);
  const step = el("span", "cm-cwstep");
  step.append(el("span", "cm-spin"), el("span", "cm-shimmer", `${stepLabel(run.label, quote)}…`));
  return row(texAvatar(), TEX_AUTHOR, [step]);
}

/** One engine for the window: the browser allows one recognition at a time. */
let shared: DictationEngine | null = null;
function dictationEngine(): DictationEngine {
  shared ??= createDictationEngine();
  return shared;
}

/** The mention menu, the input, the microphone and the round send button. */
function composer(
  model: CardModel,
  actions: CardActions,
  report: (error: string | null) => void,
): { menu: HTMLElement; box: HTMLElement; input: HTMLInputElement } {
  const menu = el("div", "cm-mention");
  const picks: { name: string; node: HTMLElement }[] = [];
  const addPick = (name: string, face: HTMLElement, label: string) => {
    const node = el("button");
    node.type = "button";
    node.append(face, el("span", undefined, label));
    node.addEventListener("mousedown", (event) => event.preventDefault());
    node.addEventListener("click", () => pick(name));
    picks.push({ name, node });
    menu.append(node);
  };
  if (model.tex) addPick("Tex", texAvatar(), "Tex");
  for (const person of model.people) {
    const face = avatar(person.handle);
    face.setAttribute("aria-hidden", "true");
    addPick(person.handle.replace(/^@/, ""), face, person.name);
  }
  menu.hidden = true;

  const box = el("div", "cm-cwbox");
  const input = el("input", "cm-cwin");
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = "Comment, or @Tex to ask Tex";
  input.setAttribute("aria-label", "Comment");
  input.value = model.prefill;
  const send = el("button", "cm-send");
  send.type = "button";
  send.setAttribute("aria-label", "Send");
  send.append(sendIcon());
  send.addEventListener("mousedown", (event) => event.preventDefault());
  const mic = el("button", "cm-mic");
  mic.type = "button";
  mic.setAttribute("aria-label", "Dictate");
  mic.setAttribute("aria-pressed", "false");
  mic.append(micIcon());
  mic.addEventListener("mousedown", (event) => event.preventDefault());
  const engine = dictationEngine();
  mic.hidden = !engine.available;
  box.append(input, mic, send);

  const sync = () => {
    const value = input.value;
    const caret = input.selectionStart ?? value.length;
    menu.hidden = picks.length === 0 || !/(^|\s)@\w*$/.test(value.slice(0, caret));
    send.disabled = !value.trim() || model.run !== null;
  };
  const pick = (name: string) => {
    const value = input.value;
    const caret = input.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@\w*$/, `@${name} `);
    input.value = before + value.slice(caret);
    input.focus({ preventScroll: true });
    input.setSelectionRange(before.length, before.length);
    sync();
  };
  const submit = () => {
    if (model.run !== null) return;
    const body = input.value.trim();
    if (!body) return;
    input.value = "";
    sync();
    const error = actions.send(body);
    if (error !== null) {
      input.value = body;
      sync();
      report(error);
    }
  };

  /*
    Live dictation (Dev2, 2026-11-21: "live dictation, and then when you pause,
    the ability to like wait and edit or send"). The words arrive in the box as
    they are said; Stop, or a pause the engine ends on, leaves them there to
    edit; Enter sends, and stops the microphone first if it is still open.
  */
  let live = false;
  let sendWhenDone = false;
  let said = "";
  let before = "";
  const shown = (interim: string) => {
    const tail = joinDictated(before + said, interim);
    input.value = before + said + (interim.trim() === "" ? "" : tail);
  };
  const stopped = () => {
    live = false;
    mic.setAttribute("aria-pressed", "false");
    mic.setAttribute("aria-label", "Dictate");
    input.classList.remove("cm-cwin-live");
    if (!input.isConnected) return;
    input.value = before + said;
    sync();
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    if (sendWhenDone) {
      sendWhenDone = false;
      submit();
    }
  };
  const listen = () => {
    if (live) {
      engine.finalize();
      return;
    }
    live = true;
    said = "";
    before = input.value;
    mic.setAttribute("aria-pressed", "true");
    mic.setAttribute("aria-label", "Stop dictating");
    input.classList.add("cm-cwin-live");
    report(null);
    engine.open({
      interim: (text) => {
        if (!input.isConnected) return engine.abandon();
        shown(text);
        sync();
      },
      final: (text) => {
        said += joinDictated(before + said, text);
        if (input.isConnected) shown("");
      },
      error: (reason) => report(reasonFor(reason, engine.unavailable)),
      ended: stopped,
    });
  };
  mic.addEventListener("click", listen);

  input.addEventListener("input", sync);
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      if (live) {
        // Esc while the microphone is open drops what it was hearing, not the comment.
        said = "";
        engine.abandon();
        return;
      }
      actions.close();
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      if (live) {
        sendWhenDone = true;
        engine.finalize();
        return;
      }
      // With the menu open, Enter takes its first choice: Tex when it is there.
      if (!menu.hidden && picks[0]) pick(picks[0].name);
      else submit();
    }
  });
  send.addEventListener("click", submit);
  sync();
  return { menu, box, input };
}
