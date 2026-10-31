/**
 * The gateway's warm copy, kept in this sender's object (Seyi, 2026-10-31:
 * "how can we completely eliminate storage calls", then yes to keeping it
 * here; `apps/mcp/src/agent/warmCopy.js`).
 *
 * Each answer hands back what its turn read, sealed under a key only the
 * gateway holds, and the next text hands it back, with this chat's newest
 * events beside it, so a "hi Tex" reads nothing from storage it already read.
 * This object can neither read nor change the copy; it only keeps it.
 *
 * It is a cache, never the record: the bucket keeps every note, the chat and
 * its log. It goes after a day unused, with any answer that hands none back,
 * and whenever Tex texts this person outside a turn (a routine), since the
 * chat then holds words the copy hasn't seen.
 */

import { MAX_WARM_CHARS } from "./clients";
import { holdsLog, keepLog, recentEvents, type TexEvent } from "./events";
import type { InboxStorage } from "./inbox";

const WARM_KEY = "tex-warm";
/** Counts drops, so an answer whose turn began before a routine's text never keeps a copy made without it. */
const DROPS_KEY = "tex-warm-drops";
export const KEEP_WARM_MS = 24 * 60 * 60 * 1000;

type Kept = { at: number; sealed: string };

export type WarmDeps = {
  /** The copy to send, if one is kept and fresh. */
  get(): Promise<string | undefined>;
  /** This chat's newest events, as `/agent/events` would take them. */
  recent(chat: string): Promise<TexEvent[]>;
  /** Whether this object holds the chat's whole log (`events.ts` `holdsLog`): then the gateway reads none of it from storage. */
  holds(chat: string): Promise<boolean>;
  /** Keep the log the gateway read from storage, so the next turn needn't (`events.ts` `keepLog`). */
  keepLog(chat: string, events: readonly TexEvent[]): Promise<void>;
  /** Keep the copy an answer handed back, or drop the old one when it handed none. */
  keep(sealed: string | undefined): Promise<void>;
};

export async function dropWarm(storage: InboxStorage): Promise<void> {
  await storage.put<number>(DROPS_KEY, ((await storage.get<number>(DROPS_KEY)) ?? 0) + 1);
  await storage.delete(WARM_KEY);
}

export function warmDeps(storage: InboxStorage, now: () => number): WarmDeps {
  let drops: number | undefined;
  return {
    async get() {
      drops = (await storage.get<number>(DROPS_KEY)) ?? 0;
      const kept = await storage.get<Kept>(WARM_KEY);
      if (kept === undefined || typeof kept.sealed !== "string" || !(now() - kept.at < KEEP_WARM_MS)) return undefined;
      return kept.sealed;
    },
    recent: (chat) => recentEvents(storage, chat),
    holds: (chat) => holdsLog(storage, chat),
    keepLog: (chat, events) => keepLog(storage, chat, events, now()),
    async keep(sealed) {
      const since = (await storage.get<number>(DROPS_KEY)) ?? 0;
      if (typeof sealed === "string" && since === (drops ?? since) && sealed.length > 0 && sealed.length <= MAX_WARM_CHARS) await storage.put<Kept>(WARM_KEY, { at: now(), sealed });
      else await dropWarm(storage);
    },
  };
}
