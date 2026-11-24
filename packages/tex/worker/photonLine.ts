/**
 * Photon: Tex's iMessage line through the bridge (`infra/photon-bridge`, `photonClient.ts`, plan.md Contract B), for
 * the chats `photon:<line>:<phone>` and the groups `photon-group:<chatGuid>`. Sendblue's workarounds are not used here:
 * - a link gets iMessage's own rich link (no picture ahead of it, no "Link:" before it; `linkPreviews.ts` and
 *   `noteCards.ts` exist for Sendblue, which attaches no preview data). Photon draws one only for a text that is
 *   nothing but one link ("enable_link_preview requires text to be a single absolute HTTP or HTTPS URL", its refusal
 *   of every reply on 2026-11-15), so words with a link go as the words, then the link alone with its preview
 *   (`sendPhotonWords`);
 * - a note's link goes as our Messages card (`send/app`) where cards are on, and as the link itself when the line
 *   refuses the card, so the card is never the only way to the note;
 * - a picture goes as its bytes, a real attachment, never as a hosted link;
 * - a text answers with its guid, so a later text can thread under it.
 *
 * Chat ids are parsed here, minimally (`isPhotonChatId`, `parsePhotonDm`, `photonGroupChat`); the inbound side has its own.
 * No Node APIs: the gateway bundles this module (`line.ts`, `groupLine.ts`, `lineCalls.ts`).
 */

import type { LinkNotes } from "./photonLinkBubbles";
import { CARD_MEDIA_TYPE, CARD_NAME, texCard } from "./card";
import { ServiceError, MAX_REPLY_TEXT } from "./clients";
import { cardsOn, noteCard, type AppCard } from "./appCards";
import { isRefusal } from "./carousel";
import { EMOJI, type Tapback } from "./reactions";
import type { Line, LineDeps, Picture } from "./line";
import { linksIn } from "./linkPreviews";
import type { GroupLine, GroupLineDeps, GroupPlace } from "./groupLine";
import type { Media } from "./outgoing";
import { effectOf } from "./sendEffect";
import { pollOf, withoutPollMark } from "./sendPoll";
import { tagParts } from "./groupTags";
import {
  contactPhoton,
  photonGroupMembers,
  reactPhoton,
  readPhoton,
  sendPhotonApp,
  sendPhotonAttachment,
  sendPhotonMultipart,
  runPhotonGroup,
  sendPhotonPoll,
  sendPhotonText,
  typingPhoton,
  type PhotonAttachment,
  type PhotonCard,
  type PhotonKind,
  type PhotonPlace,
} from "./photonClient";

// ---- chat ids (`photon:<line>:<phone>`, `photon-group:<chatGuid>`) ----

const DM_PREFIX = "photon:";
const GROUP_PREFIX = "photon-group:";
const E164 = /^\+[1-9]\d{6,14}$/;
const CHAT_GUID = /^[^\s:]{1,200}$/;
const BASE64URL = /^[A-Za-z0-9_-]{1,300}$/;

/** Whether a chat id is a Photon 1:1 chat. */
export function isPhotonChatId(chatId: string): boolean {
  return chatId.startsWith(DM_PREFIX);
}

/** Whether a group id is a Photon group. */
export function isPhotonGroupId(groupId: string): boolean {
  return groupId.startsWith(GROUP_PREFIX);
}

/** The line and the person of a Photon 1:1 chat id; a malformed id is a 400, as a refusal. */
function parsePhotonDm(chatId: string): { line: string; phone: string } {
  const [line, phone, ...rest] = chatId.slice(DM_PREFIX.length).split(":");
  if (rest.length > 0 || !E164.test(line ?? "") || !E164.test(phone ?? "")) throw new ServiceError("photon", 400);
  return { line, phone };
}

/**
 * The Photon chat guid of a group id: `photon-group:<base64url(chatGuid)>`, since a guid holds `;` which the gateway's
 * id patterns refuse. A malformed id, or one that does not decode to a guid, is a 400, as a refusal.
 */
function photonGroupChat(groupId: string): string {
  const encoded = groupId.slice(GROUP_PREFIX.length);
  if (!groupId.startsWith(GROUP_PREFIX) || !BASE64URL.test(encoded)) throw new ServiceError("photon", 400);
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  let guid: string;
  try {
    guid = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
  } catch {
    throw new ServiceError("photon", 400);
  }
  if (!CHAT_GUID.test(guid)) throw new ServiceError("photon", 400);
  return guid;
}

