import { gmailMessageToEvent, dateKeyOf } from "./parsing.js";
import { buildDayQuery, listAllMessageIds, getMessageOrNull, listAllHistory, GmailHistoryExpiredError } from "./api.js";
import { syncOneDay } from "./render.js";
import { openContactLookup } from "../contactLookup.js";
import { cachesDay, readDayCache, serializeDayCache, writeDayCache } from "./messageCache.js";

/* -------------------------------------------------------------------------- */
/* Orchestration: backfill and incremental sync                               */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` for every day in `[start, end]` inclusive, oldest first. */
export function dateRange(startDate, endDate) {
  const out = [];
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Fetch and render one calendar day, end to end, from Gmail's live state.
 *
 * This is the unit both backfill and incremental reconcile call: it is what
 * makes re-running any day — the same day twice in a backfill, or a day named
 * again by history — idempotent. The day is never assembled from a partial
 * page; it is always the complete, current query result for that date.
 */
export async function syncDayFromGmail(options) {
  const query = buildDayQuery({ folders: options.folders, date: options.date });
  const ids = await listAllMessageIds({
    fetchImpl: options.fetchImpl,
    accessToken: options.accessToken,
    query,
    ...(options.maxListPages === undefined ? {} : { maxPages: options.maxListPages }),
  });
  // `known` holds messages a caller has already fetched (the first-connect
  // import's fifty, an incremental pass's new mail); `maxFetches` is the
  // import's (`recent.js`): it has already fetched some of this day's messages, and it may not fetch more
  // than its ceiling. A day over the ceiling is not written at all — never
  // from part of its list, which is the one thing a day must not be.
  const known = options.known ?? new Map();
  // The events this day was last rendered from (`messageCache.js`): a message
  // never changes once it exists, so only ids the cache lacks are fetched.
  const caching = options.messageCache !== false && cachesDay(options.date, options.wallClockMs);
  const cache = caching
    ? await readDayCache(options.store, options.mailboxSlug, options.date)
    : { events: new Map(), existed: false };
  if (options.maxFetches !== undefined) {
    const unknown = ids.filter((id) => !known.has(id) && !cache.events.has(id)).length;
    if (unknown > options.maxFetches) {
      return { bytesWritten: 0, partsWritten: 0, contactsWritten: 0, quotaExceeded: false, messageCount: 0, fetched: 0, skipped: true };
    }
  }
  const events = [];
  let fetched = 0;
  try {
    for (const id of ids) {
      const cached = cache.events.get(id);
      if (cached !== undefined) {
        events.push(cached);
        continue;
      }
      // A message listed a moment ago and gone by the time it is fetched is
      // ordinary in a live mailbox — the owner deleted it, or a filter moved it
      // to Trash, between the two calls. The day is regenerated from whatever
      // Gmail still has, which is exactly what "the day is always the complete,
      // current query result" means; it is not a reason to abandon the day.
      let message = known.get(id);
      if (message === undefined) {
        fetched += 1;
        message = await getMessageOrNull({
          fetchImpl: options.fetchImpl,
          accessToken: options.accessToken,
          id,
        });
      }
      if (message === null) continue;
      // Through JSON, the same as a cached event, so a day renders the same
      // bytes whether its events were fetched this pass or remembered.
      events.push(JSON.parse(JSON.stringify(gmailMessageToEvent(message, { mailboxSlug: options.mailboxSlug }))));
    }
  } catch (error) {
    // Google stopped this day part-way (a rate limit, say). Keep what was
    // fetched, so the retry asks only for the rest instead of starting over
    // and meeting the same limit at the same message. A partial cache is
    // safe: it only says which messages need no fetch, and the note is still
    // rendered from the day's whole list.
    if (caching && fetched > 0) {
      const kept = new Map(cache.events);
      for (const event of events) kept.set(event.messageId, event);
      await writeDayCache(options.store, options.mailboxSlug, options.date, serializeDayCache(options.date, [...kept.values()]), {
        existed: cache.existed,
      });
    }
    throw error;
  }
  // Serialized before `syncOneDay`, which annotates attachments in place.
  const cacheText = caching ? serializeDayCache(options.date, events) : null;
  const result = await syncOneDay({
    store: options.store,
    mailboxSlug: options.mailboxSlug,
    address: options.address,
    date: options.date,
    events,
    nonce: options.nonce,
    now: options.now,
    root: options.root,
    folder: options.folder,
    remainingQuotaBytes: options.remainingQuotaBytes,
    fetchImpl: options.fetchImpl,
    accessToken: options.accessToken,
    attachmentMode: options.attachmentMode,
    attachmentRetentionDays: options.attachmentRetentionDays,
    contacts: options.contacts,
  });
  // After the note, so a cache never runs ahead of the day it describes.
  if (cacheText !== null && !result.quotaExceeded) {
    await writeDayCache(options.store, options.mailboxSlug, options.date, cacheText, { existed: cache.existed });
  }
  return { ...result, messageCount: events.length, fetched, skipped: false };
}

/**
 * Backfill: every day in the connection's window, oldest to newest so a
 * quota ceiling is hit on the *most recent* history rather than the oldest —
 * arguable either way, but "the mail from this week" is the one a person
 * checks first once a mailbox is freshly connected, so it is written last is
 * wrong; newest-first backfill is left as a documented choice for the
 * scheduler that paginates this across many invocations, not decided here.
 *
 * @param {{store, fetchImpl, accessToken, mailboxSlug, address, folders,
 *          startDate: string, endDate: string, nonce: string, now?: string,
 *          root?: string, folder?: string, quotaBytes: number, bytesAlreadyUsed?: number,
 *          attachmentMode?: "metadata-only" | "store",
 *          attachmentRetentionDays?: number | "forever"}} options
 * @returns {Promise<{daysProcessed: number, daysWithMail: number, itemsFound: number, bytesWritten: number, quotaExceeded: boolean}>}
 */
export async function runBackfill(options) {
  const dates = dateRange(options.startDate, options.endDate);
  let bytesWritten = 0;
  let daysWithMail = 0;
  let itemsFound = 0;
  let daysProcessed = 0;
  let quotaExceeded = false;
  const used = options.bytesAlreadyUsed ?? 0;
  // One contact lookup for the whole run: the folder is listed once, not per day.
  const contacts = await openContactLookup(options.store, { root: options.root });

  for (const date of dates) {
    const remaining = options.quotaBytes - used - bytesWritten;
    if (remaining <= 0) {
      quotaExceeded = true;
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
      now: options.now,
      root: options.root,
      folder: options.folder,
      remainingQuotaBytes: remaining,
      attachmentMode: options.attachmentMode,
      attachmentRetentionDays: options.attachmentRetentionDays,
      contacts,
    });
    daysProcessed += 1;
    itemsFound += result.messageCount;
    bytesWritten += result.bytesWritten;
    if (result.partsWritten > 0) daysWithMail += 1;
    if (result.quotaExceeded) {
      quotaExceeded = true;
      break;
    }
  }
  // A cache: a run that threw before here only costs the next one a rebuild.
  await contacts.save();
  return { daysProcessed, daysWithMail, itemsFound, bytesWritten, quotaExceeded };
}

/**
 * Incremental sync: `history.list` from the connection's cursor, regenerate
 * every day a changed message landed on, advance the cursor.
 *
 * `gapDetected` is Gmail's 404 on an expired `startHistoryId` — the caller
 * (the control-plane sync job) responds by calling `runBackfill` over the
 * connection's window again, which regenerates every day from live state and
 * is therefore a correct reconcile regardless of what was missed.
 *
 * `truncated` is the other half of the same honesty: the history walk ran out
 * of pages before it ran out of history, so `historyId` here is the last
 * record walked rather than the mailbox head, and the caller has more to do.
 * A caller that ignores it and stores the cursor anyway is still correct about
 * what it wrote; it is only wrong about being finished — which is why this is
 * returned rather than thrown.
 *
 * @returns {Promise<{gapDetected: boolean, daysTouched: string[], bytesWritten: number,
 *                     quotaExceeded: boolean, historyId?: string, truncated: boolean}>}
 */
export async function runIncrementalSync(options) {
  let history;
  try {
    history = await listAllHistory({
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      startHistoryId: options.startHistoryId,
      folders: options.folders,
      ...(options.maxHistoryPages === undefined ? {} : { maxPages: options.maxHistoryPages }),
    });
  } catch (error) {
    if (error instanceof GmailHistoryExpiredError) {
      return { gapDetected: true, daysTouched: [], bytesWritten: 0, quotaExceeded: false, truncated: false };
    }
    throw error;
  }

  // Where the next pass should start. A complete walk ends at the mailbox
  // head; a truncated one ends at the last record it actually read, and
  // `undefined` (a truncated walk that saw no record ids at all) means "do not
  // move the cursor", which the caller must honour.
  const resumeFrom = history.truncated ? history.lastRecordId : history.historyId;

  // Days rebuilt whether or not history named them (`reconcileDates`): a day
  // whose note fell behind Gmail catches up on the next pass rather than on
  // the next message that lands on it. An unchanged day re-renders
  // byte-identical and is not written.
  const reconcile = (options.reconcileDates ?? []).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
  if (history.messageIds.size === 0 && reconcile.length === 0) {
    return {
      gapDetected: false,
      daysTouched: [],
      bytesWritten: 0,
      quotaExceeded: false,
      historyId: resumeFrom,
      truncated: history.truncated,
    };
  }

  // Which days changed. Fetching each changed message once here — rather than
  // relying on `syncDayFromGmail`'s own re-fetch — is the cheap way to learn
  // dates; `syncDayFromGmail` still re-lists and re-fetches the day's FULL set
  // afterwards, because a day's note must reflect everything on it, not only
  // the messages history happened to name.
  const affectedDates = new Set();
  // Handed to each day's rebuild, so a new message is fetched once, not twice.
  const known = new Map();
  for (const id of history.messageIds) {
    // Added and then deleted before this pass ran: history still names it, and
    // `messages.get` answers 404. Skipping it is right — there is no day to
    // learn from a message that no longer exists — and it must not be mistaken
    // for the cursor having expired.
    const message = await getMessageOrNull({
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      id,
    });
    known.set(id, message);
    if (message === null) continue;
    affectedDates.add(dateKeyOf(gmailMessageToEvent(message, { mailboxSlug: options.mailboxSlug })));
  }

  let bytesWritten = 0;
  let quotaExceeded = false;
  const daysTouched = [];
  const used = options.bytesAlreadyUsed ?? 0;
  const contacts = await openContactLookup(options.store, { root: options.root });
  for (const date of [...new Set([...affectedDates, ...reconcile])].sort()) {
    const remaining = options.quotaBytes - used - bytesWritten;
    if (remaining <= 0) {
      quotaExceeded = true;
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
      now: options.now,
      root: options.root,
      folder: options.folder,
      remainingQuotaBytes: remaining,
      attachmentMode: options.attachmentMode,
      attachmentRetentionDays: options.attachmentRetentionDays,
      contacts,
      known,
    });
    // A reconciled day counts only when it caught something up.
    if (affectedDates.has(date) || result.bytesWritten > 0) daysTouched.push(date);
    bytesWritten += result.bytesWritten;
    if (result.quotaExceeded) {
      quotaExceeded = true;
      break;
    }
  }
  // Pages nobody has written to in a year go to the archive, with the lookup
  // this pass already holds; the next message brings one back. Last, so this
  // pass's own drafts count as activity. Never throws.
  // `docs/decisions/communications/contacts-and-chat.md`.
  if (history.messageIds.size > 0) await contacts.sweepDormant({ now: options.dormancyNow });
  // A cache: a run that threw before here only costs the next one a rebuild.
  await contacts.save();
  return {
    gapDetected: false,
    daysTouched,
    bytesWritten,
    quotaExceeded,
    historyId: resumeFrom,
    truncated: history.truncated,
  };
}
