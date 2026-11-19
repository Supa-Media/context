/**
 * Each bubble of a group answer under the text it answers (Dev2, 2026-11-18,
 * the "Battle of the Bots" chat: "tex, say alpha" and "tex, say bravo" landed
 * in one turn and both bubbles went under "say bravo").
 *
 * The gateway says which text each part of the answer goes under, by event
 * id (`apps/mcp/src/agent/replyUnder.js`), when the front door numbered them.
 * Here each part becomes its own bubbles, under that text's message. A part
 * with no text named, or one naming a text this turn did not answer, goes
 * where the whole answer always went: under the newest message.
 */

import { textsWithExact } from "./format";

/** One part of an answer and the event id of the text it answers, as the gateway sends it. */
export type UnderPart = { under?: string; text: string };

const EVENT_ID = /^\d{13}-\d{6}$/;
const MAX_PARTS = 8;

/** The gateway's parts, kept only when they are exactly the answer's words in order: never a guess. */
export function readUnder(value: unknown, answer: string): UnderPart[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PARTS) return [];
  const parts: UnderPart[] = [];
  for (const part of value) {
    if (typeof part !== "object" || part === null) return [];
    const { under, text } = part as { under?: unknown; text?: unknown };
    if (typeof text !== "string" || text.trim() === "") return [];
    if (under !== undefined && (typeof under !== "string" || !EVENT_ID.test(under))) return [];
    parts.push({ ...(typeof under === "string" ? { under } : {}), text: text.trim() });
  }
  return parts.map((part) => part.text).join("\n\n") === answer.trim() ? parts : [];
}

/** A bubble and the message it threads under (undefined: the turn's own message, as before). */
export type Bubble = { text: string; messageId?: string };

/**
 * The answer as bubbles. With parts, each part is cut into bubbles on its own
 * (an exact ask stays whole, inside whichever part holds it), each under the
 * message whose event the part names, when this turn answered it (`messages`:
 * event id to message id). Without, the answer as it always was.
 */
export function bubblesUnder(answer: string, parts: readonly UnderPart[], messages: Readonly<Record<string, string>>, verbatim: readonly string[] = [], oneBubble = false): Bubble[] {
  if (oneBubble || parts.length === 0) return textsWithExact(answer, verbatim, oneBubble).map((text) => ({ text }));
  const bubbles: Bubble[] = [];
  for (const part of parts) {
    const messageId = part.under !== undefined ? messages[part.under] : undefined;
    const exact = verbatim.filter((words) => part.text.includes(words));
    for (const text of textsWithExact(part.text, exact)) bubbles.push({ text, ...(messageId ? { messageId } : {}) });
  }
  return bubbles;
}
