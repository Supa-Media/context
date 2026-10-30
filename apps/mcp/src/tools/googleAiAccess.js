/**
 * What to tell the person when AI may not use one of their Google accounts
 * until they allow AI access (`aiAccessNeeded` in the control plane's
 * `lib/googleConnect/aiScopes.ts`). Only the agent consent mends it: a
 * reconnect gives the standard client a new grant AI never reads, so sending
 * them to reconnect would go round in a loop.
 */
export const AI_ACCESS_STEP =
  "Reconnecting won't fix this. Get the link from manage connect_google with kind ai and send it in one line: they tap " +
  "Allow AI access beside that Google account and allow it on Google's page. Never tell them to reconnect for this.";

/** One line naming the accounts that wait for Allow AI access, or none. */
export function aiAccessLine(addresses, what) {
  const named = Array.isArray(addresses) ? addresses.filter((address) => typeof address === "string" && address !== "") : [];
  if (named.length === 0) return null;
  return `AI access isn't allowed yet for ${named.join(", ")}, so its ${what} wasn't read. ${AI_ACCESS_STEP}`;
}
