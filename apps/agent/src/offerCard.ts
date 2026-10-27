/**
 * The line's contact card and Name & Photo, offered after a reply goes out
 * (moved out of `inbox.ts` whole, so the inbox stays under its size limit).
 */

import { lineFor, type LineDeps } from "./line";
import { CARD_VERSION } from "./card";
import { isSendblueChat } from "./sendblue";
import { isWhapiChat } from "./whapi";
import type { InboxStorage } from "./inbox";

/** When this sender was last offered the contact card; Linq asks for once a day at most. */
export const CARD_KEY = "card";
export const CARD_EVERY_MS = 24 * 60 * 60 * 1000;
/** A Sendblue chat's card is a message the person sees, so it goes once per chat, never again for a newer `CARD_VERSION`. */
export const cardSentKey = (chatId: string) => `card-sent:${chatId}`;
/** When a Sendblue chat's card or Name & Photo was last tried; per chat, so a card offered on Linq never holds back the new line's. */
export const cardOfferedKey = (chatId: string) => `card-offered:${chatId}`;
/** Set when someone who texted Tex's old Linq line first texts the new one; their first reply there says so. */
export const NEW_LINE_KEY = "new-line";
export const NEW_LINE_TEXT = "Tex here, on my new number. Text me here from now on; my contact card is coming so you can save it.";
/** Set once this sender was texted the new number on the old line (`newLine.ts`); then the new line needs no such line. */
export const NEW_LINE_TOLD_KEY = "new-line-told";
/** The `CARD_VERSION` of a Sendblue chat's Name & Photo, once shared; tried again on the next day's offer until it is. */
export const profileSharedKey = (chatId: string) => `profile-shared:${chatId}`;
/** The `CARD_VERSION` this chat last set the line's Name & Photo to, so a new photo is set once per chat, not every offer. */
export const profileSetKey = (chatId: string) => `profile-set:${chatId}`;
/**
 * Share the line's contact card, so Messages names it with its icon, once a
 * day at most. Linq needs an outbound message in the chat first, which is why
 * this runs after a reply was sent. The time is kept whether or not the line
 * accepted it, so a line with no card set up costs one request a day, not one
 * per text. On Sendblue (and WhatsApp, as a contact) the card is a .vcf in the chat (`card.ts`), so once
 * a card went it never goes again in that chat, whatever `CARD_VERSION` says:
 * a new one arrived after a reply in the middle of a conversation (2026-10-19).
 * A new `CARD_VERSION` only sets the line's Name & Photo again, which is
 * shared apart from the card and is how a new photo reaches a chat.
 */
export async function offerCard(storage: InboxStorage, chatId: string, deps: LineDeps & { now: () => number }): Promise<void> {
  if (!isSendblueChat(chatId) && !isWhapiChat(chatId)) {
    const last = await storage.get<number>(CARD_KEY);
    if (last !== undefined && deps.now() - last < CARD_EVERY_MS) return;
    await storage.put(CARD_KEY, deps.now());
    await lineFor(deps, chatId).shareContactCard(chatId);
    return;
  }
  const sentAs = versionOf(await storage.get<number | boolean>(cardSentKey(chatId)));
  const sharedAs = versionOf(await storage.get<number | boolean>(profileSharedKey(chatId)));
  if (sentAs !== undefined && sharedAs === CARD_VERSION) return;
  // A day between tries, except that a newer card is tried at once.
  const offered = await storage.get<number | Offered>(cardOfferedKey(chatId));
  const last = typeof offered === "number" ? { at: offered, version: 1 } : offered;
  if (last !== undefined && last.version === CARD_VERSION && deps.now() - last.at < CARD_EVERY_MS) return;
  await storage.put<Offered>(cardOfferedKey(chatId), { at: deps.now(), version: CARD_VERSION });

  const line = lineFor(deps, chatId);
  if (sentAs === undefined && (await line.shareContactCard(chatId))) await storage.put(cardSentKey(chatId), CARD_VERSION);
  if (sharedAs === CARD_VERSION) return;
  // A chat that knew an older card sets the new photo on the line first, once; it is shared on a later offer.
  const older = sharedAs !== undefined || (last !== undefined && last.version !== CARD_VERSION);
  const refresh = older && (await storage.get<number>(profileSetKey(chatId))) !== CARD_VERSION;
  const shared = await line.shareProfile(chatId, refresh);
  if (shared === "refreshed") await storage.put(profileSetKey(chatId), CARD_VERSION);
  if (shared === "shared") await storage.put(profileSharedKey(chatId), CARD_VERSION);
}

type Offered = { at: number; version: number };

/** A card or profile recorded before versions were kept (`true`) was version 1. */
function versionOf(value: number | boolean | undefined): number | undefined {
  return value === true ? 1 : typeof value === "number" ? value : undefined;
}

