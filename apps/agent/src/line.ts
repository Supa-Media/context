/**
 * The texting line a chat lives on. Each chat id says which: a Sendblue chat
 * is `sendblue:<line>:<phone>` (`sendblue.ts`), a WhatsApp chat is
 * `whapi:<line>:<phone>` (`whapi.ts`), anything else is a Linq chat. Groups
 * have the same split in `groupLine.ts`.
 * So replies, typing bubbles and a routine's text go back over the line the
 * person texted, and a person who only ever texted the old Linq number is
 * never texted from the new one first (Tex never texts first).
 */

import { markLinqRead, sendLinqText, shareLinqContactCard, startLinqTyping, ServiceError, type Fetch } from "./clients";
import { sendLinqMedia, uploadLinqPicture, type Media } from "./outgoing";
import { CARD_MEDIA_TYPE, CARD_NAME, texCard } from "./card";
import { noteCard, noteLinkOf, type AppCardConfig } from "./appCards";
import { linkAfterCard, type NoteCardDrawer } from "./noteCards";
import { isRefusal } from "./carousel";
import {
  isSendblueChat,
  parseSendblueChat,
  markSendblueRead,
  reactSendblue,
  sendSendblueAppCard,
  sendSendblueCarousel,
  sendSendblueMedia,
  sendSendblueText,
  shareSendblueProfile,
  type ProfileShared,
  startSendblueTyping,
  type SendblueKeys,
} from "./sendblue";
import {
  isWhapiChat,
  markWhapiRead,
  parseWhapiChat,
  reactWhapi,
  sendWhapiContact,
  sendWhapiMedia,
  sendWhapiText,
  startWhapiTyping,
  toOfPhone,
  type WhapiKeys,
} from "./whapi";

export type Picture = { name: string; mediaType: string; data: string };

export interface Line {
  /**
   * `replyTo` names the message to answer inside the thread of, where the line can (Sendblue); Linq ignores it.
   * Resolves to the sent text's handle when the line gives one (Sendblue), to thread a later text under it.
   */
  sendText(chatId: string, text: string, idempotencyKey: string, replyTo?: string): Promise<string | undefined>;
  sendMedia(chatId: string, media: Media, idempotencyKey: string, replyTo?: string): Promise<void>;
  /** Pictures by address as one swipeable set, where the line has carousels (Sendblue); absent elsewhere. */
  sendCarousel?(chatId: string, urls: string[], replyTo?: string): Promise<void>;
  /** A picture's bytes made sendable: an uploaded attachment, or an address the line fetches. */
  uploadPicture(picture: Picture): Promise<Media>;
  startTyping(chatId: string): Promise<void>;
  /** "Read" on the chat, or on `messageId` where the line marks one message (WhatsApp). */
  markRead(chatId: string, messageId?: string): Promise<void>;
  /** A tapback of `emoji` on the person's text (`ackEmoji.ts`), where the line has tapbacks (Sendblue); Linq does nothing. Never throws. */
  acknowledge(chatId: string, messageId: string, emoji: string): Promise<void>;
  /** Whether the line took the contact card. */
  shareContactCard(chatId: string): Promise<boolean>;
  /** The line's iMessage Name & Photo shared into the chat, or set again first with `refresh`; Linq's card already does both. */
  shareProfile(chatId: string, refresh?: boolean): Promise<ProfileShared>;
}

export type LineDeps = {
  fetch: Fetch;
  linqApiKey: string;
  /** Absent until the Sendblue keys are set; a Sendblue chat then fails to send, as Linq does without its key. */
  sendblue?: SendblueKeys | null;
  /** Absent until the Whapi token and line are set; a WhatsApp chat then fails to send. */
  whapi?: WhapiKeys | null;
  /** Serves a picture's bytes at a short-lived address (`media.ts`), for a line that only takes addresses. */
  hostPicture?: (picture: Picture) => Promise<string>;
  /** Set when a link to a note goes as a Context card (`appCards.ts`); absent, it goes as the link. */
  appCard?: AppCardConfig | null;
  /** Draws a note link's picture (`noteCards.ts`), sent before the link where there is no App Card. */
  noteCardPicture?: NoteCardDrawer;
};

export function lineFor(deps: LineDeps, chatId: string): Line {
  if (isWhapiChat(chatId)) return whapiLine(deps);
  return isSendblueChat(chatId) ? sendblueLine(deps) : linqLine(deps);
}

function linqLine(deps: LineDeps): Line {
  const { fetch, linqApiKey: key } = deps;
  return {
    sendText: async (chatId, text, idempotencyKey) => {
      await sendLinqText(fetch, key, chatId, text, idempotencyKey);
      return undefined;
    },
    sendMedia: (chatId, media, idempotencyKey) => sendLinqMedia(fetch, key, chatId, media, idempotencyKey),
    uploadPicture: async (picture) => ({ attachment_id: await uploadLinqPicture(fetch, key, picture) }),
    startTyping: (chatId) => startLinqTyping(fetch, key, chatId),
    markRead: (chatId) => markLinqRead(fetch, key, chatId),
    acknowledge: async () => {},
    shareContactCard: (chatId) => shareLinqContactCard(fetch, key, chatId),
    shareProfile: async () => "shared",
  };
}

