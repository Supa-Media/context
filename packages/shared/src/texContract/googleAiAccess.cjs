/**
 * What to tell the person when AI may not use one of their Google accounts
 * until they allow AI access (`aiAccessNeeded` in the control plane's
 * `lib/googleConnect/aiScopes.ts`). Only the agent consent mends it: a
 * reconnect gives the standard client a new grant AI never reads, so sending
 * them to reconnect would go round in a loop.
 */
const AI_ACCESS_STEP =
  "Reconnecting won't fix this. Get the link from manage connect_google with kind ai and send it in one line: they tap " +
  "Allow AI access beside that Google account and allow it on Google's page. Never tell them to reconnect for this.";

module.exports = { AI_ACCESS_STEP };
