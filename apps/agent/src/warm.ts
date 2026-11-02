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
 * its log. But it is the only place a turn reads the history from, so it is
 * never let fall behind: what Tex texts outside a turn (a routine, a check-in)
 * comes with what the gateway wrote for it, sealed (`beside`), kept here and
 * handed to the next text, which adds it to the copy (Seyi, 2026-10-31: "the
 * saved copy needs to be the only source of truth"). A text that comes
 * without one drops the copy, as does an answer that hands none back or a
 * turn that may have written and never said: the next turn starts a new one.
 * It goes after a day unused.
 */

import { MAX_WARM_CHARS } from "./clients";
import { holdsLog, keepLog, recentEvents, type TexEvent } from "./events";
import type { InboxStorage } from "./inbox";

const WARM_KEY = "tex-warm";
/** Counts drops, so an answer whose turn began before a routine's text never keeps a copy made without it. */
const DROPS_KEY = "tex-warm-drops";
/** What the gateway wrote to the history beside the copy, sealed for the next text (`apps/mcp/src/agent/warmCopy.js` `sealBeside`). */
const BESIDE_KEY = "tex-warm-beside";
/** As many as the gateway opens with one text (`MAX_BESIDE`): one more and the copy has fallen behind, so it is dropped. */
export const MAX_BESIDE = 20;
type Beside = { at: number; sealed: string };
export const KEEP_WARM_MS = 24 * 60 * 60 * 1000;

type Kept = { at: number; sealed: string };

export type WarmDeps = {
  /** The copy to send, if one is kept and fresh. */
  get(): Promise<string | undefined>;
  /** What was written beside it since, sealed, to send with it. */
  beside(): Promise<string[]>;
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
  await storage.delete(BESIDE_KEY);
}

/** Tex texted outside a turn: keep what the gateway wrote for it, or drop the copy when it handed nothing (it can't be brought up to date). */
export async function keepBeside(storage: InboxStorage, sealed: string | undefined, now: number): Promise<void> {
  if (typeof sealed !== "string" || sealed.length === 0 || sealed.length > MAX_WARM_CHARS) return await dropWarm(storage);
  const kept = ((await storage.get<Beside[]>(BESIDE_KEY)) ?? []).filter((entry) => now - entry.at < KEEP_WARM_MS);
  if (kept.length >= MAX_BESIDE) return await dropWarm(storage);
  await storage.put<Beside[]>(BESIDE_KEY, [...kept, { at: now, sealed }]);
}

export function warmDeps(storage: InboxStorage, now: () => number): WarmDeps {
  let drops: number | undefined;
  let sent: string[] = [];
  return {
    async beside() {
      sent = ((await storage.get<Beside[]>(BESIDE_KEY)) ?? []).filter((entry) => now() - entry.at < KEEP_WARM_MS).map((entry) => entry.sealed);
      return sent;
    },
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
      if (typeof sealed === "string" && since === (drops ?? since) && sealed.length > 0 && sealed.length <= MAX_WARM_CHARS) {
        await storage.put<Kept>(WARM_KEY, { at: now(), sealed });
        // What it was handed is in it now; anything written beside it while it ran waits for the next text.
        const left = ((await storage.get<Beside[]>(BESIDE_KEY)) ?? []).filter((entry) => !sent.includes(entry.sealed));
        if (left.length > 0) await storage.put<Beside[]>(BESIDE_KEY, left);
        else await storage.delete(BESIDE_KEY);
      } else await dropWarm(storage);
    },
  };
}
