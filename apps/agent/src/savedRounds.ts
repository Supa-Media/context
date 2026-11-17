/**
 * A text's turn carries on where its last try stopped (Dev2, 2026-11-17; `apps/mcp/src/agent/savedRounds.js`).
 *
 * After each round of tool calls the gateway sends the rounds so far down the stream, sealed with a key this Worker
 * never holds, and the chat's object keeps the newest under the text it answers. A try of the same text after a
 * crash hands it back, and the turn goes on from there instead of doing its tools again. Gone once the text is
 * answered, and after a day whatever happened.
 */
import type { InboxStorage } from "./inbox";

export const ROUNDS_PREFIX = "rounds:";
/** A text never answered keeps its rounds this long, then they go with its other leftovers. */
export const ROUNDS_KEPT_MS = 24 * 60 * 60 * 1000;

type Kept = { at: number; sealed: string };

/** Where one text's rounds are kept, by the id that stays the same across its tries. */
const keyOf = (work: string) => `${ROUNDS_PREFIX}${work}`;

/** The rounds an earlier try of `work` left, to hand the gateway, and where this try's go. */
export function roundsFor(storage: Pick<InboxStorage, "get" | "put">, work: string, now: () => number) {
  return {
    get: async (): Promise<string | undefined> => (await storage.get<Kept>(keyOf(work)))?.sealed,
    keep: async (sealed: string): Promise<void> => {
      try {
        await storage.put<Kept>(keyOf(work), { at: now(), sealed });
      } catch {
        // A copy that wasn't kept costs a later try its head start, never this turn.
      }
    },
  };
}

/** The text is answered: its rounds go. */
export async function forgetRounds(storage: Pick<InboxStorage, "delete">, work: string): Promise<void> {
  await storage.delete(keyOf(work)).catch(() => false);
}

/** Rounds of texts never answered, kept past `ROUNDS_KEPT_MS`, go. */
export async function pruneRounds(storage: Pick<InboxStorage, "list" | "delete">, now: number): Promise<void> {
  for (const [key, kept] of await storage.list<Kept>({ prefix: ROUNDS_PREFIX })) if (!(now - (kept?.at ?? 0) <= ROUNDS_KEPT_MS)) await storage.delete(key);
}
