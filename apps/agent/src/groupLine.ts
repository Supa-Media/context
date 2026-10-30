/**
 * The group-chat side of a texting line: what the group queue (`groupInbox.ts`)
 * and a group's background jobs (`jobRun.ts`) need from whichever app the chat
 * lives in. The 1:1 side is `Line` (`line.ts`).
 *
 * A group's id says which app it is in: a WhatsApp group is `whapi:<jid>`
 * (`whapi.ts`), anything else is an iMessage group on Sendblue. So a provider
 * can be added or swapped here, and nothing behind the queue changes.
 *
 * Every implementation keeps the same promises the queue relies on:
 * - `readMembers` is null when the list could not be read, never an empty or
 *   partial list: an answer is held when nobody can say who is in the chat;
 * - `readOwnMessage` returns words only for a message Tex itself sent in this
 *   same group, so a reply can never pull in someone else's words;
 * - `react` never throws.
 */

import { ServiceError, type Fetch } from "./clients";
import { isRefusal } from "./carousel";
import type { Picture } from "./line";
import { hostedNoteCard, linkAfterCard, whapiNotePreview, type NoteCardDrawer } from "./noteCards";
import type { SendblueKeys } from "./sendblue";
import { reactInGroup, readGroupMembers, readOwnGroupMessage, sendGroupMedia, sendGroupText } from "./sendblueGroups";
import {
  groupJidOf,
  isWhapiGroup,
  reactWhapi,
  readWhapiGroupMembers,
  readWhapiMessage,
  sendWhapiLinkPreview,
  sendWhapiMedia,
  sendWhapiText,
  type WhapiKeys,
} from "./whapi";

/** Where in a group a message goes: Tex's line in it and the group's id. */
export type GroupPlace = { line: string; groupId: string };

export interface GroupLine {
  /** One text, under `replyTo` where the app threads; the sent message's handle when it names one. */
  sendText(place: GroupPlace, text: string, replyTo?: string): Promise<string | undefined>;
  /** One file by an https address the app fetches. */
  sendMedia(place: GroupPlace, url: string, replyTo?: string): Promise<void>;
  /** A reaction on a message in the group. Never throws. */
  react(place: GroupPlace, messageId: string, emoji: string): Promise<void>;
  /** Everyone in the group, as phones (or entries that count as someone unknown); null when it could not be read. */
  readMembers(place: GroupPlace): Promise<string[] | null>;
  /** The words of a message Tex sent in this group; null for anyone else's, another chat's, or a failure. */
  readOwnMessage(place: GroupPlace, messageId: string): Promise<string | null>;
  /**
   * True when the app's webhook names only the sender, never the chat's other people (WhatsApp), so a turn
   * can't stand on the webhook's list when `readMembers` fails: it is retried rather than decided as if
   * the sender were alone (the Crystal Care chat, 2026-10-29: bound on one person, then refused the family).
   */
  readonly senderOnlyWebhook?: true;
}

export type GroupLineDeps = {
  fetch: Fetch;
  sendblue?: SendblueKeys | null;
  whapi?: WhapiKeys | null;
  /** Serves a picture at a short-lived address the app fetches (`media.ts`). */
  hostPicture?: (picture: Picture) => Promise<string>;
  /** Draws a note link's picture (`noteCards.ts`), sent before the link on iMessage, as in a 1:1 chat. */
  noteCardPicture?: NoteCardDrawer;
};

export function groupLineFor(deps: GroupLineDeps, groupId: string): GroupLine {
  return isWhapiGroup(groupId) ? whapiGroupLine(deps) : sendblueGroupLine(deps);
}

function sendblueGroupLine(deps: GroupLineDeps): GroupLine {
  const keys = (): SendblueKeys => {
    if (!deps.sendblue) throw new ServiceError("sendblue", null);
    return deps.sendblue;
  };
  return {
    sendText: async (place, text, replyTo) => {
      // A note's link goes as its picture, then the link inside a sentence, as in a 1:1 chat (`noteCards.ts`).
      const drawn = await hostedNoteCard(text, deps.noteCardPicture, deps.hostPicture);
      if (drawn) {
        try {
          await sendGroupMedia(deps.fetch, keys(), place, drawn.address, replyTo);
          return await sendGroupText(deps.fetch, keys(), place, linkAfterCard(drawn.link), replyTo);
        } catch (error) {
          // A picture the app would not take: the link alone, as before.
          if (!isRefusal(error)) throw error;
        }
      }
      return await sendGroupText(deps.fetch, keys(), place, text, replyTo);
    },
    sendMedia: (place, url, replyTo) => sendGroupMedia(deps.fetch, keys(), place, url, replyTo),
    react: async (place, messageId, emoji) => {
      if (deps.sendblue) await reactInGroup(deps.fetch, deps.sendblue, place, messageId, emoji);
    },
    readMembers: async (place) => (deps.sendblue ? await readGroupMembers(deps.fetch, deps.sendblue, place.groupId) : null),
    readOwnMessage: async (place, messageId) => (deps.sendblue ? await readOwnGroupMessage(deps.fetch, deps.sendblue, messageId, place) : null),
  };
}

function whapiGroupLine(deps: GroupLineDeps): GroupLine {
  const keys = (): WhapiKeys => {
    if (!deps.whapi) throw new ServiceError("whapi", null);
    return deps.whapi;
  };
  const jid = (place: GroupPlace): string => {
    const found = groupJidOf(place.groupId);
    if (found === null) throw new ServiceError("whapi", 400);
    return found;
  };
  return {
    senderOnlyWebhook: true,
    sendText: async (place, text, replyTo) => {
      // A note's link carries its own preview, as in a 1:1 chat (`noteCards.ts`); one Whapi refuses goes plain.
      const preview = await whapiNotePreview(text, deps.noteCardPicture, deps.hostPicture);
      const sent = preview ? await sendWhapiLinkPreview(deps.fetch, keys(), jid(place), preview, replyTo) : null;
      return sent !== null ? sent : await sendWhapiText(deps.fetch, keys(), jid(place), text, replyTo);
    },
    sendMedia: (place, url, replyTo) => sendWhapiMedia(deps.fetch, keys(), jid(place), url, replyTo),
    react: async (_place, messageId, emoji) => {
      if (!deps.whapi) return;
      // An emoji WhatsApp refuses still leaves the chat a sign it landed, as on iMessage.
      if (!(await reactWhapi(deps.fetch, deps.whapi, messageId, emoji)) && emoji !== "👍") await reactWhapi(deps.fetch, deps.whapi, messageId, "👍");
    },
    readMembers: async (place) => {
      const found = groupJidOf(place.groupId);
      return deps.whapi && found !== null ? await readWhapiGroupMembers(deps.fetch, deps.whapi, found) : null;
    },
    readOwnMessage: async (place, messageId) => {
      const found = groupJidOf(place.groupId);
      if (!deps.whapi || found === null) return null;
      const message = await readWhapiMessage(deps.fetch, deps.whapi, messageId);
      // Only Tex's own words in this same group, never a member's.
      if (message === null || !message.fromMe || message.chatId !== found || message.text === "") return null;
      return message.text;
    },
  };
}
