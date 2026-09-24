import { gmailMessageToEvent, dateKeyOf } from "./parsing.js";
import { buildDayQuery, listAllMessageIds, getMessageOrNull, listAllHistory, GmailHistoryExpiredError } from "./api.js";
import { syncOneDay } from "./render.js";

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
  const ids = await listAllMessageIds({ fetchImpl: options.fetchImpl, accessToken: options.accessToken, query });
  const events = [];
  for (const id of ids) {
    // A message listed a moment ago and gone by the time it is fetched is
    // ordinary in a live mailbox — the owner deleted it, or a filter moved it
    // to Trash, between the two calls. The day is regenerated from whatever
    // Gmail still has, which is exactly what "the day is always the complete,
    // current query result" means; it is not a reason to abandon the day.
    const message = await getMessageOrNull({
      fetchImpl: options.fetchImpl,
      accessToken: options.accessToken,
      id,
    });
    if (message === null) continue;
    events.push(gmailMessageToEvent(message, { mailboxSlug: options.mailboxSlug }));
  }
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
  });
  return { ...result, messageCount: events.length };
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

  if (history.messageIds.size === 0) {
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
    if (message === null) continue;
    affectedDates.add(dateKeyOf(gmailMessageToEvent(message, { mailboxSlug: options.mailboxSlug })));
  }

  let bytesWritten = 0;
  let quotaExceeded = false;
  const daysTouched = [];
  const used = options.bytesAlreadyUsed ?? 0;
  for (const date of [...affectedDates].sort()) {
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
    });
    daysTouched.push(date);
    bytesWritten += result.bytesWritten;
    if (result.quotaExceeded) {
      quotaExceeded = true;
      break;
    }
  }
  return {
    gapDetected: false,
    daysTouched,
    bytesWritten,
    quotaExceeded,
    historyId: resumeFrom,
    truncated: history.truncated,
  };
}
