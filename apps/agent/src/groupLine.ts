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
import { linkPictureFinder, sendWithLinkPictures } from "./linkPreviews";
import { counted, type CountDataset } from "./textCounts";
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
  /**
   * True when the app tells Tex, by webhook, that a group's people changed (WhatsApp, Whapi's `groups` events), so
   * the list a turn read can be kept and trusted before sending until a change or `KEPT_FRESH_MS` (`groupMembers.ts`).
   */
  readonly membershipEvents?: true;
}

export type GroupLineDeps = {
  fetch: Fetch;
  sendblue?: SendblueKeys | null;
  whapi?: WhapiKeys | null;
  /** Serves a picture at a short-lived address the app fetches (`media.ts`). */
  hostPicture?: (picture: Picture) => Promise<string>;
  /** Draws a note link's picture (`noteCards.ts`), sent before the link on iMessage, as in a 1:1 chat. */
  noteCardPicture?: NoteCardDrawer;
  /** Where each message Tex sends is counted (`textCounts.ts`); absent, nowhere. */
  textCounts?: CountDataset;
  /** A group's line served from elsewhere (the gateway's remote group line, `remoteLine.ts`); set, every call goes there and nothing is counted here. */
  remote?: (groupId: string) => GroupLine;
};

export function groupLineFor(deps: GroupLineDeps, groupId: string): GroupLine {
  if (deps.remote) return deps.remote(groupId);
  const line = isWhapiGroup(groupId) ? whapiGroupLine(deps, groupId) : sendblueGroupLine(deps);
  const dataset = deps.textCounts;
  if (dataset === undefined) return line;
  // Every message Tex sends in a group, counted once the app took it (`textCounts.ts`).
  return {
    ...line,
    sendText: (place, text, replyTo) => counted(dataset, "group", "text", () => line.sendText(place, text, replyTo)),
    sendMedia: (place, url, replyTo) => counted(dataset, "group", "media", () => line.sendMedia(place, url, replyTo)),
  };
}

/**
 * The two webhook flags a group's line sets, by the same rule `groupLineFor` picks the line with: WhatsApp groups
 * (`whapi:<jid>`) only. Synchronous, so the gateway's remote group line (`remoteLine.ts`) reads them without a call.
 */
export function groupLineFlags(groupId: string): Pick<GroupLine, "senderOnlyWebhook" | "membershipEvents"> {
  return isWhapiGroup(groupId) ? { senderOnlyWebhook: true, membershipEvents: true } : {};
}

/** The group line deps an object's deps stand for: its `remoteGroupLine` (`chatObject.ts`) is the seam, read as `remote`. */
export function groupLineSeam<T extends GroupLineDeps & { remoteGroupLine?: (groupId: string) => GroupLine }>(deps: T): GroupLineDeps {
  return { ...deps, remote: deps.remoteGroupLine ?? deps.remote };
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
          // A picture the line would not take: the link in its sentence alone, with no second try at a picture.
          if (!isRefusal(error)) throw error;
          return await sendGroupText(deps.fetch, keys(), place, linkAfterCard(drawn.link), replyTo);
        }
      }
      // Any other link: its picture, then the words with the link tappable, as in a 1:1 chat (`linkPreviews.ts`).
      return await sendWithLinkPictures(
        text,
        linkPictureFinder(deps.fetch, deps.hostPicture, deps.noteCardPicture),
        (address) => sendGroupMedia(deps.fetch, keys(), place, address, replyTo),
        (words) => sendGroupText(deps.fetch, keys(), place, words, replyTo),
      );
    },
    sendMedia: (place, url, replyTo) => sendGroupMedia(deps.fetch, keys(), place, url, replyTo),
    react: async (place, messageId, emoji) => {
      if (deps.sendblue) await reactInGroup(deps.fetch, deps.sendblue, place, messageId, emoji);
    },
    readMembers: async (place) => (deps.sendblue ? await readGroupMembers(deps.fetch, deps.sendblue, place.groupId) : null),
    readOwnMessage: async (place, messageId) => (deps.sendblue ? await readOwnGroupMessage(deps.fetch, deps.sendblue, messageId, place) : null),
  };
}

function whapiGroupLine(deps: GroupLineDeps, groupId: string): GroupLine {
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
    ...groupLineFlags(groupId),
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
