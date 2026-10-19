/**
 * A text sent while Tex is working on the one before it joins that job
 * (Dev, 2026-10-19, choosing Hermes's "steer" mode).
 *
 * Each answered text names its turn. While that turn runs, the inbox knows
 * the session it runs as, in memory only, never in storage: the access token
 * is a credential. A words-only text that arrives meanwhile, with nothing else
 * waiting, is sent to the gateway (`POST /agent/steer`,
 * `apps/mcp/src/agent/steer.js`) and still queued as usual. The answer names
 * the texts the turn took in, and those are dropped from the queue before the
 * next drain; one the turn never saw is answered on its own, as before.
 */

import { post, type Fetch } from "./clients";
import type { InboxStorage } from "./inbox";
import type { Message } from "./reply";

/** How long sending a text into a running turn may take; it is queued either way. */
export const STEER_TIMEOUT_MS = 5_000;

type Live = { chatId: string; turn: string; gatewayOrigin: string; fetch: Fetch; accessToken?: string };

/** One running turn per inbox: a Durable Object answers its texts one at a time. */
const live = new WeakMap<InboxStorage, Live>();

/** Name the turn about to answer `message`; `end` forgets it once the turn is over. */
export function startTurn(
  storage: InboxStorage,
  message: Message,
  deps: { fetch: Fetch; gatewayOrigin: string },
  onSteered: (ids: string[]) => Promise<void>,
): { steer: { turn: string; onSession: (accessToken: string) => void; onSteered: (ids: string[]) => Promise<void> }; end: () => void } {
  const turn = crypto.randomUUID();
  const entry: Live = { chatId: message.chatId, turn, gatewayOrigin: deps.gatewayOrigin, fetch: deps.fetch };
  live.set(storage, entry);
  return {
    steer: { turn, onSession: (accessToken) => void (entry.accessToken = accessToken), onSteered },
    end: () => {
      if (live.get(storage) === entry) live.delete(storage);
    },
  };
}

/**
 * Send `message` into the turn running for its chat, if there is one it can
 * join: plain words, not a reply or tapback (those carry other words the
 * guards keep apart), and nothing else waiting ahead of it.
 */
export async function steerInto(storage: InboxStorage, message: Message, waiting: number): Promise<boolean> {
  const running = live.get(storage);
  if (running?.accessToken === undefined || running.chatId !== message.chatId || waiting !== 1) return false;
  if (message.text.trim() === "" || (message.attachments?.length ?? 0) > 0) return false;
  if (message.quoted !== undefined || message.threaded || message.tapback || message.sms) return false;
  try {
    const { status } = await post(
      running.fetch,
      "gateway",
      `${running.gatewayOrigin}/agent/steer`,
      running.accessToken,
      { turn: running.turn, id: message.eventId, text: message.text },
      STEER_TIMEOUT_MS,
    );
    return status === 200;
  } catch {
    return false; // queued all the same, so it is answered on its own
  }
}
