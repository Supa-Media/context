/**
 * Where Tex texts a person first: check-ins, reminders, heartbeats, anything a
 * routine sends (`routines.ts`). Replies always go to the chat they came from.
 *
 * It used to be simply the chat they last texted from, so one text to Tex on
 * WhatsApp moved every check-in there (the owner, 2026-10-27: "Tex started
 * moving my dm comms to whatsapp"). WhatsApp is the add-on line
 * (`docs/decisions/texting-assistant/whatsapp.md`), so the home chat is the
 * last chat they texted from that is not WhatsApp; WhatsApp is home only for
 * someone who has never texted Tex anywhere else. Texting Tex on iMessage is
 * the way back, and the only one needed.
 */

import { isWhapiChat } from "./whapi";
import { CHAT_KEY, type InboxStorage, type RememberedChat } from "./inbox";

export const HOME_KEY = "home";

/** Keep the chat a text came from, and make it home unless it is WhatsApp. */
export async function rememberChat(storage: InboxStorage, chat: RememberedChat): Promise<void> {
  await storage.put<RememberedChat>(CHAT_KEY, chat);
  if (!isWhapiChat(chat.chatId)) await storage.put<RememberedChat>(HOME_KEY, chat);
}

/** The chat a text Tex starts goes to: home, else the last chat they texted from. */
export async function homeChat(storage: InboxStorage): Promise<RememberedChat | undefined> {
  return (await storage.get<RememberedChat>(HOME_KEY)) ?? (await storage.get<RememberedChat>(CHAT_KEY));
}
