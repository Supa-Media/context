/**
 * The texting clients, as the control plane names them, and how long a texting token lives.
 *
 * The gateway's routing and Tex both compare a session's client against these, so they are one copy for both.
 * `machines/reach.js` and `workspaceStore/personTexting.js` re-export them.
 */

/** The texting client, as the control plane names it (`TEXTS_CLIENT_ID`). */
const TEXTS_CLIENT_ID = "context_texts";
/** The group texting client, kept with the group predicates (`groupSession.cjs`). */
const { TEXTS_GROUP_CLIENT_ID } = require("./groupSession.cjs");
/** How long a texting token lives, as the control plane's `TEXTS_GRANT_TTL_MS`. */
const TEXTING_TOKEN_MS = 15 * 60 * 1000;

module.exports = { TEXTS_CLIENT_ID, TEXTS_GROUP_CLIENT_ID, TEXTING_TOKEN_MS };
