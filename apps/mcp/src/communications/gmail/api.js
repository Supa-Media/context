import { isCalendarDate } from "../../../../../packages/communications/src/index.js";

/** Where every Gmail REST call in this file goes. */
export const GMAIL_API_ORIGIN = "https://gmail.googleapis.com";

/** The Gmail system labels a folder name maps to. Spam and Trash are never here. */
export const FOLDER_LABEL_IDS = Object.freeze({ inbox: "INBOX", sent: "SENT" });

/* -------------------------------------------------------------------------- */
/* Gmail search query — pure                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `q` parameter for `messages.list`, scoped to the connection's folders
 * and, optionally, one calendar day.
 *
 * `-in:spam -in:trash` is written even though `in:inbox`/`in:sent` already
 * exclude both: Spam and Trash are excluded **unconditionally** in v1
 * (`docs/decisions/communications.md`), so this is asserted in the query
 * itself rather than left as something the folder list merely does not
 * mention.
 *
 * @param {{folders: Array<"inbox"|"sent">, date?: string}} options
 */
export function buildDayQuery(options) {
  const folders = Array.isArray(options?.folders) && options.folders.length ? options.folders : ["inbox", "sent"];
  const folderTerm = folders.map((folder) => `in:${folder}`).join(" OR ");
  const terms = [folders.length > 1 ? `(${folderTerm})` : folderTerm, "-in:spam", "-in:trash"];
  if (options?.date) {
    if (!isCalendarDate(options.date)) throw new TypeError(`not a calendar date: ${options.date}`);
    const start = Math.floor(Date.parse(`${options.date}T00:00:00.000Z`) / 1000);
    const end = start + 24 * 60 * 60;
    terms.push(`after:${start}`, `before:${end}`);
  }
  return terms.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Gmail REST calls — the only I/O in this file                               */
/* -------------------------------------------------------------------------- */

/** A Gmail API call that failed, classified just enough for the caller to react. */
export class GmailApiError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.reason = typeof details.reason === "string" ? details.reason : undefined;
    this.googleStatus = typeof details.googleStatus === "string" ? details.googleStatus : undefined;
  }
}

/** `history.list` answered 404: the cursor is too old and a full reconcile is needed. */
export class GmailHistoryExpiredError extends GmailApiError {
  constructor() {
    super(404, "Gmail's history cursor has expired; a full reconcile is required.");
    this.name = "GmailHistoryExpiredError";
  }
}