/** The line a group place names; a malformed one is a 400. */
function placeLine(place: GroupPlace): string {
  if (!E164.test(place.line)) throw new ServiceError("photon", 400);
  return place.line;
}

/**
 * A 1:1 chat's guid is `any;-;<phone>` (Photon's chat guid form, as its events carry it), so it is built here, never
 * looked up: a lookup (`chat/resolve`) can create an empty chat in Messages, and costs a call per isolate.
 */
async function dmPlace(_photon: Fetcher, chatId: string): Promise<PhotonPlace> {
  const { line, phone } = parsePhotonDm(chatId);
  return { line, chat: `any;-;${phone}` };
}

// ---- media and cards ----

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  caf: "audio/x-caf",
  vcf: "text/vcard",
};

/** A file's type from its name's extension; `application/octet-stream` when it has none we know. */
function mimeOf(name: string): string {
  return MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** The last segment of an address, for the file's name; "picture" when there is none. */
function nameOfUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || "picture";
  } catch {
    return "picture";
  }
}

/**
 * The file of each picture this line hosted (`uploadPicture`), by its address: its own name and media type, so the
 * bridge sends the type the picture has, not one guessed from a name. Kept in this isolate's memory only, never in
 * storage; a picture from another isolate, or one given by address, falls back to the name's extension.
 */
const hosted = new Map<string, { name: string; mimeType: string }>();
const HOSTED_KEPT = 500;

/** A media part as the bridge takes a file: an address it fetches, with its name and type. A Linq attachment id is a 400. */
function attachmentOf(media: Media): PhotonAttachment {
  if (!("url" in media)) throw new ServiceError("photon", 400);
  const known = hosted.get(media.url);
  if (known !== undefined) return { ...known, url: media.url };
  const name = nameOfUrl(media.url);
  return { name, mimeType: mimeOf(name), url: media.url };
}

/** An App Card as iMessage's CustomizedMiniApp (`appCards.ts` builds the card; the bridge sends it). */
export function photonCard(card: AppCard): PhotonCard {
  const { caption, subcaption, trailingCaption, imageUrl, summary } = card.layout;
  return {
    appName: card.appName,
    teamId: card.teamId,
    extensionBundleId: card.extensionBundleId,
    ...(card.appStoreId === undefined ? {} : { appStoreId: card.appStoreId }),
    url: card.url,
    layout: {
      caption,
      ...(subcaption === undefined ? {} : { subcaption }),
      ...(trailingCaption === undefined ? {} : { trailingCaption }),
      summary,
      ...(imageUrl === undefined ? {} : { image: imageUrl }),
    },
  };
}

/** Each of iMessage's six tapbacks as Photon's kind for it. */
const KIND: Partial<Record<Tapback, PhotonKind>> = {
  Loved: "love",
  Liked: "like",
  Disliked: "dislike",
  "Laughed at": "laugh",
  Emphasized: "emphasize",
  Questioned: "question",
};

/**
 * The tapback kind for an emoji: the one `reactions.ts` `EMOJI` gives each tapback, read back to its kind. Any emoji
 * that is not one of the six (`ackEmoji.ts` picks more) is a like, the same fallback Sendblue takes.
 */
export function photonKind(emoji: string): PhotonKind {
  const bare = (value: string): string => value.replace(/\uFE0F/gu, "");
  for (const [how, symbol] of Object.entries(EMOJI) as [Tapback, string][]) {
    if (bare(symbol) === bare(emoji)) return KIND[how] ?? "like";
  }
  return "like";
}

// ---- the 1:1 line ----

/** Tapback on a message, with a like when the emoji is refused; never throws. The one that went, or null when none did. */
async function tapbackOn(photon: Fetcher, place: PhotonPlace, guid: string, emoji: string): Promise<string | null> {
  const kind: PhotonKind = photonKind(emoji);
  try {
    await reactPhoton(photon, place, guid, kind, true);
    return emoji;
  } catch {
    if (kind === "like") return null;
    return await reactPhoton(photon, place, guid, "like", true).then(() => "👍", () => null);
  }
}

const ONE_LINK = /^https?:\/\/\S+$/i;

/**
 * A send under `replyTo`, and the same send plain when the bridge refuses the thread (a 4xx: an empty or unknown
 * target), as Sendblue's line does (`sendblue.ts` `sendMessage`): a reply outside the thread beats no reply. An empty
 * `replyTo` is no thread at all. A refusal of the plain send, or any failure, still throws.
 */
