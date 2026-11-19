/**
 * The in-app chat with Tex (`plan.md`, "in-app Tex 1:1 chat"): one person's
 * 1:1 with Tex in the Context web app, as one more line of the chat object.
 *
 * Its chat id is `app:<userId>`, where the user id is the control plane's own
 * (a Convex id, lowercase letters and digits). The chat object runs the same
 * code as a text's, so the chat id is the only thing that tells the rest of the
 * Worker an app chat apart: no phone, no link command, no old number. Its line
 * (`appLine`) texts nobody. Tex's words reach the person through the chat
 * object's ledger, which the app reads, so the line keeps nothing of its own.
 */

import type { InboxStorage } from "./inbox";
import type { Line, Picture } from "./line";
import { keepTexPicture } from "./appPictures";
import type { Media } from "./outgoing";
import type { ProfileShared } from "./sendblue";

export const APP_CHAT_PREFIX = "app:";

/** A Convex user id: the control plane's, lowercase letters and digits only. Anything else is refused, never a chat. */
export const APP_USER = /^[a-z0-9]{16,64}$/;

/** The storage key of the app line's last typing mark: the epoch ms the line was last asked to show typing. */
export const APP_TYPING_KEY = "app:typing";

/** The app chat id for a user, or null when the id is not a user id this app accepts. */
export function appChatId(userId: string): string | null {
  return APP_USER.test(userId) ? `${APP_CHAT_PREFIX}${userId}` : null;
}

/**
 * Whether a chat id is one an app chat's user could have made. A chat id that
 * starts `app:` but names no user is still never a phone's: callers check this
 * first, so a malformed one is refused rather than treated as a phone number.
 */
export function namesAppChat(chatId: string): boolean {
  return chatId.startsWith(APP_CHAT_PREFIX);
}

/** Whether a chat id is an app chat: `app:` and a user id that `APP_USER` accepts. Takes anything, so a caller can pass a value straight off the wire. */
export function isAppChat(chatId: unknown): boolean {
  return typeof chatId === "string" && appUserOf(chatId) !== null;
}

/** The user an app chat id names, or null when the id is not an app chat id. */
export function appUserOf(chatId: string): string | null {
  if (!chatId.startsWith(APP_CHAT_PREFIX)) return null;
  const userId = chatId.slice(APP_CHAT_PREFIX.length);
  return APP_USER.test(userId) ? userId : null;
}

/** The handle an app line gives a sent text: the idempotency key, sanitized and kept to 120 characters. */
function handleOf(idempotencyKey: string): string {
  return `app-${idempotencyKey}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 120);
}

/**
 * The line of an app chat. Nothing is sent anywhere: the chat object logs each
 * Tex text as an event, and the app reads the ledger. `storage` is the app
 * chat's own object's: it keeps the typing mark, so the object can say Tex is
 * working, and Tex's pictures (`appPictures.ts`), whose address is then the
 * picture event's text. With none (the texting Worker, which never holds an
 * app chat), a picture is not sent and typing is not shown.
 */
export function appLine(storage: InboxStorage | null, now: () => number = () => Date.now()): Line {
  const stopTyping = async () => {
    if (storage !== null) await storage.delete(APP_TYPING_KEY).catch(() => false);
  };
  return {
    // A text sent ends the typing mark, as a bubble arriving does in Messages; Tex marks it again if it goes on working.
    sendText: async (_chatId, _text, idempotencyKey) => (await stopTyping(), handleOf(idempotencyKey)),
    sendMedia: async () => {
      await stopTyping();
    },
    // Kept in the chat's own object; its address is one only this chat's fetch answers (`appPictures.ts`).
    uploadPicture: async (picture: Picture): Promise<Media> => {
      const url = storage === null ? "" : await keepTexPicture(storage, picture, now());
      if (url === "") throw new Error("this picture cannot be kept for the app");
      return { url };
    },
    startTyping: async () => {
      if (storage !== null) await storage.put(APP_TYPING_KEY, now());
    },
    markRead: async () => undefined,
    acknowledge: async (_chatId, _messageId, emoji) => emoji,
    shareContactCard: async () => false,
    shareProfile: async (): Promise<ProfileShared> => "not_yet",
  };
}
