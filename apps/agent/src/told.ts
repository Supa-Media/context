/**
 * The fixed texts Tex sent outside a turn, owed to the next turn's history.
 *
 * Setup and the "notes are ready" text (`setup.ts`, `ready.ts`) go out with no
 * model and before the gateway has a conversation to write them into, so the
 * next text met an empty history: a person who connected Google and texted
 * "Done" was asked "Done with what?" (@context-lc tex-bugs, 2026-10-19). The
 * inbox keeps which of them went, by name only, never the words or the link,
 * and the next `/agent` call names them (`told`); the gateway writes its own
 * fixed line for each into the history (`apps/mcp/src/agent/conversation.js`).
 */

import type { InboxStorage } from "./inbox";

export const TOLD_KEY = "told";
export type Told = "setup" | "ready" | "ready_late" | "gmail_main" | "gmail";
const MOST = 5;

/** Owe the next turn this text. */
export async function noteTold(storage: InboxStorage, told: Told): Promise<void> {
  const owed = (await storage.get<Told[]>(TOLD_KEY)) ?? [];
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
  const owed = await owedTold(storage);
  const rest = owed.slice(delivered.length);
  if (rest.length === 0) await storage.delete(TOLD_KEY);
  else await storage.put<Told[]>(TOLD_KEY, rest);
}