export async function threadedOrPlain<T>(replyTo: string | undefined, send: (replyTo?: string) => Promise<T>): Promise<T> {
  if (replyTo === undefined || replyTo === "") return await send();
  try {
    return await send(replyTo);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    console.log(JSON.stringify({ event: "photon_thread", outcome: "refused" }));
    return await send();
  }
}

/**
 * Tex's words on Photon, with a rich link where they hold one: a text that is one link goes with `linkPreview`; words
 * with a link go plain, then their first link alone with its preview, as iMessage does when a person sends both; any
 * other text goes plain. Resolves to the words' guid, the one a later text threads under. The link's own bubble is
 * best effort: the words have gone, so its failure is logged and never fails the send.
 */
export async function sendPhotonWords(photon: Fetcher, place: PhotonPlace, text: string, replyTo?: string, notes?: LinkNotes): Promise<string | undefined> {
  // A text Tex starts "(sent with Slam)" goes with that effect, without the mark (`sendEffect.ts`).
  const marked = effectOf(text);
  // A text Tex starts "(poll)" with its choices one per line goes as a real poll (`sendPoll.ts`); a poll threads under nothing.
  const poll = pollOf(marked.text);
  if (poll !== null) {
    try {
      return await sendPhotonPoll(photon, place, poll);
    } catch (error) {
      // A line that refuses the poll gets its question and choices as words: the poll is never the only way to answer.
      if (!isRefusal(error)) throw error;
      console.log(JSON.stringify({ event: "photon_poll", outcome: "refused" }));
    }
  }
  const words = withoutPollMark(marked.text).slice(0, MAX_REPLY_TEXT);
  const effect = marked.effect !== undefined ? { effect: marked.effect } : {};
  if (ONE_LINK.test(words.trim())) return await threadedOrPlain(replyTo, (under) => sendPhotonText(photon, place, words.trim(), { ...(under ? { replyTo: under } : {}), linkPreview: true, ...effect }));
  const guid = await threadedOrPlain(replyTo, (under) => sendPhotonText(photon, place, words, { ...(under ? { replyTo: under } : {}), ...effect }));
  const link = linksIn(words).find((found) => ONE_LINK.test(found));
  if (link !== undefined) {
    let bubble: string | undefined;
    try {
      bubble = await sendPhotonText(photon, place, link, { linkPreview: true });
    } catch {
      // The words have gone. A preview that failed is logged and never fails the send.
      console.log(JSON.stringify({ event: "photon_link_preview", outcome: "failed" }));
      return guid;
    }
    if (notes !== undefined && typeof bubble === "string" && typeof guid === "string") {
      try {
        // Its reports (echo, read, delivery) are the same send's (`photonLinkBubbles.ts`). Noting never fails the send.
        await notes.note(bubble, guid);
      } catch {
        console.log(JSON.stringify({ event: "photon_link_bubble", outcome: "unnoted" }));
      }
    }
  }
  return guid;
}

/**
 * Tex's line on Photon. A text answers with its guid; a note's link is a card, else the link with its preview.
 * Typing, read receipts and the tapback are best effort and never throw (as on Sendblue).
 */
