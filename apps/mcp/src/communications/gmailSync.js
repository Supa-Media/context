// Gmail sync: turning a connected mailbox's messages into channel-day notes.
//
// ## Why this syncs one CALENDAR DAY at a time, rather than one PAGE
//
// A channel-day note is a full regeneration of everything that happened on
// one day (`docs/decisions/communications.md`), and `planChannelDay` is a
// pure function of the day's *complete* ordered event list. Gmail's
// `messages.list` pages are not day-aligned — a page boundary can land in the
// middle of a day — so grouping by page and writing whatever a page happens
// to contain would sometimes write a day from a partial set: correct today,
// wrong the moment that day's messages are spread across two pages.
//
// So the unit of work here is **one day**: list every message Gmail has for
// that day (scoped to the connection's folders), fetch each in full, render,
// write. That is what makes re-running a day idempotent — the day is always
// regenerated from the same live query, so the same underlying mailbox state
// produces byte-identical notes — and what makes "regenerate only the
// affected days" a precise instruction rather than an approximation: backfill
// touches every day in its window, and an incremental pass touches exactly
// the days a changed message landed on.
//
// ## What this does NOT do
//
// It does not delete a note for a message Gmail later deletes: v1 is a
// read-only mirror of what arrived, "a record of what was received, not a
// statement by the owner" (`packages/communications/src/note.js`), and a
// message once captured stays captured even if the sender or the owner later
// deletes it at Gmail. Reconciling deletions is future work, named here so it
// is a decision rather than an oversight.
//
// Everything below either does one `fetch` against Gmail's documented REST
// API or one call against a `ContextStore` (see `src/store/index.js`). Both
// are injected, which is what makes this file testable against a fixture
// Gmail server and an in-memory store rather than the real internet.
//
// Split by responsibility into `gmail/`: `parsing.js` (MIME parsing, pure),
// `attachments.js` (fetch/retain/sweep, plus the manifest), `api.js` (the
// Gmail REST client and search query), `render.js` (rendering a day and
// writing it through the storage adapter, including `syncOneDay`), and
// `sync.js` (backfill and incremental orchestration). This file re-exports
// the same names it always has.

export { GMAIL_API_ORIGIN, FOLDER_LABEL_IDS } from "./gmail/api.js";
export {
  decodeBase64UrlToBytes,
  decodeBase64UrlToUtf8,
  headerValue,
  parseAddressList,
  extractBody,
  gmailMessageToEvent,
  dateKeyOf,
} from "./gmail/parsing.js";
export {
  GMAIL_ATTACHMENT_MAX_BYTES,
  sanitizeAttachmentFilename,
  sha256Hex,
  attachmentPath,
  attachmentDateOf,
  getAttachmentBytes,
  manifestPath,
  readManifest,
  writeManifest,
  resolveDayAttachments,
  sweepExpiredAttachments,
} from "./gmail/attachments.js";
export {
  buildDayQuery,
  GmailApiError,
  GmailHistoryExpiredError,
  listMessageIds,
  listAllMessageIds,
  getMessage,
  getMessageOrNull,
  getProfileHistoryId,
  listHistoryPage,
  listAllHistory,
} from "./gmail/api.js";
export { renderDay, writeDayPart, writeContactDraft, syncOneDay } from "./gmail/render.js";
export { dateRange, syncDayFromGmail, runBackfill, runIncrementalSync } from "./gmail/sync.js";