export async function gmailFetch(fetchImpl, accessToken, path, params) {
  const url = new URL(`${GMAIL_API_ORIGIN}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    // A 404 IS NOT UNIVERSALLY A HISTORY GAP, and this used to say it was.
    // `history.list` answering 404 means the cursor expired and the only
    // correct answer is a full reconcile; `messages.get` answering 404 means
    // one message was deleted between being listed and being fetched, which
    // is an ordinary Tuesday in a live mailbox, and `attachments.get`
    // answering 404 means one file is gone. Mapping all three to
    // `GmailHistoryExpiredError` made a deleted message either abort the whole
    // sync or — if a caller reacted to the type the way the class name tells
    // it to — trigger a needless 90-day reconcile, once per deletion, forever.
    // Only `listHistoryPage` promotes a 404 now, at its own call site.
    throw new GmailApiError(
      response.status,
      `Gmail answered ${path} with ${response.status}`,
      await safeGoogleErrorDetails(response),
    );
  }
  return response.json();
}

async function safeGoogleErrorDetails(response) {
  try {
    const type = response.headers?.get?.("content-type") ?? "";
    if (!type.toLowerCase().includes("application/json")) return {};
    const body = await response.json();
    const error = body && typeof body === "object" ? body.error : undefined;
    if (!error || typeof error !== "object") return {};
    const reasons = Array.isArray(error.errors)
      ? error.errors
          .map((entry) => entry?.reason)
          .filter((reason) => typeof reason === "string" && reason.length > 0)
      : [];
    return {
      reason: reasons[0],
      googleStatus: typeof error.status === "string" ? error.status : undefined,
    };
  } catch {
    return {};
  }
}

/** One page of message ids matching `query`. */
export async function listMessageIds({ fetchImpl, accessToken, query, pageToken, maxResults = 100 }) {
  const body = await gmailFetch(fetchImpl, accessToken, "/gmail/v1/users/me/messages", {
    q: query,
    pageToken,
    maxResults,
  });
  return {
    ids: (body.messages ?? []).map((entry) => String(entry.id)),
    nextPageToken: body.nextPageToken,
    resultSizeEstimate: Number.isFinite(body.resultSizeEstimate) ? body.resultSizeEstimate : 0,
  };
}

/** Every message id matching `query`, fully paginated. Bounded so a runaway query cannot loop forever. */
export async function listAllMessageIds({ fetchImpl, accessToken, query, maxPages = 50 }) {
  const ids = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listMessageIds({ fetchImpl, accessToken, query, pageToken });
    ids.push(...result.ids);
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  return ids;
}

/** One message, in full — the only shape that carries a body and headers. */
export async function getMessage({ fetchImpl, accessToken, id }) {
  return gmailFetch(fetchImpl, accessToken, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, {
    format: "full",
  });
}

/**
 * One message, or `null` if Gmail no longer has it.
 *
 * Every other failure still throws. A 404 here is the mailbox having moved on
 * between a list and a fetch — a message deleted, or moved to Trash, in the
 * seconds between — and it is the single most common transient a sync of a
 * live mailbox meets. It is **not** an expired history cursor, and the two
 * were the same exception until a review pointed the difference out: see
 * `gmailFetch`.
 */
export async function getMessageOrNull({ fetchImpl, accessToken, id }) {
  try {
    return await getMessage({ fetchImpl, accessToken, id });
  } catch (error) {
    // `GmailHistoryExpiredError` is EXCLUDED rather than caught by inheritance
    // — it extends `GmailApiError` with status 404, so a plain
    // `instanceof GmailApiError && status === 404` would swallow it. It cannot
    // arise here (only `listHistoryPage` raises one), and swallowing an
    // impossible error is how a narrowing like this stops being provable: with
    // it caught, re-widening `gmailFetch` to promote every 404 again failed no
    // test at all, because this handler absorbed the difference.
    if (error instanceof GmailHistoryExpiredError) throw error;
    if (error instanceof GmailApiError && error.status === 404) return null;
    throw error;
  }
}

/** The mailbox's current `historyId` — the cursor a fresh backfill or reconcile starts from. */
export async function getProfileHistoryId({ fetchImpl, accessToken }) {
  const body = await gmailFetch(fetchImpl, accessToken, "/gmail/v1/users/me/profile", {});
  return String(body.historyId ?? "");
}

/**
 * One page of `history.list`. Throws `GmailHistoryExpiredError` on a 404,
 * which is Gmail's documented signal that `startHistoryId` is too old — the
 * gap `docs/decisions/communications.md` names, whose only correct answer is
 * a full reconcile.
 */
export async function listHistoryPage({ fetchImpl, accessToken, startHistoryId, pageToken }) {
  let body;
  try {
    body = await gmailFetch(fetchImpl, accessToken, "/gmail/v1/users/me/history", {
      startHistoryId,
      historyTypes: "messageAdded",
      pageToken,
    });
  } catch (error) {
    // THIS is the one call site where a 404 means the cursor expired, so this
    // is the one place that promotes it. See `gmailFetch` for why that is not
    // done there any more.
    if (error instanceof GmailApiError && error.status === 404) throw new GmailHistoryExpiredError();
    throw error;
  }
  const ids = new Set();
  let lastRecordId;
  for (const record of body.history ?? []) {
    if (record?.id !== undefined) {
      const id = String(record.id);
      if (lastRecordId === undefined || historyIdIsAfter(id, lastRecordId)) lastRecordId = id;
    }
    for (const added of record.messagesAdded ?? []) {
      if (added?.message?.id) ids.add(String(added.message.id));
    }
  }
  return {
    messageIds: ids,
    nextPageToken: body.nextPageToken,
    historyId: body.historyId,
    lastRecordId,
  };
}

/**
 * Is `a` a later history id than `b`?
 *
 * Compared as decimal digit strings — length first, then lexicographically —
 * rather than through `Number`. A Gmail `historyId` is an unsigned 64-bit
 * value delivered as a string, and the ones large enough to lose precision as
 * a double are exactly the ones nobody would notice going wrong.
 */
function historyIdIsAfter(a, b) {
  const left = String(a).replace(/^0+(?=\d)/, "");
  const right = String(b).replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length > right.length;
  return left > right;
}

/**
 * Every message id added since `startHistoryId`, and where to resume.
 *
 * **`history.list` returns the MAILBOX'S CURRENT `historyId` on every page**,
 * not a per-page cursor. A walk that stops at `maxPages` and reports that
 * value tells its caller "you are caught up" while holding only the first N
 * pages — and everything after them is then skipped forever, silently, with no
 * gap signalled. That is the one failure mode in this whole path that loses
 * somebody's mail without saying so, and a mailbox whose cursor is weeks old
 * is precisely where it fires.
 *
 * So a truncated walk says `truncated: true` and carries `lastRecordId`: the
 * id of the last history *record* it actually walked, which is a valid
 * `startHistoryId` for the next call and covers exactly the records collected
 * here. Resuming from it is what makes a truncated pass make progress rather
 * than repeat itself. `historyId` still reports the mailbox head, because a
 * caller that reached the end wants it — but a caller must consult
 * `truncated` before believing it.
 */
export async function listAllHistory({ fetchImpl, accessToken, startHistoryId, maxPages = 50 }) {
  const messageIds = new Set();
  let pageToken;
  let historyId = startHistoryId;
  let lastRecordId;
  let truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await listHistoryPage({ fetchImpl, accessToken, startHistoryId, pageToken });
    for (const id of result.messageIds) messageIds.add(id);
    if (result.historyId) historyId = result.historyId;
    if (
      result.lastRecordId !== undefined &&
      (lastRecordId === undefined || historyIdIsAfter(result.lastRecordId, lastRecordId))
    ) {
      lastRecordId = result.lastRecordId;
    }
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
    if (page + 1 >= maxPages) truncated = true;
  }
  return { messageIds, historyId, truncated, lastRecordId };
}

