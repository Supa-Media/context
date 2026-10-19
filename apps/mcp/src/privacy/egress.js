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
import { normalizePath } from "../notes/paths.js";

/**
 * Tools whose results are, by construction, words people other than the person
 * wrote: a mailbox day, a contact page built from senders' own claims, a
 * meeting's transcript, a stored file's words (most are attachments).
 */
export const UNTRUSTED_READS = new Set(["read_channel_day", "read_contact", "read_meeting", "search_email", "read_email", "read_file"]);

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
  "list_proposals",
  "list_plugins",
  "suggest_destination",
]);

/**
 * Listings that still carry words a stranger chose, so they are not "names,
 * not content": a meeting's title and attendees come off a calendar invite
 * anyone can send, a contact's name and organisation off the sender's own
 * message, a proposal's reason off whichever agent filed it, and a plugin's
 * name and author off its manifest. A listing
 * that returns one marks the turn untrusted, though it marks nothing read.
 */
export const UNTRUSTED_LISTINGS = new Set(["list_meetings", "list_contacts", "list_proposals", "list_plugins"]);

/** The `share` values on `write_note` that mint a link (`notes/write.js`). */
const SHARE_VALUES = new Set(["members", "anyone", "collect"]);

/** A frontmatter line ingestion writes on content a stranger authored. */
const UNTRUSTED_FRONTMATTER = /^trust:\s*"?untrusted"?\s*$/m;

/** A fresh ledger for one turn the gateway sees whole. */
export function newLedger() {
  return { untrusted: false, asked: [] };
}

/** Mark the ledger: the turn took in something from outside the workspace. */
export function markUntrusted(ledger) {
  if (ledger) ledger.untrusted = true;
}

/** Record whether what a read handed the model came from outside the workspace. */
export function recordRead(ledger, { name, args, result }) {
  if (!ledger || !result || result.isError === true) return;
  if (LISTING_TOOLS.has(name)) {
    if (UNTRUSTED_LISTINGS.has(name)) ledger.untrusted = true;
    return;
  }
  if (UNTRUSTED_READS.has(name) || readsCapturedContent(name, args) || carriesUntrustedFrontmatter(result)) {
    ledger.untrusted = true;
  }
}

/** A note read by path that is a mailbox day, a calendar day, a meeting or a saved chat. */
function readsCapturedContent(name, args) {
  const raw = name === "fetch" ? args?.id : args?.path;
  const path = typeof raw === "string" ? normalizePath(raw) : null;
  return path !== null && path !== undefined && classifyCaptureKind(path) !== null;
}

function carriesUntrustedFrontmatter(result) {
  const text = result?.content?.[0]?.text;
  return typeof text === "string" && UNTRUSTED_FRONTMATTER.test(text.slice(0, 2000));
}

/**
 * A summary is one plain line. It is built from arguments the model wrote (a
 * path, an address) and read by a person who is about to say yes to it, in
 * the gateway's own voice: a line break, a control character or a bidi
 * override in it would let the model add sentences the person takes to be the
 * gateway's, or reorder the ones that are.
 */
export function oneLine(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The write tools to treat as writes when a caller does not say. */
const WRITE_TOOLS_THAT_CAN_REACH_ELSEWHERE = new Set([
  "write_note",
  "create_form",
  "set_visibility",
  "set_folder_visibility",
  "save_context",
  "move_note",
  "move_notes",
  "move_folder",
  "remember",
  "propose_note",
  "submit_form",
  "update_submission",
]);

/**
 * Whether this call could let more people see something, judged from its tool
 * and arguments alone: the manifest is not read, so this is a superset and
 * errs wide. Tex's housekeeping refuses anything it says yes to
 * (`agent/housekeepingGuard.js`), since nobody is watching while it works.
 *
 * Never true for a dry run, which changes nothing.
 *
 * @param {string} name the tool, already resolved from any alias
 * @param {object} args the arguments, `context` already stripped
 * @param {object} options
 * @param {string|null} options.into the other workspace addressed, as `@name`, or null
 * @param {boolean} [options.writes] the tool changes something; addressed into
 *   another workspace it then counts, whatever else it does
 * @returns {boolean}
 */
export function mightWiden(name, args, { into = null, writes } = {}) {
  const a = args && typeof args === "object" ? args : {};
  if (a.dry_run === true) return false;
  if (name === "create_link") return true;
  if (typeof into === "string" && into !== "") return writes ?? WRITE_TOOLS_THAT_CAN_REACH_ELSEWHERE.has(name);
  switch (name) {
    case "write_note":
      return (
        a.site?.action === "publish" ||
        SHARE_VALUES.has(a.share) ||
        (Array.isArray(a.images) && a.images.some((image) => typeof image?.url === "string")) ||
        a.visibility === "team"
      );
    case "create_form":
      return a.visibility === "team";
    case "vault_list":
      return Boolean(a.fetch && typeof a.fetch === "object");
    case "set_visibility":
      return a.visibility === "team" || (a.people !== undefined && a.people !== null);
    case "set_folder_visibility":
      return a.visibility === "team" || a.visibility === "inherit";
    case "save_context":
      return a.visibility === "team" || a.visibility === "public";
    case "move_note":
    case "move_notes":
    case "move_folder":
      return a.confirm_team_publish === true;
    case "create_workspace":
      return true;
    default:
      return false;
  }
}
