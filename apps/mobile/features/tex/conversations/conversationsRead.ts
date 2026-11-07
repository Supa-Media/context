/**
 * Reading the gateway's answers about a chat's conversations
 * (`apps/mcp/src/http/texPage/conversations.js`) into the page's types. Pure:
 * anything malformed is dropped, never guessed at, and a body that is not one
 * of these answers reads as null (the page then says it could not be read).
 */

import type { Conversation, ConversationDetail, ConversationLine } from "../page/texPageTypes";

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown, max = 4000): string => (typeof value === "string" ? value.slice(0, max) : "");
const time = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

export function readConversation(value: unknown): Conversation | null {
  const r = record(value);
  if (r === null || typeof r.id !== "string" || !/^t[1-9][0-9]{0,5}$/.test(r.id)) return null;
  const started = time(r.started);
  const last = time(r.last);
  if (started === null || last === null) return null;
  return {
    id: r.id,
    title: text(r.title, 200) || "Untitled",
    description: text(r.description, 1000),
    status: r.status === "finished" ? "finished" : "open",
    started,
    last,
    texts: typeof r.texts === "number" && Number.isSafeInteger(r.texts) && r.texts >= 0 ? r.texts : 0,
  };
}

export function readConversations(body: unknown): Conversation[] | null {
  const r = record(body);
  if (r === null) return null;
  // A chat with no ledger answers the history's empty shape: no conversations yet.
  if (r.threads === undefined) return Array.isArray(r.entries) ? [] : null;
  if (!Array.isArray(r.threads)) return null;
  return r.threads.map(readConversation).filter((c): c is Conversation => c !== null);
}

function readLine(value: unknown): ConversationLine | null {
  const r = record(value);
  const at = time(r?.at);
  if (r === null || at === null || typeof r.id !== "string" || (r.who !== "person" && r.who !== "tex")) return null;
  return { id: r.id, at, who: r.who, ...(typeof r.name === "string" && r.name !== "" ? { name: r.name.slice(0, 80) } : {}), text: text(r.text, 20_000) };
}

export function readConversationDetail(body: unknown): ConversationDetail | null {
  const r = record(body);
  if (r === null || !Array.isArray(r.lines)) return null;
  return {
    thread: r.thread === null || r.thread === undefined ? null : readConversation(r.thread),
    lines: r.lines.map(readLine).filter((l): l is ConversationLine => l !== null),
    more: r.more === true,
  };
}
