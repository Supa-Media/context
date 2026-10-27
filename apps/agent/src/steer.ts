/**
 * The turn running in a chat, and what a message that lands during it does
 * (Dev, 2026-10-19, choosing Hermes's "steer" mode; Dev2, 2026-10-26, handing
 * the choice to decide).
 *
 * Each answered turn is named. While it runs, the inbox knows the session it
 * runs as, in memory only, never in storage: the access token is a
 * credential. Any message that arrives meanwhile, a reply, a tapback, a
 * photo or somebody else's in a group, is put to decide with `running: true`
 * (`inbox.ts`, `groupInbox.ts`), which says one of:
 * - fold: its words go into the running turn (`POST /agent/steer`,
 *   `apps/mcp/src/agent/steer.js`); the answer names the texts the turn took
 *   in, and those are dropped from the queue;
 * - queue: it waits, and is answered after;
 * - restart: the running turn is cancelled (`POST /agent/cancel`) and a new
 *   one answers what it covered and this.
 */

import { post, type Fetch } from "./clients";
import { cancelTurn } from "./decide";
import type { InboxStorage } from "./inbox";

/** How long sending a text into a running turn may take; it is queued either way. */
export const STEER_TIMEOUT_MS = 5_000;
/** The gateway takes at most this much of one steered text. */
export const MAX_STEER_TEXT = 4_000;

export type TurnDeps = { fetch: Fetch; gatewayOrigin: string; controlPlaneOrigin: string; workerSecret: string };

export type Live = {
  chat: string;
  turn: string;
  deps: TurnDeps;
  /** The event ids this turn answers. */
  covers: string[];
  accessToken?: string;
  cancelled?: true;
};

export type Steer = { turn: string; onSession: (accessToken: string) => Promise<void>; onSteered: (ids: string[]) => Promise<void> };

/** One running turn per inbox: a Durable Object answers its texts one at a time. */
const live = new WeakMap<InboxStorage, Live>();

/** Name the turn about to answer `covers` in `chat`; `end` forgets it once the turn is over. */
export function startTurn(
  storage: InboxStorage,
  chat: string,
  deps: TurnDeps,
  covers: string[],
  onSteered: (ids: string[]) => Promise<void>,
  onSession: (accessToken: string) => Promise<void> = async () => {},
): { steer: Steer; live: Live; end: () => void } {
  const entry: Live = { chat, turn: crypto.randomUUID(), deps, covers };
  live.set(storage, entry);
  return {
    live: entry,
    steer: {
      turn: entry.turn,
      onSession: async (accessToken) => {
        entry.accessToken = accessToken;
        await onSession(accessToken);
      },
      onSteered,
    },
    end: () => {
      if (live.get(storage) === entry) live.delete(storage);
    },
  };
}

/** The turn running in `chat`, once it has a session to steer into. */
export function runningTurn(storage: InboxStorage, chat: string): Live | undefined {
  const running = live.get(storage);
  return running !== undefined && running.chat === chat && running.accessToken !== undefined && !running.cancelled ? running : undefined;
}

/** Hand `text` to the running turn (fold). Whether the gateway took it; untaken, it is answered after. */
export async function steerInto(running: Live, id: string, text: string): Promise<boolean> {
  const words = text.trim().slice(0, MAX_STEER_TEXT);
  if (running.accessToken === undefined || words === "") return false;
  try {
    const { status } = await post(
      running.deps.fetch,
      "gateway",
      `${running.deps.gatewayOrigin}/agent/steer`,
      running.accessToken,
      { turn: running.turn, id, text: words },
      STEER_TIMEOUT_MS,
    );
    return status === 200;
  } catch {
    return false;
  }
}

/** Cancel the running turn (restart): whatever it says after is never sent. */
export async function restartTurn(running: Live): Promise<void> {
  running.cancelled = true;
  if (running.accessToken !== undefined) await cancelTurn(running.deps, running.accessToken, running.turn);
}
