/**
 * Yes or Not now on Tex's ask, answered from a web page (Dev2, 2026-11-20: "even if it does open as a web link, it
 * should still work"). The ask card's address is `https://context.lc/tex/ask?k=<key>`; when a tap does not reach the
 * Messages extension, iOS opens it in the browser, where the app's `/tex/ask` screen asks the signed-in person and
 * the gateway hands their answer here (`apps/mcp/src/http/texPage/serve.js`, action `answer`).
 *
 * The answer goes into the chat exactly as the card's own Yes would (`cardChats.ts` `cardReply`): the words "yes" or
 * "no", carrying the ask's key, in the chat the person last texted from, through `accept`. So the gateway checks it
 * as it checks a typed yes, and Tex answers in Messages. Only the ask still waiting is answered: a key that is not the
 * last ask's, or no ask at all, is refused here rather than turned into a stale yes, and the page says so.
 */

import { askKey } from "./cardChats";
import { accept, CHAT_KEY, type InboxStorage, type RememberedChat } from "./inbox";
import type { Message } from "./reply";
import { keptAsk } from "./thumbs";

const ASK_KEY = /^[a-z0-9]{1,8}$/;
const PHONE = /^\+[1-9][0-9]{6,14}$/;

export type PageAnswer = { phone: string; ask: string; yes: boolean };
export type PageAnswerOutcome = { taken: true } | { taken: false; why: "no_ask" | "stale" | "full" };

/** A page's answer, read strictly; null for anything else. */
export function readPageAnswer(value: unknown): PageAnswer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { phone, ask, yes } = value as Record<string, unknown>;
  if (typeof phone !== "string" || !PHONE.test(phone) || typeof ask !== "string" || !ASK_KEY.test(ask) || typeof yes !== "boolean") return null;
  return { phone, ask, yes };
}

/** Queues the answer as the person's own "yes" or "no" on the waiting ask. One answer per ask: a second is already taken. */
export async function answerFromPage(storage: InboxStorage, answer: PageAnswer, now: number): Promise<PageAnswerOutcome> {
  const ask = await keptAsk(storage, now);
  if (ask === undefined) return { taken: false, why: "no_ask" };
  if (askKey(ask) !== answer.ask) return { taken: false, why: "stale" };
  const chat = await storage.get<RememberedChat>(CHAT_KEY);
  if (chat === undefined) return { taken: false, why: "no_ask" };
  const message: Message = {
    kind: "message",
    // The ask's key names the event, so a second tap (Yes again, or Not now after Yes) is the same answer, already in.
    eventId: `page-answer:${answer.ask}`,
    chatId: chat.chatId,
    from: answer.phone,
    messageId: "",
    text: answer.yes ? "yes" : "no",
    viaCard: { ask: answer.ask },
    ...(chat.channel === "simulator" ? { channel: "simulator" as const } : {}),
  };
  const outcome = await accept(storage, message, now);
  console.log(JSON.stringify({ event: "page_answer", yes: answer.yes, outcome }));
  return outcome === "full" ? { taken: false, why: "full" } : { taken: true };
}
