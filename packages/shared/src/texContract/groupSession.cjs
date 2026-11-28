/**
 * What makes a texting turn a group turn, and what a group turn may do with its tagger's own Google account
 * (`groupTurn.js`). Both the gateway's session and its message backup read these, so they name one client id.
 */

/** The group texting client (`apps/convex/functions/textGroups.ts`). */
const TEXTS_GROUP_CLIENT_ID = "context_texts_group";

function isGroupSession(session) {
  return session?.actorClientId === TEXTS_GROUP_CLIENT_ID;
}

/*
  What a group turn may do with its tagger's own Google account (the owner,
  2026-10-21: "calendar is necessary", "email too, write only not read"): send
  one email and change one event, each held for the tagger's yes to its exact
  copy (`tools/heldGates.js`), and nothing that reads their mail. The control
  plane sends from the tagger's account whatever their role in the shared
  workspace (`apps/convex/functions/lib/controlPlane/ownAccount.ts`), so the
  dispatcher's write-scope check doesn't apply to these two.
*/
const GROUP_OWN_ACCOUNT_TOOLS = Object.freeze(["send_email", "calendar_event"]);

function actsOnOwnAccount(session, name) {
  return isGroupSession(session) && GROUP_OWN_ACCOUNT_TOOLS.includes(name);
}

module.exports = { TEXTS_GROUP_CLIENT_ID, isGroupSession, GROUP_OWN_ACCOUNT_TOOLS, actsOnOwnAccount };
