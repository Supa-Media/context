import { gmailMessageToEvent, dateKeyOf } from "./parsing.js";
import { buildDayQuery, listMessageIds, getMessageOrNull } from "./api.js";
import { syncDayFromGmail } from "./sync.js";
import { openContactLookup } from "../contactLookup.js";

/*
 * THE FIRST-CONNECT IMPORT: the most recent fifty messages, and not a window.
 *
 * Owner decision, 2026-10-17: when somebody connects Gmail, Tex reads their
 * last fifty emails to get to know them. Sync is otherwise forward-only (#388)
 * and the historical backfill stays off; this is deliberately not that. The
 * argument, and what reversing it costs, is in
 * `docs/decisions/communications/gmail-and-sync-loop.md`.
 *
 * The shape:
 *
 *  - **One `messages.list` page of fifty**, newest first, across the
 *    connection's folders with Spam and Trash excluded. No date, no second
 *    page: the bound is a count somebody can say out loud, not a window that
 *    is as large as the mailbox is busy.
 *  - **Every day those fifty land on is written whole**, by
 *    `syncDayFromGmail` — the same unit, the same query and the same bytes as
 *    the forward pass, which is what makes a retry or a reconnect write
 *    nothing new rather than relying on deduplication.
 *  - **The oldest of those days is the only one the fifty can cut**, so a day
 *    is written only if its whole list fits under `RECENT_IMPORT_FETCH_CEILING`
 *    fetches in total. A day that does not fit is skipped, never written from
 *    part of its list. Newest first, so the ceiling costs the oldest day.
 *  - **No history and no cursor.** The forward pass owns `historyId`; mail
 *    that lands while this runs is on a day the next pass rebuilds anyway.
 */

/** How many of the most recent messages a first connect reads. */
export const RECENT_IMPORT_MESSAGES = 50;

/**
 * The most messages one import may fetch, the fifty included. Four times the
 * fifty: room for the oldest day's remainder on an ordinary mailbox, and a
 * hard stop on a firehose one.
 */
export const RECENT_IMPORT_FETCH_CEILING = 200;

/** Enough list pages to see past the ceiling, so a day over it is known to be over it. */
const DAY_LIST_PAGES = Math.ceil(RECENT_IMPORT_FETCH_CEILING / 100) + 1;

/**
 * @param {{store, fetchImpl, accessToken, mailboxSlug, address, folders,
 *          nonce: string, root?: string, folder?: string, quotaBytes: number,
 *          bytesAlreadyUsed?: number, attachmentMode?: "metadata-only" | "store",
 *          attachmentRetentionDays?: number | "forever"}} options
 * @returns {Promise<{daysWritten: number, daysSkipped: number, itemsFound: number,
 *                    bytesWritten: number, quotaExceeded: boolean}>}
 */
export async function runRecentImport(options) {
  const used = options.bytesAlreadyUsed ?? 0;
  const out = { daysWritten: 0, daysSkipped: 0, itemsFound: 0, bytesWritten: 0, quotaExceeded: false };
  if (options.quotaBytes - used <= 0) return { ...out, quotaExceeded: true };

  const { ids } = await listMessageIds({
    fetchImpl: options.fetchImpl,
    accessToken: options.accessToken,
    query: buildDayQuery({ folders: options.folders }),
    maxResults: RECENT_IMPORT_MESSAGES,
  });

  // Fetched once here to learn each message's day, and handed to the day
  // rebuild so it is never fetched twice.
  const known = new Map();
  const dates = new Set();
  for (const id of ids.slice(0, RECENT_IMPORT_MESSAGES)) {
    const message = await getMessageOrNull({ fetchImpl: options.fetchImpl, accessToken: options.accessToken, id });
    known.set(id, message);
    if (message === null) continue;
    dates.add(dateKeyOf(gmailMessageToEvent(message, { mailboxSlug: options.mailboxSlug })));
  }
  if (dates.size === 0) return out;

  let fetched = known.size;
  const contacts = await openContactLookup(options.store, { root: options.root });
  for (const date of [...dates].sort().reverse()) {
    const remaining = options.quotaBytes - used - out.bytesWritten;
    if (remaining <= 0) {
      out.quotaExceeded = true;
      break;
    }
    const result = await syncDayFromGmail({
      store: options.store,
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      mailboxSlug: options.mailboxSlug,
      address: options.address,
      folders: options.folders,
      date,
      nonce: options.nonce,
      // No `now`: a day's `updated` is its newest message's own time, so this
      // writes what the forward pass would, byte for byte.
      root: options.root,
      folder: options.folder,
      remainingQuotaBytes: remaining,
      attachmentMode: options.attachmentMode,
      attachmentRetentionDays: options.attachmentRetentionDays,
      contacts,
      known,
      maxFetches: RECENT_IMPORT_FETCH_CEILING - fetched,
      maxListPages: DAY_LIST_PAGES,
    });
    if (result.skipped) {
      out.daysSkipped += 1;
      continue;
    }
    fetched += result.fetched;
    out.bytesWritten += result.bytesWritten;
    out.itemsFound += result.messageCount;
    if (result.partsWritten > 0) out.daysWritten += 1;
    if (result.quotaExceeded) {
      out.quotaExceeded = true;
      break;
    }
  }
  // A cache: an import that threw before here only costs the next one a rebuild.
  await contacts.save();
  return out;
}
