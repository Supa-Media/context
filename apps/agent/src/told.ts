/**
 * The fixed texts Tex sends outside a turn, written into the chat's event log
 * by name (`events.ts`).
 *
 * Setup and the "notes are ready" text (`setup.ts`, `ready.ts`) go out with no
 * model and before the gateway has a conversation to write them into, so the
 * next text met an empty history: a person who connected Google and texted
 * "Done" was asked "Done with what?" (@context-lc tex-bugs, 2026-10-19). Each
 * becomes an outbound event carrying `told: <name>`, never the words or the
 * link; the gateway renders its own fixed line for each name, as it did for
 * the names `/agent` used to be handed (`apps/mcp/src/agent/conversation.js`).
 * It waits in the buffer until the next session can write it.
 */

import { addEvent, unwritten } from "./events";
import type { InboxStorage } from "./inbox";

export type Told = "setup" | "ready" | "ready_late" | "gmail_main" | "gmail";

/** Log that this fixed text went to `chat`. */
export async function noteTold(storage: InboxStorage, told: Told, chat: string, now: number): Promise<void> {
  // A fixed Worker text is the system's, not a turn's: the gateway takes `told` only from it.
  await addEvent(storage, { at: now, chat, from: { kind: "system" }, kind: "text", delivered: true, told });
}

/** The fixed texts the gateway has not written yet, oldest first. */
export async function owedTold(storage: InboxStorage): Promise<Told[]> {
  return (await unwritten(storage)).flatMap((event) => (event.told ? [event.told as Told] : []));
}
