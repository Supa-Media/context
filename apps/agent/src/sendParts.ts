/**
 * Sending the parts of an answer that are not words (`inbox.ts`): a picture,
 * and a Context card. Neither is the only copy of anything, so a line that
 * refuses one never fails the whole answer.
 */

import { cardsOn, type AppCard, type AppCardConfig } from "./appCards";
import { isRefusal } from "./carousel";
import { kindOf, type TexEvent } from "./events";
import type { Line } from "./line";
import { PICTURE_FAILED, type Media, type SendPart } from "./outgoing";
import type { Message } from "./reply";

/** The event for one part Tex sent: a picture it could not upload is one that never went. */
export function partEvent(part: SendPart): Omit<TexEvent, "id" | "at" | "chat" | "from"> {
  if (part === PICTURE_FAILED) return { kind: "picture", delivered: false, reason: "upload_failed" };
  if (typeof part !== "string" && "card" in part) return { kind: "text", text: part.card.fallbackText, delivered: true };
  if (typeof part !== "string") return { kind: "picture", delivered: true, ...("url" in part.media ? { text: part.media.url } : {}) };
  return { kind: kindOf(part), text: part, delivered: true };
}

/**
 * The person's message an answer goes inside the thread of, or none: Tex
 * matches how it was texted, and a new topic gets a thread of its own
 * (decided by the owner, 2026-10-20). A text typed inside a thread is
 * answered there; a plain text that starts a topic (`newTopic`: the first
 * after a quiet spell) opens a thread under it; any other plain text is
 * answered plainly, unless a newer text overtook it, when its thread keeps
 * the answer next to its question. Answering every text in its own thread
 * (2026-10-19) put a whole conversation under an unrelated check-in, because
 * each answer landed in whatever thread its text was in.
 */
export function threadFor(message: Message, overtaken = false): string | undefined {
  // A tapback's answer goes plain: under the tapback it would read as a reply to an emoji.
  if (message.channel === "simulator" || !message.messageId || message.tapback) return undefined;
  return message.threaded || message.newTopic || overtaken ? message.messageId : undefined;
}

const MAX_CAPTION = 100;
const HOSTED = /\/media\/([0-9a-f]{64})\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/;

/** `<object id>.<token>.<ext>` for a picture this Worker keeps (`media.ts`), or null for any other address. */
export function pictureKey(imageUrl: string): string | null {
  let path: string;
  try {
    path = new URL(imageUrl).pathname;
  } catch {
    return null;
  }
  const match = HOSTED.exec(path);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * A card Tex drew, sent as a Context card rather than a bare photo (the
 * owner, 2026-10-29, after Tex sent a drawn card as a photo and said a card
 * can only be a picture in iMessage). The drawing is the card's
 * picture and its title the caption, so it reads as one native bubble; tapping
 * it opens the Context app's Messages extension (`/tex/card`), which shows
 * the drawing again, full size (the owner, 2026-10-30: a tapped card showed
 * only its title). The card carries no words the picture does not already
 * show; `p` names where the drawing is kept (`media.ts`, a week for a card),
 * read back through the router's `/messages/picture`.
 */
export function drawnCard(title: string, imageUrl: string, config: AppCardConfig): AppCard {
  const caption = title.slice(0, MAX_CAPTION);
  const kept = pictureKey(imageUrl);
  return {
    appName: "Context",
    extensionBundleId: config.extensionBundleId,
    teamId: config.teamId,
    ...(config.appStoreId ? { appStoreId: config.appStoreId } : {}),
    url: `https://context.lc/tex/card?t=${encodeURIComponent(caption)}${kept ? `&p=${kept}` : ""}`,
    interactive: false,
    fallbackText: caption,
    layout: { caption, subcaption: "From Tex", imageUrl, summary: caption },
  };
}

/**
 * Each drawn card of an answer as a Context card, where cards go (`appCards.ts`).
 * Only a picture that names what it shows and went by an address the line
 * fetches; an option card has no title, so a set still goes as a carousel with
 * its pick card (`pickCard.ts`). The photo stays with it, sent instead when
 * the line refuses the card.
 */
export function withDrawnCards(parts: SendPart[], config: AppCardConfig | null | undefined): SendPart[] {
  if (!cardsOn(config)) return parts;
  return parts.map((part) =>
    typeof part !== "string" && "media" in part && part.title && "url" in part.media ? { card: drawnCard(part.title, part.media.url, config), fallback: part.media } : part,
  );
}

/**
 * A Context card: a pick card after a set of option cards (`pickCard.ts`), an
 * ask, an offer, or a drawn card. A line with no cards, or one that refuses
 * this one (no V2 line, no plan, a picture it won't fetch), sends the card's
 * photo when it has one and nothing otherwise: every option card already
 * says "Reply 2 for more". A failure that is not a refusal is retried with
 * the reply.
 */
export async function sendCardPart(line: Line, chatId: string, part: { card: AppCard; fallback?: Media }, thread?: string, idempotency = ""): Promise<void> {
  if (!line.sendAppCard) {
    if (part.fallback) await line.sendMedia(chatId, part.fallback, idempotency, thread);
    return;
  }
  try {
    await line.sendAppCard(chatId, part.card, thread);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    const status = (error as { status?: number | null }).status;
    console.log(JSON.stringify({ event: "sendblue_pick_card", outcome: "refused", status, fallback: part.fallback !== undefined }));
    if (part.fallback) await line.sendMedia(chatId, part.fallback, idempotency, thread);
  }
}
