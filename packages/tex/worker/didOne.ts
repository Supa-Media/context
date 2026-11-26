/**
 * WHAT CODE DID FOR A PERSON'S OWN CHAT GOES TO TEX AS DATA, AND TEX WRITES THE TEXT (Dev2, 2026-11-25, a hard rule;
 * docs/decisions/texting-assistant/no-scripted-wording.md). The 1:1 side of `didFacts.ts`: once code did something
 * for them (their Gmail connected, first), the chat queues one turn of its own, `event: "did"`, with what happened as
 * facts, as a saved login's turn is (`inbox.ts` `queueByCode`). The gateway's node `did` hands them to the Front door
 * as data, and Tex says it in its own words, taught by Training conversations.
 *
 * Until node `did` is wired the old line is sent, as before. A turn that can't run (no model, the daily limit, every
 * try failed) is never silent: its old line goes once, logged as `one_did` `unsaid_<why>`.
 */

import { DID_EVENT, didWired } from "./didFacts";
import { didOf, type Did } from "./factsOf";
import { queueByCode } from "./inbox";
import type { InboxStorage } from "./inbox";

import type { Message } from "./reply";

/** The person's own chat's turn for `did`, under no text of theirs: keyed by `key`, so it is queued once. */
export function didOneMessage(chat: { chatId: string; phone: string; channel?: "simulator" }, did: Did, key: string, fallback: string): Message {
  return { kind: "message", eventId: `did:${key}`, chatId: chat.chatId, from: chat.phone, messageId: "", text: "", event: DID_EVENT, did, didFallback: fallback, ...(chat.channel ? { channel: chat.channel } : {}) };
}

/**
 * Tell the person's own chat what code did: "queued" (a turn of its own), "off" (node `did` isn't wired: the caller
 * sends its old line, as before) or "dropped" (facts unreadable, or that turn was queued already).
 */
export async function tellTexOne(storage: InboxStorage, chat: { chatId: string; phone: string; channel?: "simulator" }, did: Did, key: string, fallback: string, { now, graph }: { now: number; graph?: unknown }): Promise<"queued" | "off" | "dropped"> {
  const facts = didOf(did);
  if (facts === null) return log("unreadable", did), "dropped";
  if (!didWired(graph)) return log("off", facts), "off";
  if (!(await queueByCode(storage, didOneMessage(chat, facts, key, fallback), now))) return log("duplicate", facts), "dropped";
  return log("queued", facts), "queued";
}

/** A `did` turn that could not run: its old line, once, never silence. */
export function didUnsaidOne(message: Message, why: string): string[] {
  log(`unsaid_${why}`, message.did ?? {});
  return message.didFallback ? [message.didFallback] : [];
}

function log(outcome: string, did: Partial<Did>): void {
  console.log(JSON.stringify({ event: "one_did", outcome, action: did.action ?? null, status: did.status ?? null }));
}
