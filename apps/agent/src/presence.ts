/**
 * Showing a person their text landed while Tex works on it: read, then the
 * typing bubble, renewed. No tapback beside the answer: the bubble says Tex is
 * on it, and a tapback goes only in place of a text (Dev2, 2026-11-10: "uses
 * emojis way too much"; the after-10-seconds tapback of 2026-10-19 is gone).
 * Moved out of `inbox.ts` whole, and started before decide is asked
 * (`inboxTurn.ts`), so a slow decide never leaves a text sitting unread.
 */

import type { Line } from "./line";
import type { Message } from "./reply";

/** Linq clears the typing bubble after about 85 seconds; this renews it sooner. */
export const TYPING_REFRESH_MS = 55_000;
/**
 * The bubble asked for again this soon after the first: on Sendblue the read
 * receipt and the bubble go out back to back, and Dev2 (2026-10-18) saw
 * "Read" with no bubble for 15 seconds, so the second ask lands after the
 * receipt has.
 */
export const TYPING_AGAIN_MS = 1_500;

export type Presence = {
  /** The bubble again, as after a progress line (sending a text clears it). */
  typing: () => Promise<void>;
  /** The read receipt and the first bubble, in that order: started at once, waited for only before Tex's first text goes. */
  ready: Promise<void>;
  /** Stop renewing; waits for the read receipt and any bubble still in flight. */
  stop: () => Promise<void>;
};

/**
 * Mark `message` read, show the bubble, and arm the renewals. Neither blocks
 * the turn (Dev, 2026-11-04: "read receipts and typing indicator should never
 * block"; awaited, the two Sendblue round trips held every text up before the
 * gateway was asked). They run beside the turn as `ready`, read first and then
 * the bubble, as a person would; anything Tex texts waits for `ready` (`stop`,
 * and the progress lines in `inbox.ts`), so a bubble still cannot land after a
 * fast reply and hang in the chat. Both never throw.
 */
export async function startPresence(line: Line, message: Message): Promise<Presence> {
  const typing = () => line.startTyping(message.chatId);
  const ready = line.markRead(message.chatId, message.messageId).then(typing);
  let renewal: Promise<void> = Promise.resolve();
  const again = setTimeout(() => {
    renewal = typing();
  }, TYPING_AGAIN_MS);
  const timer = setInterval(() => {
    renewal = typing();
  }, TYPING_REFRESH_MS);
  let stopped: Promise<void> | undefined;
  return {
    typing,
    ready,
    stop: () =>
      (stopped ??= (async () => {
        clearTimeout(again);
        clearInterval(timer);
        await ready;
        await renewal;
      })()),
  };
}
