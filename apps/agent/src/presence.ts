/**
 * Showing a person their text landed while Tex works on it: read, then the
 * typing bubble, renewed, and after a while a tapback that fits the text.
 * Moved out of `inbox.ts` whole, and started before decide is asked
 * (`inboxTurn.ts`), so a slow decide never leaves a text sitting unread.
 */

import { ackEmoji } from "./ackEmoji";
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
/**
 * A text still being worked on this long gets a tapback that fits it (`ackEmoji.ts`), so the
 * person knows it landed even if the typing bubble never showed. Sendblue
 * sends the bubble on a best-effort basis, and on 2026-10-19 Dev saw "Read"
 * and nothing else for two minutes: "no typing indicator or thumbs up react
 * ... not acceptable". A quick answer needs no tapback; it is the answer.
 */
export const ACKNOWLEDGE_AFTER_MS = 10_000;

export type Presence = {
  /** The bubble again, as after a progress line (sending a text clears it). */
  typing: () => Promise<void>;
  /** Stop renewing and cancel a tapback not yet sent; waits for any still in flight. */
  stop: () => Promise<void>;
  /** The tapback, if it still goes, goes on `message`: the text decide chose to answer, not merely the first waiting. */
  aim: (message: Message) => void;
  /** Cancel the tapback not yet sent (decide's `react` already sent one); the bubble stays. */
  dropTapback: () => void;
};

/**
 * Mark `message` read, show the bubble, and arm the renewals and the tapback.
 * The first bubble is awaited (it is quick, and bounded) so it cannot land
 * after a fast reply and hang in the chat. Read first, then the bubble, as a
 * person would: the text is seen, then answered. Both never throw.
 */
export async function startPresence(line: Line, message: Message): Promise<Presence> {
  await line.markRead(message.chatId, message.messageId);
  const typing = () => line.startTyping(message.chatId);
  await typing();
  let renewal: Promise<void> = Promise.resolve();
  const again = setTimeout(() => {
    renewal = typing();
  }, TYPING_AGAIN_MS);
  const timer = setInterval(() => {
    renewal = typing();
  }, TYPING_REFRESH_MS);
  let target = message;
  let acknowledged: Promise<void> = Promise.resolve();
  const acknowledge = setTimeout(() => {
    // A tapback goes on the text itself, so not on a tapback, and only on a text the line can name.
    if (target.tapback || !target.messageId) return;
    // A tapback is a message of ours, which can clear the bubble; the task is still going.
    acknowledged = line.acknowledge(target.chatId, target.messageId, ackEmoji(target.text)).then(typing);
  }, ACKNOWLEDGE_AFTER_MS);
  let stopped: Promise<void> | undefined;
  return {
    typing,
    aim: (next) => void (target = next),
    dropTapback: () => clearTimeout(acknowledge),
    stop: () =>
      (stopped ??= (async () => {
        clearTimeout(again);
        clearInterval(timer);
        clearTimeout(acknowledge);
        await renewal;
        await acknowledged;
      })()),
  };
}
