/**
 * A 👍 ON TEX'S OWN PREVIEW OF A SLACK MESSAGE IS THE YES TO SENDING IT
 * (Dev2, 2026-10-22: "it was literally supposed to send after the first 👍").
 *
 * Tex texted "Here's the message as it would go: “Hey Segun, …” Say yes and
 * I'll try sending it again." with nothing held. The 👍 on it reached a model
 * that could only raise the hold, so the person was asked again, 👍'd the
 * gateway's ask, and only a typed "yes" sent it.
 *
 * So when a turn comes from a 👍 or ❤️ in a one-to-one chat on words that were
 * not the armed ask (`route.js`, `session.egress.liked`), a Slack post the
 * turn raises runs at once, without a second ask, if and only if:
 *
 *  - the words they liked hold the message's whole text, as Slack would get
 *    it, at least `MIN_TEXT` letters long: they saw exactly what goes out;
 *  - Slack names where it goes (`slackPlace`), a person or a channel, and one
 *    of the spellings Slack gave for it is in those same words: they agreed
 *    to who it goes to, not only to what it says. A post Slack can't name is
 *    asked about as before.
 *
 * Tex's own last few texts named the place until 2026-10-24: a name it had
 * said for any other reason ("Jo Park emailed you about the invoice") stood
 * in for their agreement to send there, and the model chooses both the name
 * it says and the channel it then posts to. Where it goes is now read from
 * the words they agreed to, as it already is for an email and a Chat message
 * (`emailGate.js`, `googleChatGate.js`), and Tex names the place in the text
 * it asks about.
 *
 * Once a turn: a second post in the same turn is held as usual. The quote is
 * Tex's own words echoed back on the person's line, and nothing here trusts
 * it further than "this is what they were looking at when they tapped".
 */

import { folded } from "../agent/folded.js";
import { offersAHeldChange } from "../agent/claimCheck.js";

const MIN_TEXT = 20;

/** A name this short picks nobody out ("jo" in "Hey Jo"), so it is never the yes to a place. */
const MIN_NAME = 3;

/** Every spelling Slack itself gave for where this goes (`slackPlace`); the model adds none. */
function placeNames(place) {
  const given = Array.isArray(place?.names) ? place.names : [];
  const named = [...given, place?.person, place?.channel]
    .filter((name) => typeof name === "string")
    .filter((name) => folded(name).length >= MIN_NAME);
  return [...new Set(named)];
}

/** Whether this Slack call is the one the person 👍'd a preview of; spends the 👍 when it is. */
export function likedPreviewAllows(session, args, place) {
  const given = args?.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {};
  const text = typeof given.text === "string" ? given.text : "";
  if (folded(text).length < MIN_TEXT || !place) return false;
  const names = placeNames(place);
  if (names.length === 0) return false;
  return agreedWordsHold(session, [names, text]);
}

/*
  THE SAME FOR AN EMAIL, AND FOR A TYPED YES (Dev2, 2026-10-22, "FIX
  THISSSSSS"). Tex offered a change in its own words with nothing held ("Say
  yes and I'll add it"); their "yes" reached a model that only then raised the
  hold, and they were asked again for a 👍. The claim check now turns such an
  offer into a real hold before it goes (`agent/claimCheck.js`), and their own
  calendar takes no yes at all (`calendarGate.js`); this is for an email whose
  offer the check does not catch.

  `session.egress.liked` holds the words they agreed to: those they 👍'd, or,
  for a typed yes with nothing armed, Tex's own last text when it offered a
  held change (`agent/route.js`). The email goes at once, without a second
  ask, only when every recipient and its whole body are in those words, word
  for word. Every other check of the gate (limits, the Mail checker) still
  runs first. Once a turn, as above.
*/
/** Folded, with digits apart from letters: "3-5pm" reads as "3 5 pm". */
const words = (value) => folded(value).replace(/(\p{N})(?=\p{L})|(\p{L})(?=\p{N})/gu, "$1$2 ");

/** At least one part this long, so a few digits alone never match. */
const MIN_PART = 3;

/** Whether the words they agreed to hold every one of `parts` (a part may be a list of ways to say it); spends the agreement when they do. */
export function agreedWordsHold(session, parts) {
  const egress = session?.egress;
  const agreed = typeof egress?.liked === "string" ? words(egress.liked) : "";
  if (egress?.texting !== true || agreed === "" || !Array.isArray(parts) || parts.length === 0) return false;
  const needed = parts.map((part) => [part].flat().map(words).filter(Boolean));
  const padded = ` ${agreed} `;
  const said = needed.map((ways) => ways.find((way) => padded.includes(` ${way} `)));
  if (said.some((way) => way === undefined) || !said.some((way) => way.length >= MIN_PART)) return false;
  egress.liked = null;
  return true;
}

/*
  A FORWARD THEY SAID YES TO (the owner, 2026-10-23: "tex asked for like 4
  confirmations again"). Tex texted "Do you want me to send it to
  supa.media.llc@…?" about a receipt, and later "Say yes and I'll forward it
  to …", with nothing held; each 👍 reached a model that only raised the next
  ask. An offer to forward can't hold the forwarded email word for word, so
  `agreedWordsHold` never matched one. Their yes or 👍 on Tex's text releases
  a forward when that text offered to send or forward (`offersAHeldChange`)
  and names every recipient, and the Mail checker, reading their 👍 or yes on
  it, said they asked for this email (`emailGate.js`). Once a turn, as above.
*/
/** Whether the words they agreed to offered this forward to every one of `recipients`; spends the agreement when they did. */
export function agreedToForward(session, recipients) {
  const liked = session?.egress?.liked;
  if (typeof liked !== "string" || !offersAHeldChange(liked) || !Array.isArray(recipients) || recipients.length === 0) return false;
  return agreedWordsHold(session, recipients);
}
