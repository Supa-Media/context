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
  /**
   * Who the turn answers, as the line names them: its session is theirs (a
   * group's grant is resolved for the tagger), so only their own messages
   * may be folded into it or restart it.
   */
  asker: string;
  deps: TurnDeps;
  /** The event ids this turn answers. */
  covers: string[];
  accessToken?: string;
  cancelled?: true;
};

export type Steer = { turn: string; onSession: (accessToken: string) => Promise<void>; onSteered: (ids: string[]) => Promise<void> };

/**
 * The turns running in an inbox. A 1:1 chat runs one at a time; a group runs up
 * to `MAX_GROUP_TURNS` side by side, one per asker (`groupTurnRun.ts`; Dev2,
 * 2026-11-13, one turn per text).
 */
const live = new WeakMap<InboxStorage, Set<Live>>();

/** Name the turn about to answer `covers` in `chat`; `end` forgets it once the turn is over. */
export function startTurn(
  storage: InboxStorage,
  chat: string,
  asker: string,
  deps: TurnDeps,
  covers: string[],
  onSteered: (ids: string[]) => Promise<void>,
  onSession: (accessToken: string) => Promise<void> = async () => {},
): { steer: Steer; live: Live; end: () => void } {
  const entry: Live = { chat, turn: crypto.randomUUID(), asker, deps, covers };
  let running = live.get(storage);
  if (running === undefined) live.set(storage, (running = new Set()));
  running.add(entry);
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
    end: () => void running.delete(entry),
  };
}

/**
 * The turn running in `chat`, once it has a session to steer into: in a group,
 * the one `asker` asked (nobody else's message is steered into a turn on
 * somebody's grant), the newest when there are two.
 */
export function runningTurn(storage: InboxStorage, chat: string, asker?: string): Live | undefined {
  let found: Live | undefined;
  for (const running of live.get(storage) ?? []) {
    if (running.chat !== chat || running.accessToken === undefined || running.cancelled) continue;
    if (asker !== undefined && running.asker !== asker) continue;
    found = running;
  }
  return found;
}

/**
 * Hand a message's words to the running turn (fold). Whether the gateway took
 * it; untaken, it is answered after. Never an SMS: its sender can be faked,
 * so it never reaches a turn that runs with somebody's own session.
 */
export async function steerInto(running: Live, message: { eventId: string; from: string; sms?: true }, text: string): Promise<boolean> {
  const words = text.trim().slice(0, MAX_STEER_TEXT);
  // Never somebody else's words into a turn that runs on the asker's grant.
  if (message.sms || message.from !== running.asker || running.accessToken === undefined || words === "") return false;
  try {
    const { status } = await post(
      running.deps.fetch,
      "gateway",
      `${running.deps.gatewayOrigin}/agent/steer`,
      running.accessToken,
      { turn: running.turn, id: message.eventId, text: words },
      STEER_TIMEOUT_MS,
    );
    return status === 200;
  } catch {
    return false;
  }
}

/**
 * Cancel the running turn (restart): whatever it says after is never sent.
 * Never for an SMS, whose sender can be faked. Whether it was cancelled: only
 * once the gateway says so is the turn marked, so a turn the gateway could
 * not stop (it already wrote or sent) still sends its answer, and the new
 * message is queued behind it.
 */
export async function restartTurn(running: Live, message: { from: string; sms?: true }): Promise<boolean> {
  if (message.sms || message.from !== running.asker || running.accessToken === undefined) return false;
  if (!(await cancelTurn(running.deps, running.accessToken, running.turn))) return false;
  running.cancelled = true;
  return true;
}
