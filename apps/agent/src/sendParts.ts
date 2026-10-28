/**
 * Sending the parts of an answer that are not words (`inbox.ts`): a picture,
 * and a Context card. Neither is the only copy of anything, so a line that
 * refuses one never fails the whole answer.
 */

import type { AppCard } from "./appCards";
import { isRefusal } from "./carousel";
import type { Line } from "./line";

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
