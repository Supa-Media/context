/**
 * WHAT A TURN TOOK IN FROM OUTSIDE, and which calls could share something.
 *
 * The egress gate that held every widening for a person's yes — a link, a
 * publish, a visibility change, a write into another workspace — was removed
 * by the owner on 2026-10-17 ("everything needed approval";
 * docs/decisions/privacy-and-sharing/agent-egress.md). What is left here:
 *
 *  - The turn ledger. A turn the gateway sees whole (a texted question, a
 *    routine) records whether anything came from outside the workspace: a
 *    mailbox day, a contact page, a meeting, a web page, an attachment. Tex
 *    vouches for a delegated message only from a clean turn
 *    (`agent/delegate.js`), the texting thread remembers which answers were
 *    written after an outside read, and `ledger.asked` carries the asks this
 *    turn raised (an email, a calendar change, a texted bug report, a handle
 *    claim) so the reply can text them.
 *  - `mightWiden`, which Tex's housekeeping uses to refuse anything that could
 *    let more people see something.
 *  - `oneLine`, which keeps an ask's summary to one plain line.
 */

import { classifyCaptureKind } from "../communications/paths.js";
import { isChatHistoryPath, normalizePath } from "../notes/paths.js";
import { splitMessageAnchor } from "../search/commsIndex.js";
import { isSheetPath } from "../../../../packages/shared/src/fileKinds.cjs";

// The ledger itself, `mightWiden` and `oneLine` are pure and shared with Tex, which keeps its own ledger.
export { newLedger, markUntrusted, markChatWords, oneLine, mightWiden } from "../../../../packages/shared/src/texContract/egressLedger.cjs";

/**
 * Tools whose results are, by construction, words people other than the person
 * wrote: a mailbox day, a contact page built from senders' own claims, a
 * meeting's transcript, a stored file's words (most are attachments), a
 * stored picture, which a model now sees and may read words in (a texted
 * screenshot, an email's image) the way a texted one taints its own turn, and
 * a connected app's answer — a Slack channel's messages, a profile's name, a
 * search's hits are written by whoever is in that Slack
 * (`tools/connectors.js`), and an app connected by its MCP server answers with
 * its own users' issues, pages and comments (`tools/apps.js`). `connect_app`
 * is not one: it answers with a link the gateway made, and nothing from the
 * provider.
 *
 * Some of these are not read-only (`slack_api` can post, `app_change` makes a
 * change) and still hand the model an answer, so they mark the turn even when
 * the call counts as a write; see `recordRead`.
 */
export const UNTRUSTED_READS = new Set([
  "read_channel_day",
  "read_contact",
  "read_meeting",
  "read_calendar",
  "search_email",
  "read_email",
  // Their texts: every word in one is somebody else's (`tools/texts.js`).
  "search_texts",
  "list_texts",
  "read_texts",
  "read_file",
  "read_sheet",
  "read_image",
  "slack_api",
  "google_chat",
  // A Chat conversation: every word in it is somebody else's.
  "read_google_chat",
  "app_read",
  "app_change",
]);

/**
 * Tools whose results carry names, counts and settings, never a note's words.
 * Everything else that reads is content, and marks the turn.
 */
export const LISTING_TOOLS = new Set([
  "scope_info",
  "list_notes",
  "list_meetings",
  "list_channel_days",
  "list_contacts",
  "list_links",
  "list_plugins",
  "suggest_destination",
]);

/**
 * Listings that still carry words a stranger chose, so they are not "names,
 * not content": a meeting's title and attendees come off a calendar invite
 * anyone can send, a contact's name and organisation off the sender's own
 * message, and a plugin's
 * name and author off its manifest. A listing
 * that returns one marks the turn untrusted, though it marks nothing read.
 */
export const UNTRUSTED_LISTINGS = new Set(["list_meetings", "list_contacts", "list_plugins"]);

/** A frontmatter line ingestion writes on content a stranger authored. */
const UNTRUSTED_FRONTMATTER = /^trust:\s*"?untrusted"?\s*$/m;

/**
 * Record whether what a call handed the model came from outside the workspace.
 * A write's answer is the gateway's own words, so it marks nothing, unless the
 * tool is one of `UNTRUSTED_READS`: a connected app answers a change with what
 * the app says, written by its users.
 */
export function recordRead(ledger, { name, args, result, writing = false }) {
  if (!ledger || !result || result.isError === true) return;
  if (writing && !UNTRUSTED_READS.has(name)) return;
  if (LISTING_TOOLS.has(name)) {
    if (UNTRUSTED_LISTINGS.has(name)) ledger.untrusted = ledger.outside = true;
    return;
  }
  if (UNTRUSTED_READS.has(name) || readsCapturedContent(name, args) || readsSheetRows(name, args) || carriesUntrustedFrontmatter(result)) {
    ledger.untrusted = ledger.outside = true;
  }
}

/**
 * The key a read will actually open: a trailing, well-formed message anchor is dropped, exactly as `toolReadNote`
 * drops it (`tools/notes/read.js`, `search/commsIndex.js` `splitMessageAnchor`). A search of mail answers
 * `<day>.md#msg-<hex>` and that is the key the next `read_note` arrives with, so judging the key as written left the
 * day of somebody else's email behind it marking nothing. A hash that is not an anchor is an ordinary character in an
 * ordinary name and is kept.
 */
function readPath(raw) {
  return typeof raw === "string" ? splitMessageAnchor(raw).path : raw;
}

/**
 * A sheet's rows read as a note. `read_sheet` is in `UNTRUSTED_READS` because a sheet's rows are filled by a source
 * key held by an outside service (`functions/sheetSources.ts`) or by a public address a source fetches
 * (`data/fetch/url.js`), not typed by a member; `read_note` reads any path, so the same rows have to mark the same
 * turn whichever tool brought them. The taint follows the path, as it does for a chat's history file. The app chat's
 * screen pastes the open file into the turn's note through this same dispatcher
 * (`packages/tex/gateway/agent/screen.js`), and that file may be a sheet.
 */
function readsSheetRows(name, args) {
  // `read_notes` reads many: any one of them that is a sheet marks the turn.
  if (name === "read_notes") return (Array.isArray(args?.paths) ? args.paths : []).some((path) => isSheetPath(readPath(path)));
  if (name !== "read_note" && name !== "fetch") return false;
  // `fetch` routes a sheet to `read_note`, so its id is the path to judge.
  return isSheetPath(readPath(name === "fetch" ? args?.id : args?.path));
}

/** A note read by path that is a mailbox day, a calendar day, a meeting or a saved chat. */
function readsCapturedContent(name, args) {
  // `read_notes` reads many: any one of them that is captured content marks the turn.
  if (name === "read_notes") return (Array.isArray(args?.paths) ? args.paths : []).some((path) => readsCapturedContent("read_note", { path }));
  const raw = readPath(name === "fetch" ? args?.id : args?.path);
  // A chat's history file is judged on the raw id: it may name another context (`@name/tex/...`), which
  // `normalizePath` leaves on, and `fetch` routes the file to `read_note` so the name tells nothing.
  if (isChatHistoryPath(raw)) return true;
  const path = typeof raw === "string" ? normalizePath(raw) : null;
  return path !== null && path !== undefined && classifyCaptureKind(path) !== null;
}

/** Any part of the answer: `read_notes` answers one part per note, and any of them may be a stranger's. */
function carriesUntrustedFrontmatter(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts.some((part) => typeof part?.text === "string" && UNTRUSTED_FRONTMATTER.test(part.text.slice(0, 2000)));
}
