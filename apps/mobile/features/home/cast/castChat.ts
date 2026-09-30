/**
 * The chats a scene shows beside the workspace (Dev2, 2026-09-30: "I want
 * people to be able to see how their folder structure changes in real time
 * as they chat with claude or chat gpt or both").
 *
 * `playCast` says what happens in them as events: somebody typing in an
 * assistant's box and sending it, the assistant's answer arriving a few words
 * at a time, and each thing it does to the workspace as a row under "Used
 * Context", working and then done at the moment the tree changes beside it.
 * This keeps the windows those events add up to, one per assistant, in the
 * order they were first asked. Pure: the homepage draws it (`CastChat.tsx`).
 *
 * The windows look like no product in particular. An assistant is named as
 * the script names it, and that is all of it that is borrowed.
 */

import type { CastStep } from "@context/shared";

export type CastChatEvent =
  /** Words being typed into an assistant's box, not sent yet. */
  | { kind: "draft"; agent: string; from: string; text: string }
  /** The words sent: a message of the asker's. */
  | { kind: "ask"; agent: string; from: string; text: string }
  /** The assistant's answer so far; `id` is the same while it grows. */
  | { kind: "answer"; agent: string; id: number; text: string; done: boolean }
  /** Something it did to the workspace, working and then done. */
  | { kind: "tool"; agent: string; id: number; verb: string; what: string; done: boolean };

export interface ChatTool {
  id: number;
  verb: string;
  what: string;
  done: boolean;
}

export type ChatMessage =
  | { kind: "asked"; from: string; text: string }
  | { kind: "answer"; id: number; text: string; done: boolean }
  /** Steps taken one after another, drawn as one "Used Context" card. */
  | { kind: "tools"; tools: ChatTool[] };

export interface ChatWindow {
  /** The assistant, as the script names it. */
  agent: string;
  messages: ChatMessage[];
  /** What is in its box, being typed; empty when nothing is. */
  draft: string;
}

export type ChatState = readonly ChatWindow[];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The windows after one more event: a new one for an assistant nobody has asked yet. */
export function chatReducer(state: ChatState, event: CastChatEvent): ChatState {
  const at = state.findIndex((window) => same(window.agent, event.agent));
  const before: ChatWindow = at === -1 ? { agent: event.agent, messages: [], draft: "" } : state[at]!;
  const after = applyTo(before, event);
  return at === -1 ? [...state, after] : state.map((window, index) => (index === at ? after : window));
}

function applyTo(window: ChatWindow, event: CastChatEvent): ChatWindow {
  const messages = window.messages;
  const last = messages[messages.length - 1];
  switch (event.kind) {
    case "draft":
      return { ...window, draft: event.text };
    case "ask":
      return { ...window, draft: "", messages: [...messages, { kind: "asked", from: event.from, text: event.text }] };
    case "answer": {
      const answer: ChatMessage = { kind: "answer", id: event.id, text: event.text, done: event.done };
      const index = messages.findIndex((message) => message.kind === "answer" && message.id === event.id);
      if (index === -1) return { ...window, messages: [...messages, answer] };
      return { ...window, messages: messages.map((message, i) => (i === index ? answer : message)) };
    }
    case "tool": {
      const tool: ChatTool = { id: event.id, verb: event.verb, what: event.what, done: event.done };
      // A step it already started, now done: wherever its card is.
      const holder = messages.findIndex((message) => message.kind === "tools" && message.tools.some((one) => one.id === event.id));
      if (holder !== -1) {
        return {
          ...window,
          messages: messages.map((message, i) =>
            i === holder && message.kind === "tools"
              ? { kind: "tools", tools: message.tools.map((one) => (one.id === event.id ? tool : one)) }
              : message,
          ),
        };
      }
      // Steps taken in a row share a card; anything said in between starts a new one.
      if (last?.kind === "tools") return { ...window, messages: [...messages.slice(0, -1), { kind: "tools", tools: [...last.tools, tool] }] };
      return { ...window, messages: [...messages, { kind: "tools", tools: [tool] }] };
    }
  }
}

/** A name in the tree as a person says it: `1-projects` is Projects, `beta-launch` is Beta launch. */
export function plainName(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const words = base.replace(/^\d+[-_ ]+/, "").replace(/[-_]+/g, " ").trim();
  if (words === "") return base;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * How a step reads in its assistant's chat, or `null` for one that is not
 * something an assistant does to the workspace. Plain words, and names as a
 * person says them, never paths: the film is for people who have never seen
 * a file tree.
 */
export function chatTool(step: CastStep): { verb: string; what: string } | null {
  switch (step.kind) {
    case "read":
      return { verb: "Read", what: step.page === null ? "this page" : plainName(step.page) };
    case "note":
      return { verb: "Added note", what: step.folder === undefined ? plainName(step.name) : `${plainName(step.folder)} › ${plainName(step.name)}` };
    case "folder":
      return { verb: "Added folder", what: plainName(step.path) };
    case "move":
      return { verb: "Moved", what: `${plainName(step.path)} into ${plainName(step.into)}` };
    case "rename":
      return { verb: "Renamed", what: `${plainName(step.path)} to ${step.name}` };
    case "status":
      return { verb: "Marked", what: `${plainName(step.path)} as ${step.status}` };
    case "task":
      return { verb: "Added task", what: step.text };
    case "line":
    case "append":
      return { verb: "Wrote", what: step.text.length > 48 ? `${step.text.slice(0, 47)}…` : step.text };
    case "comment":
      return { verb: "Commented on", what: `“${step.quote}”` };
    case "reply":
      return { verb: "Replied", what: step.text.length > 48 ? `${step.text.slice(0, 47)}…` : step.text };
    case "resolve":
      return { verb: "Resolved", what: "the comment" };
    case "tick":
      return { verb: "Ticked", what: step.quote };
    case "open":
      return { verb: "Opened", what: plainName(step.page) };
    default:
      return null;
  }
}
