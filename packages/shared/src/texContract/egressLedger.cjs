/**
 * A turn's egress ledger, and which calls could share something (`apps/mcp/src/privacy/egress.js`, which re-exports
 * these and keeps `recordRead`, the one part that judges a note's path).
 *
 * Tex starts a ledger for each turn it sees whole and marks it as it reads; the gateway's dispatcher marks the same
 * ledger as the turn's tool calls read (`tools/session.js`). Pure, so both sides hold one copy.
 */

/** The `share` values on `write_note` that mint a link (`notes/write.js`). */
const SHARE_VALUES = new Set(["members", "anyone", "collect"]);

/** A fresh ledger for one turn the gateway sees whole. */
function newLedger() {
  return { untrusted: false, outside: false, asked: [] };
}

/** Mark the ledger: the turn took in something from outside the workspace. */
function markUntrusted(ledger) {
  if (ledger) ledger.untrusted = ledger.outside = true;
}

/**
 * Mark a group chat's turn: it carries other people's words, so its sends stay held as any untrusted turn's, but the
 * people in the chat are not outside it (the owner, 2026-11-02), so `outside` is left for what came from beyond the
 * chat: a page, an email, a file. Only a chat's own learned skills read it (`agent/chatSkills.js`).
 */
function markChatWords(ledger) {
  if (ledger) ledger.untrusted = true;
}

/**
 * A summary is one plain line. It is built from arguments the model wrote (a
 * path, an address) and read by a person who is about to say yes to it, in
 * the gateway's own voice: a line break, a control character or a bidi
 * override in it would let the model add sentences the person takes to be the
 * gateway's, or reorder the ones that are.
 */
function oneLine(text) {
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
function mightWiden(name, args, { into = null, writes } = {}) {
  const a = args && typeof args === "object" ? args : {};
  if (a.dry_run === true) return false;
  if (name === "create_link") return true;
  if (typeof into === "string" && into !== "") return writes ?? WRITE_TOOLS_THAT_CAN_REACH_ELSEWHERE.has(name);
  switch (name) {
    case "write_note":
      return (
        a.site?.action === "publish" ||
        SHARE_VALUES.has(a.share) ||
        (Array.isArray(a.images) && a.images.some((image) => typeof image?.url === "string" && image.url.trim() !== "")) ||
        a.visibility === "team"
      );
    case "create_form":
      return a.visibility === "team";
    // A bot's logo by address is fetched from outside, as write_note's images by url are.
    case "set_area":
      return [a.bot?.avatar?.url, a.bot?.avatar_dark?.url].some((url) => typeof url === "string" && url.trim() !== "");
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
    case "invite_member":
      return true;
    default:
      return false;
  }
}

module.exports = { newLedger, markUntrusted, markChatWords, oneLine, mightWiden };
