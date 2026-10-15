/**
 * Who a line of `activity.md` names: a person's own hand, or an AI client
 * acting for them. Split out of `activity.cjs`, which re-exports all three.
 */

/**
 * The name the app's own console is registered under (`CONSOLE_CLIENT_NAME`
 * in `apps/convex/functions/agentGrant.ts`). The gateway refuses it to anyone
 * else at registration (`FIRST_PARTY_NAMES` in `oauth/registration.js`).
 */
const CONSOLE_CLIENT_NAME = "Context (this app)";

/**
 * The texting assistant's client was "Texts (iMessage)" until it took Tex's
 * name (owner, 2026-10-14; `TEXTS_CLIENT_NAME` in `textLinks.ts`). Lines from
 * before then are read as Tex, so its work is one name in the feed.
 */
const TEXTS_CLIENT_NAME = "Tex";
const LEGACY_TEXTS_CLIENT_NAME = "Texts (iMessage)";

/**
 * The AI client a change came through, or null when it was a person's own hand.
 *
 * The console reads and writes through the gateway with a grant of its own, so
 * a change made in the app arrives naming "Context (this app)" as its client.
 * It is still the person at their keyboard (the owner, 2026-10-12): "@seyi
 * revised README", never "@seyi's Context (this app) revised README". Applied
 * in `activity.cjs` where an entry is built, read back and merged, so lines written
 * before this rule read the same way and merge with the person's own.
 */
function clientOf(via) {
  if (typeof via !== "string" || via === "") return null;
  if (via === CONSOLE_CLIENT_NAME) return null;
  return via === LEGACY_TEXTS_CLIENT_NAME ? TEXTS_CLIENT_NAME : via;
}

/**
 * Who a line is about, in the possessive form the meeting asked for.
 *
 * "@sayo's Claude" rather than a client id, because the distinction that
 * matters to a reader is a person's own hand versus the assistant they pointed
 * at the context — "oh, Shyoh's Claude did this".
 */
function actorLabel(entry) {
  const by = entry.by || null;
  const via = clientOf(entry.via);
  if (by && via) return `${by}'s ${via}`;
  if (by) return by;
  if (via) return via;
  return "Someone";
}

module.exports = { CONSOLE_CLIENT_NAME, actorLabel, clientOf };
