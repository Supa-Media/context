/**
 * The email id and refusal contract (`apps/mcp/src/tools/emailRead.js`): an `email:<address>/<id>` id as a search gives it,
 * its parser, and the refusal text the email reader and Tex's readers share. Pure: no store, no network.
 *
 * Plain CommonJS. `REFUSED` reads `AI_ACCESS_STEP` from `googleAiAccess.cjs`, the sentence the Google readers share.
 */

const { AI_ACCESS_STEP } = require("./googleAiAccess.cjs");

const EMAIL_ID_PREFIX = "email:";

const ACCOUNT = /^[^\s@/]{1,64}@[^\s@/]{1,190}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const REFUSED = {
  invalid: "That is not a search or an email this can read.",
  not_allowed: "This connection cannot read the person's email: only their own personal workspace's mail, with private access.",
  no_mailbox: "The person has no Gmail connected. They can connect one with manage connect_google.",
  rate_limited: "Too many email reads this hour. Try again later, or look in their synced mail notes by date.",
  reconnect_required: "Their Gmail sign-in stopped working, so it cannot be read and its mail has stopped syncing. They need to reconnect it with manage connect_google.",
  ai_access_needed: `AI access isn't allowed yet for their Gmail, so it can't be read. ${AI_ACCESS_STEP}`,
  not_found: "Gmail no longer has that email, or that attachment.",
  too_large: "That attachment is over the 10 MB a file is read at.",
  unavailable: "Gmail did not answer just now.",
};

/** `email:<address>/<id>`, or null. */
function parseEmailId(id) {
  if (typeof id !== "string" || !id.startsWith(EMAIL_ID_PREFIX)) return null;
  const rest = id.slice(EMAIL_ID_PREFIX.length);
  const slash = rest.lastIndexOf("/");
  if (slash === -1) return null;
  const address = rest.slice(0, slash).toLowerCase();
  const messageId = rest.slice(slash + 1);
  return ACCOUNT.test(address) && MESSAGE_ID.test(messageId) ? { address, messageId } : null;
}

module.exports = { ACCOUNT, EMAIL_ID_PREFIX, parseEmailId, REFUSED };