/** Sendblue sends each message once, with no idempotency key; the inbox keeps count of what went. */
function sendblueLine(deps: LineDeps): Line {
  const { fetch } = deps;
  const keys = (): SendblueKeys => {
    if (!deps.sendblue) throw new ServiceError("sendblue", null);
    return deps.sendblue;
  };
  return {
    sendText: async (chatId, text, _key, replyTo) => {
      const card = deps.appCard ? noteCard(text, deps.appCard) : null;
      if (card) {
        try {
          return await sendSendblueAppCard(fetch, keys(), chatId, card, replyTo);
        } catch (error) {
          // A line with no cards gets the link itself: the card is never the only way to the note.
          if (!isRefusal(error)) throw error;
        }
      }
      // No card: the note's picture first, then the link inside a sentence (`noteCards.ts`).
      const link = deps.noteCardPicture && deps.hostPicture ? noteLinkOf(text) : null;
      const picture = link && deps.noteCardPicture ? await deps.noteCardPicture(link) : null;
      const address = picture && deps.hostPicture ? await deps.hostPicture(picture).catch(() => null) : null;
      if (link && address) {
        try {
          await sendSendblueMedia(fetch, keys(), chatId, address, replyTo);
          return await sendSendblueText(fetch, keys(), chatId, linkAfterCard(link), replyTo);
        } catch (error) {
          // A picture the line would not take: the link alone, as before.
          if (!isRefusal(error)) throw error;
        }
      }
      return await sendSendblueText(fetch, keys(), chatId, text, replyTo);
    },
    sendMedia: async (chatId, media, _key, replyTo) => {
      // Only an address: an uploaded attachment id is Linq's.
      if (!("url" in media)) throw new ServiceError("sendblue", 400);
      await sendSendblueMedia(fetch, keys(), chatId, media.url, replyTo);
    },
    sendCarousel: (chatId, urls, replyTo) => sendSendblueCarousel(fetch, keys(), chatId, urls, replyTo),
    uploadPicture: async (picture) => {
      if (!deps.hostPicture) throw new ServiceError("sendblue", null);
      return { url: await deps.hostPicture(picture) };
    },
    startTyping: async (chatId) => {
      if (deps.sendblue) await startSendblueTyping(fetch, deps.sendblue, chatId);
    },
    markRead: async (chatId) => {
      if (deps.sendblue) await markSendblueRead(fetch, deps.sendblue, chatId);
    },
    acknowledge: async (chatId, messageId, emoji) => {
      if (!deps.sendblue) return;
      // An emoji the line refuses still leaves the person a sign it landed.
      if (!(await reactSendblue(fetch, deps.sendblue, chatId, messageId, emoji))) await reactSendblue(fetch, deps.sendblue, chatId, messageId, "like");
    },
    // The card goes as a .vcf, by address (`card.ts`): a contact the person can save.
    shareContactCard: async (chatId) => {
      const chat = parseSendblueChat(chatId);
      if (!deps.sendblue || !deps.hostPicture || chat === null) return false;
      try {
        const data = btoa(texCard(chat.line));
        const url = await deps.hostPicture({ name: `${CARD_NAME}.vcf`, mediaType: CARD_MEDIA_TYPE, data });
        await sendSendblueMedia(fetch, deps.sendblue, chatId, url);
        return true;
      } catch {
        return false;
      }
    },
    // The name and icon at the top of the chat, as for a saved contact (`shareSendblueProfile`).
    shareProfile: async (chatId, refresh) => (deps.sendblue ? shareSendblueProfile(fetch, deps.sendblue, chatId, refresh) : "not_yet"),
  };
}

/**
 * WhatsApp through Whapi (`whapi.ts`). A reply quotes the person's message
 * where the inbox threads one (WhatsApp's reply); no carousels and no cards,
 * so pictures go one by one and a note's link goes as a link, which WhatsApp
 * previews itself. The contact card is a WhatsApp contact message; the name
 * and photo at the top of the chat are the account's own profile, set once
 * on the channel, so there is nothing to share per chat.
 */
function whapiLine(deps: LineDeps): Line {
  const { fetch } = deps;
  const keys = (): WhapiKeys => {
    if (!deps.whapi) throw new ServiceError("whapi", null);
    return deps.whapi;
  };
  const to = (chatId: string): string => {
    const chat = parseWhapiChat(chatId);
    if (chat === null) throw new ServiceError("whapi", 400);
    return toOfPhone(chat.phone);
  };
  return {
    sendText: (chatId, text, _key, replyTo) => sendWhapiText(fetch, keys(), to(chatId), text, replyTo),
    sendMedia: async (chatId, media, _key, replyTo) => {
      // Only an address: an uploaded attachment id is Linq's.
      if (!("url" in media)) throw new ServiceError("whapi", 400);
      await sendWhapiMedia(fetch, keys(), to(chatId), media.url, replyTo);
    },
    uploadPicture: async (picture) => {
      if (!deps.hostPicture) throw new ServiceError("whapi", null);
      return { url: await deps.hostPicture(picture) };
    },
    startTyping: async (chatId) => {
      const chat = parseWhapiChat(chatId);
      if (deps.whapi && chat !== null) await startWhapiTyping(fetch, deps.whapi, toOfPhone(chat.phone));
    },
    markRead: async (_chatId, messageId) => {
      if (deps.whapi && messageId) await markWhapiRead(fetch, deps.whapi, messageId);
    },
    acknowledge: async (_chatId, messageId, emoji) => {
      if (!deps.whapi) return;
      // An emoji WhatsApp refuses still leaves the person a sign it landed.
      if (!(await reactWhapi(fetch, deps.whapi, messageId, emoji)) && emoji !== "👍") await reactWhapi(fetch, deps.whapi, messageId, "👍");
    },
    shareContactCard: async (chatId) => {
      const chat = parseWhapiChat(chatId);
      if (!deps.whapi || chat === null) return false;
      return await sendWhapiContact(fetch, deps.whapi, toOfPhone(chat.phone), CARD_NAME, texCard(chat.line));
    },
    shareProfile: async () => "shared",
  };
}
