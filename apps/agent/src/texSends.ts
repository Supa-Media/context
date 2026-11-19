/**
 * The one recorder for a text Tex sends outside a reply turn (Dev2, 2026-11-18: an 8:01 AM check-in was missing from the
 * chat's history because `/routine-text` texted without recording a Tex text event, so the chat showed nothing Tex had
 * said on its own). Every path that texts on its own goes through `sendRecorded`, so none can skip the record: a check-in,
 * a routine, a ping, a job update and the new number. Each text lands in the outbox as a Tex text tagged with its
 * `source`, and with the run's `turn` when it has one, which is how the gateway's note for the run is linked to the text.
 */

import { addEvent, isTextSource, kindOf, type TextSource } from "./events";
import type { InboxStorage } from "./inbox";
import type { Line } from "./line";

/** The sources Tex sends on its own, each with a note in the gateway's ledger (the reply and progress lines are not). */
export const OWN_SOURCES: ReadonlySet<TextSource> = new Set<TextSource>(["checkin", "routine", "ping", "update", "job", "new_line"]);

/** A source the gateway or a caller named, when it is one of the sources Tex sends on its own; none otherwise. */
export function ownSourceOf(value: unknown): TextSource | undefined {
  return isTextSource(value) && OWN_SOURCES.has(value) ? value : undefined;
}

/** A run's turn as the gateway names it (the ledger's `turn`), when it is one; none otherwise. */
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
export function recordedTurn(value: unknown): string | undefined {
  return typeof value === "string" && TURN.test(value) ? value : undefined;
}

/**
 * Send `send.text` through `line` and record it as a Tex text with `record.source` (and `record.turn`). A send the line
 * refuses is recorded as not delivered, then rethrown. Answers the sent text's handle, when the line gives one.
 */
export async function sendRecorded(
  storage: InboxStorage,
  line: Line,
  send: { chatId: string; text: string; key: string; thread?: string },
  record: { source: TextSource; turn?: string; now: () => number },
): Promise<string | undefined> {
  const tagged = { chat: send.chatId, from: { kind: "tex" as const }, kind: kindOf(send.text), text: send.text, source: record.source, ...(record.turn ? { turn: record.turn } : {}) };
  let handle: string | undefined;
  try {
    handle = await line.sendText(send.chatId, send.text, send.key, send.thread);
  } catch (error) {
    await addEvent(storage, { at: record.now(), ...tagged, delivered: false, reason: "failed" });
    throw error;
  }
  await addEvent(storage, { at: record.now(), ...tagged, delivered: true });
  return handle;
}