export function photonLine(deps: LineDeps): Line {
  const photon = (): Fetcher => {
    if (!deps.photon) throw new ServiceError("photon", null);
    return deps.photon;
  };
  return {
    sendText: async (chatId, text, _key, replyTo) => {
      const p = photon();
      const place = await dmPlace(p, chatId);
      const card = cardsOn(deps.appCard) ? noteCard(effectOf(text).text, deps.appCard) : null;
      if (card) {
        try {
          return await threadedOrPlain(replyTo, (under) => sendPhotonApp(p, place, photonCard(card), under));
        } catch (error) {
          // A line that refuses the card gets the link itself: the card is never the only way to the note.
          if (!isRefusal(error)) throw error;
        }
      }
      return await sendPhotonWords(p, place, text, replyTo, deps.linkNotes);
    },
    sendMedia: async (chatId, media, _key, replyTo) => {
      const p = photon();
      const place = await dmPlace(p, chatId);
      await threadedOrPlain(replyTo, (under) => sendPhotonAttachment(p, place, attachmentOf(media), under));
    },
    sendAppCard: async (chatId, card, replyTo) => {
      const p = photon();
      const place = await dmPlace(p, chatId);
      await threadedOrPlain(replyTo, (under) => sendPhotonApp(p, place, photonCard(card), under));
    },
    sendCarousel: async (chatId, urls, replyTo) => {
      if (urls.length === 0) return;
      const p = photon();
      const parts = urls.map((url) => ({ attachment: attachmentOf({ url }) }));
      const place = await dmPlace(p, chatId);
      await threadedOrPlain(replyTo, (under) => sendPhotonMultipart(p, place, parts, under));
    },
    // Hosted at a short-lived address the bridge fetches and sends as a real attachment, not a link (as Sendblue's).
    uploadPicture: async (picture: Picture) => {
      if (!deps.hostPicture) throw new ServiceError("photon", null);
      const url = await deps.hostPicture(picture);
      if (hosted.size >= HOSTED_KEPT) hosted.clear();
      hosted.set(url, { name: picture.name, mimeType: picture.mediaType });
      return { url };
    },
    startTyping: async (chatId) => {
      try {
        const p = photon();
        await typingPhoton(p, await dmPlace(p, chatId), true);
      } catch {
        // A bubble that failed costs nothing.
      }
    },
    markRead: async (chatId) => {
      try {
        const p = photon();
        await readPhoton(p, await dmPlace(p, chatId));
      } catch {
        // A receipt that failed costs only the receipt.
      }
    },
    acknowledge: async (chatId, messageId, emoji) => {
      try {
        const p = photon();
        return await tapbackOn(p, await dmPlace(p, chatId), messageId, emoji);
      } catch {
        // A tapback that failed costs only the tapback.
        return null;
      }
    },
    // The card goes as a .vcf attachment naming the chat's line (`card.ts`), a contact the person can save.
    shareContactCard: async (chatId) => {
      try {
        const p = photon();
        const place = await dmPlace(p, chatId);
        const data = btoa(texCard(place.line));
        await sendPhotonAttachment(p, place, { name: `${CARD_NAME}.vcf`, mimeType: CARD_MEDIA_TYPE, data });
        return true;
      } catch {
        return false;
      }
    },
    // Photon's `contact` shares Tex's Name & Photo into the chat at once; there is no "set it again" step, so `refresh` is not used.
    shareProfile: async (chatId) => {
      try {
        const p = photon();
        await contactPhoton(p, await dmPlace(p, chatId));
        return "shared";
      } catch {
        return "not_yet";
      }
    },
  };
}

/**
 * Tex's group line on Photon. `readOwnMessage` is null: the bridge has no op that reads one message back, so a reply
 * never quotes Tex's own words in a Photon group (Sendblue's answer when it cannot read one, `groupLine.ts`). The
 * thread context still reaches Tex through the reply's own handle. `react` and `readMembers` never throw, as on Sendblue.
 */
export function photonGroupLine(deps: GroupLineDeps): GroupLine {
  const photon = (): Fetcher => {
    if (!deps.photon) throw new ServiceError("photon", null);
    return deps.photon;
  };
  const placeOf = (place: GroupPlace): PhotonPlace => ({ line: placeLine(place), chat: photonGroupChat(place.groupId) });
  return {
    sendText: async (place, text, replyTo, tags) => {
      // Native tags go as one multipart send, each tag its own part naming its number (`groupTags.ts`).
      // A multipart send carries no effect, so tagged words go without the mark and without its effect.
      if (tags !== undefined && tags.length > 0 && pollOf(effectOf(text).text) === null) {
        const where = placeOf(place);
        const marked = effectOf(text);
        const shifted = tags.filter((tag) => tag.start >= marked.mark).map((tag) => ({ ...tag, start: tag.start - marked.mark }));
        if (shifted.length > 0) return await threadedOrPlain(replyTo, (under) => sendPhotonMultipart(photon(), where, tagParts(marked.text, shifted), under));
      }
      return await sendPhotonWords(photon(), placeOf(place), text, replyTo, deps.linkNotes);
    },
    sendMedia: async (place, url, replyTo) => {
      const where = placeOf(place);
      await threadedOrPlain(replyTo, (under) => sendPhotonAttachment(photon(), where, attachmentOf({ url }), under));
    },
    react: async (place, messageId, emoji) => {
      try {
        await tapbackOn(photon(), placeOf(place), messageId, emoji);
      } catch {
        // A tapback that failed costs only the tapback.
      }
    },
    readMembers: async (place) => {
      try {
        return await photonGroupMembers(photon(), placeOf(place));
      } catch {
        return null;
      }
    },
    readOwnMessage: async () => null,
    runGroup: async (place, action) => await runPhotonGroup(photon(), placeOf(place), action),
  };
}
