/**
 * The Inbox landing page's data shaping — **virtual**, per
 * `docs/decisions/communications.md`: built from the folder listings every
 * other console page already fetches, never a written rollup and never a
 * second index that can drift from the bucket.
 */

import {
  CHANNEL_FOLDERS,
  CONTACTS_FOLDER,
  isContactNotePath,
  isMailboxSlug,
  parseChannelDayPath,
} from "@context/communications";
import { MEETINGS_FOLDER, isMeetingNotePath } from "@context/meetings/paths";
import type { FileEntry } from "../files/types";
import type { InboxKind, InboxRow } from "./types";

/** How many of a channel's most recent active days count toward its Inbox row. */
export const INBOX_RECENT_DAYS = 30;

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** `1712345678000` → `"2024-04-05"`, in UTC — the same day-boundary every channel-day date uses. */
function dateOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * The distinct active dates a channel's own folder listing shows, newest
 * first.
 *
 * `meetings` reads its date off the **filename** — every meeting note begins
 * `YYYY-MM-DD-`, per `packages/meetings`'s own `MEETING_FILE` shape — rather
 * than off a `started` frontmatter field, because this page is virtual and a
 * body read per meeting is exactly the cost that decision refuses to pay for
 * a rollup. Every messaging channel reads `parseChannelDayPath`, which
 * answers "what day is this" off the path alone, and a split day's `-part-N`
 * siblings collapse onto the one date they all belong to. `contacts` has no
 * "day" of its own — a contact page is edited, not dated by a channel — so it
 * reads the listing's own `updatedAt`, the same recency a folder view already
 * shows for any file; a contact with no `updatedAt` (a store that does not
 * report one) contributes no date rather than a wrong one.
 */
export function activeDatesFor(kind: InboxKind, entries: readonly FileEntry[]): string[] {
  const dates = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    if (kind === "meetings") {
      if (!isMeetingNotePath(entry.path)) continue;
      dates.add(baseName(entry.path).slice(0, 10));
      continue;
    }
    if (kind === "contacts") {
      if (!isContactNotePath(entry.path) || entry.updatedAt === undefined) continue;
      dates.add(dateOf(entry.updatedAt));
      continue;
    }
    const day = parseChannelDayPath(entry.path);
    if (day === null || day.channel !== kind) continue;
    dates.add(day.date);
  }
  return [...dates].sort().reverse();
}

/**
 * What one channel calls itself on the Inbox row.
 *
 * `rename`, once a customer can set one, wins over everything else — that
 * storage does not exist yet, so no caller has one to pass and every row
 * falls through to the next rule. `address` is the real address a mailbox's
 * own note frontmatter carries (`account: "name@example.com"`); a caller
 * reads it off one representative day the same way `list_channel_days`
 * already does, and passes it in here rather than this function reaching for
 * it, which is what keeps this pure. Absent either, the slug is the honest
 * fallback — it is still the folder the row opens.
 */
export function channelLabel(
  kind: InboxKind,
  account: string,
  options: { address?: string | null; rename?: string | null } = {},
): string {
  if (options.rename && options.rename.trim() !== "") return options.rename.trim();
  if (kind === "meetings") return "Meetings";
  if (kind === "contacts") return "Contacts";
  if (kind === "google-chat") return "Google Chat";
  if (kind === "imessage") return "iMessage";
  if (options.address && options.address.trim() !== "") return options.address.trim();
  return account;
}

/** One channel or mailbox the Inbox found a folder for. */
export interface InboxCandidate {
  kind: InboxKind;
  /** The mailbox slug, for `kind === "email"`; `""` for every other kind. */
  account: string;
  path: string;
}

/**
 * Which of the Inbox's possible children actually exist, from `0-inbox`'s own
 * listing and — because `email` nests one level deeper, a person having
 * several mailboxes — `0-inbox/email`'s.
 *
 * A folder that is not there is a channel nobody has connected, and does not
 * become a row: the empty state is what says "here is how to connect one",
 * not a row claiming activity it cannot have. `rootEntries` undefined (still
 * loading) answers no candidates at all rather than guessing, the same "wait
 * rather than tell somebody they have nothing" rule `ConsoleData.storage`
 * uses.
 */
export function discoverInboxChannels(
  rootEntries: readonly FileEntry[] | undefined,
  emailEntries: readonly FileEntry[] | undefined,
): InboxCandidate[] {
  if (rootEntries === undefined) return [];
  const folders = new Set(
    rootEntries.filter((entry) => entry.kind === "folder").map((entry) => entry.path),
  );
  const candidates: InboxCandidate[] = [];

  if (folders.has(MEETINGS_FOLDER)) candidates.push({ kind: "meetings", account: "", path: MEETINGS_FOLDER });
  if (folders.has(CHANNEL_FOLDERS["google-chat"])) {
    candidates.push({ kind: "google-chat", account: "", path: CHANNEL_FOLDERS["google-chat"] });
  }
  if (folders.has(CHANNEL_FOLDERS.imessage)) {
    candidates.push({ kind: "imessage", account: "", path: CHANNEL_FOLDERS.imessage });
  }
  if (folders.has(CONTACTS_FOLDER)) candidates.push({ kind: "contacts", account: "", path: CONTACTS_FOLDER });

  if (folders.has(CHANNEL_FOLDERS.email) && emailEntries !== undefined) {
    for (const entry of emailEntries) {
      if (entry.kind !== "folder") continue;
      const slug = entry.path.slice(CHANNEL_FOLDERS.email.length + 1);
      if (slug.includes("/") || !isMailboxSlug(slug)) continue;
      candidates.push({ kind: "email", account: slug, path: entry.path });
    }
  }

  return candidates;
}

export interface InboxChannelSource {
  kind: InboxKind;
  /** The mailbox slug, for `kind === "email"`; `""` for every other kind. */
  account: string;
  /** The folder this row opens. */
  path: string;
  label: string;
  /** This channel's own folder listing, or `undefined` while it is still loading. */
  entries: readonly FileEntry[] | undefined;
}

/** One source into its row. `undefined` entries read as "not active yet" rather than "empty". */
export function shapeInboxRow(source: InboxChannelSource, recentDays = INBOX_RECENT_DAYS): InboxRow {
  const dates = source.entries === undefined ? [] : activeDatesFor(source.kind, source.entries);
  return {
    kind: source.kind,
    account: source.account,
    path: source.path,
    label: source.label,
    lastActive: dates[0] ?? null,
    activeDays: Math.min(dates.length, recentDays),
  };
}

/**
 * Every row, most recently active first — a channel with no activity yet
 * sorts to the end rather than being dropped, because the empty state still
 * has to say which channels are connected.
 */
export function shapeInboxRows(
  sources: readonly InboxChannelSource[],
  recentDays = INBOX_RECENT_DAYS,
): InboxRow[] {
  return sources
    .map((source) => shapeInboxRow(source, recentDays))
    .sort((a, b) => {
      if (a.lastActive === null && b.lastActive === null) return 0;
      if (a.lastActive === null) return 1;
      if (b.lastActive === null) return -1;
      return b.lastActive.localeCompare(a.lastActive);
    });
}
