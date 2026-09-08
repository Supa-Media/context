/**
 * Which communications view, if any, a console path belongs to.
 *
 * `docs/decisions/communications.md` decided the on-bucket shape; this is the
 * one place the console reads it back to decide what to draw instead of the
 * generic file browser — `FolderView` for a folder, `NoteEditor` for a note.
 * Every recogniser here is a **path predicate over the same shapes
 * `@context/communications` and `@context/meetings` already export**, never a
 * second implementation of "is this a channel-day note" — see
 * `apps/mcp/src/communications/paths.js`'s own header for why two
 * implementations of one shape is how they end up disagreeing.
 */

import {
  CHANNELS,
  CHANNEL_FOLDERS,
  CONTACTS_FOLDER,
  INBOX_FOLDER,
  isContactNotePath,
  isMailboxSlug,
  parseChannelDayPath,
} from "@context/communications";
import { MEETINGS_FOLDER } from "@context/meetings/paths";
import type { CommsChannel, InboxKind } from "./types";

export { INBOX_FOLDER, MEETINGS_FOLDER, CONTACTS_FOLDER, CHANNEL_FOLDERS };

/** The folders the Inbox landing page rolls up: every one of its direct children. */
export const INBOX_CHANNEL_FOLDERS: Record<InboxKind, string> = {
  meetings: MEETINGS_FOLDER,
  contacts: CONTACTS_FOLDER,
  email: CHANNEL_FOLDERS.email,
  "google-chat": CHANNEL_FOLDERS["google-chat"],
  imessage: CHANNEL_FOLDERS.imessage,
};

/** A folder a mailbox slug names, e.g. `0-inbox/email/name-at-example-com`. */
export function mailboxFolder(account: string): string {
  return `${CHANNEL_FOLDERS.email}/${account}`;
}

export type CommsRoute =
  | { kind: "inbox" }
  | { kind: "channel"; channel: CommsChannel; account: string }
  | { kind: "channel-day"; channel: CommsChannel; account: string; date: string; part: number }
  | { kind: "contacts" }
  | { kind: "contact"; slug: string };

/**
 * What a path is, for the communications console — or `null` when it is an
 * ordinary note or folder the generic browser already knows how to show.
 *
 * **`0-inbox/meetings` is deliberately `null`.** It is a row on the Inbox
 * landing page (`inbox.ts` computes its recency the same as any channel), but
 * a meeting note is one file per meeting rather than one per day, so there is
 * no "channel-day" shape to route it to — the folder keeps using the
 * console's ordinary listing, which already shows meeting notes correctly.
 * See `channel.ts`'s header.
 *
 * Order matters only for readability: the shapes below cannot overlap, the
 * same way `classifyCaptureKind` in the gateway's own recogniser documents —
 * a channel-day path is never a contact path, a mailbox folder is never the
 * root, and so on.
 */
export function classifyCommsPath(path: string): CommsRoute | null {
  if (path === INBOX_FOLDER) return { kind: "inbox" };
  if (path === CONTACTS_FOLDER) return { kind: "contacts" };
  if (path === CHANNEL_FOLDERS["google-chat"]) {
    return { kind: "channel", channel: "google-chat", account: "" };
  }
  if (path === CHANNEL_FOLDERS.imessage) {
    return { kind: "channel", channel: "imessage", account: "" };
  }

  const mailbox = matchMailboxFolder(path);
  if (mailbox !== null) return { kind: "channel", channel: "email", account: mailbox };

  const day = parseChannelDayPath(path);
  if (day !== null) {
    // `day.channel` is `string` to the type checker — `CHANNELS` carries no
    // JSDoc annotation for `allowJs` to narrow from — but `parseChannelDayPath`
    // only ever returns one of the three real channels; `paths.test.ts` holds
    // that promise rather than this cast alone.
    return {
      kind: "channel-day",
      channel: day.channel as CommsChannel,
      account: day.account,
      date: day.date,
      part: day.part,
    };
  }

  if (isContactNotePath(path)) {
    return { kind: "contact", slug: path.slice(CONTACTS_FOLDER.length + 1, -".md".length) };
  }

  return null;
}

/** `0-inbox/email/<slug>` — a connected mailbox's own folder, and only that. */
function matchMailboxFolder(path: string): string | null {
  const prefix = `${CHANNEL_FOLDERS.email}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  // Exactly one segment: a fingerprint-named capture (`0-inbox/email/<hex>.md`)
  // is a file, not a folder, and never reaches here with a `.md` on it; a
  // folder two levels deeper — `attachments/`, or a subfolder somebody made by
  // hand inside a mailbox — is that folder's own concern, not this one's.
  if (rest === "" || rest.includes("/")) return null;
  return isMailboxSlug(rest) ? rest : null;
}

/** Every channel this console rolls the Inbox up from, meetings first, contacts last. */
export const INBOX_KINDS: readonly InboxKind[] = [
  "meetings",
  ...CHANNELS,
  "contacts",
] as readonly InboxKind[];
