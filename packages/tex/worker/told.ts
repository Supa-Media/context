/**
 * The fixed texts Tex sends outside a turn, owed to the next turn's history.
 *
 * Setup and the "notes are ready" text (`setup.ts`, `ready.ts`) go out with no
 * model and before the gateway has a conversation to write them into, so the
 * next text met an empty history: a person who connected Google and texted
 * "Done" was asked "Done with what?" (@context-lc tex-bugs, 2026-10-19). Each
 * is kept two ways, by name only, never the words or the link:
 * - an outbound event carrying `told: <name>` in the chat's event log
 *   (`events.ts`), which waits in the buffer until the next session writes it;
 * - the name, owed under `told` until a turn answered with it: the next
 *   `/agent` call names them (`told`), so today's history
 *   (`apps/mcp/src/agent/conversation.js`) writes its own fixed line for each.
 */

import { addEvent } from "./events";
import type { InboxStorage } from "./inbox";

export const TOLD_KEY = "told";
export type Told = "setup" | "ready" | "ready_late" | "gmail_main" | "gmail";
const MOST = 5;

/** Log that this fixed text went to `chat`, and owe the next turn its name. */
export async function noteTold(storage: InboxStorage, told: Told, chat: string, now: number): Promise<void> {
  // A fixed Worker text is the system's, not a turn's: the gateway takes `told` only from it.
  await addEvent(storage, { at: now, chat, from: { kind: "system" }, kind: "text", delivered: true, told });
  const owed = await owedTold(storage);
  await storage.put<Told[]>(TOLD_KEY, [...owed, told].slice(-MOST));
}

/** What the next turn is owed, oldest first. */
export async function owedTold(storage: InboxStorage): Promise<Told[]> {
  const owed = await storage.get<Told[]>(TOLD_KEY);
  return Array.isArray(owed) ? owed : [];
}

/** A turn that answered has them in its history: drop exactly those, keeping any noted since. */
export async function clearTold(storage: InboxStorage, delivered: Told[]): Promise<void> {
  if (delivered.length === 0) return;
  const rest = (await owedTold(storage)).slice(delivered.length);
  if (rest.length === 0) await storage.delete(TOLD_KEY);
  else await storage.put<Told[]>(TOLD_KEY, rest);
}
