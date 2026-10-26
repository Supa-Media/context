/**
 * Sending the parts of an answer that are not words (`inbox.ts`): a picture,
 * and a Context card. Neither is the only copy of anything, so a line that
 * refuses one never fails the whole answer.
 */

import type { AppCard } from "./appCards";
import { isRefusal } from "./carousel";
import type { Line } from "./line";
import { PICTURE_FAILED, type Media } from "./outgoing";

/**
 * A picture that the line refuses (a web address that is gone, or not an
 * image) becomes a sentence saying so rather than a reply retried until
 * dropped; a failure that is not a refusal is retried with the reply.
 */
export async function sendPicture(line: Line, chatId: string, media: Media, key: string, thread?: string): Promise<void> {
  try {
    await line.sendMedia(chatId, media, key, thread);
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    if (typeof status !== "number" || status < 400 || status >= 500 || status === 429) throw error;
    await line.sendText(chatId, PICTURE_FAILED, `${key}:failed`, thread);
  }
}

/**
 * A pick card after a set of option cards (`pickCard.ts`). A line with no
 * cards, or one that refuses this one (no V2 line, no plan, a picture it
 * won't fetch), sends nothing: every option card already says "Reply 2 for
 * more". A failure that is not a refusal is retried with the reply.
 */
export async function sendCardPart(line: Line, chatId: string, card: AppCard, thread?: string): Promise<void> {
  if (!line.sendAppCard) return;
  try {
    await line.sendAppCard(chatId, card, thread);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    const status = (error as { status?: number | null }).status;
    console.log(JSON.stringify({ event: "sendblue_pick_card", outcome: "refused", status }));
  }
}
