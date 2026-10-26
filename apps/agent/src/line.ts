/**
 * The texting line a chat lives on. Each chat id says which: a Sendblue chat
 * is `sendblue:<line>:<phone>` (`sendblue.ts`), anything else is a Linq chat.
 * So replies, typing bubbles and a routine's text go back over the line the
 * person texted, and a person who only ever texted the old Linq number is
 * never texted from the new one first (Tex never texts first).
 */

import { markLinqRead, sendLinqText, shareLinqContactCard, startLinqTyping, ServiceError, type Fetch } from "./clients";
import { sendLinqMedia, uploadLinqPicture, type Media } from "./outgoing";
import { CARD_MEDIA_TYPE, CARD_NAME, texCard } from "./card";
import {
  isSendblueChat,
  parseSendblueChat,
  markSendblueRead,
  reactSendblue,
  sendSendblueCarousel,
  sendSendblueMedia,
  sendSendblueText,
  shareSendblueProfile,
  type ProfileShared,
  startSendblueTyping,
  type SendblueKeys,
} from "./sendblue";

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
  markRead(chatId: string): Promise<void>;
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
  /** Serves a picture's bytes at a short-lived address (`media.ts`), for a line that only takes addresses. */
  hostPicture?: (picture: Picture) => Promise<string>;
};

export function lineFor(deps: LineDeps, chatId: string): Line {
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
    sendText: (chatId, text, _key, replyTo) => sendSendblueText(fetch, keys(), chatId, text, replyTo),
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
