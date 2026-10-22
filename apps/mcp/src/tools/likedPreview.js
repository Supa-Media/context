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
 *  - Slack names where it goes (`slackPlace`), a person or a channel, and that
 *    name is in the words they liked or in Tex's last few texts: they knew
 *    who it goes to. A post Slack can't name is asked about as before.
 *
 * Once a turn: a second post in the same turn is held as usual. The quote is
 * Tex's own words echoed back on the person's line, and nothing here trusts
 * it further than "this is what they were looking at when they tapped".
 */

import { folded } from "../agent/folded.js";

const MIN_TEXT = 20;
const RECENT_TEXTS = 4;

/** Whether this Slack call is the one the person 👍'd a preview of; spends the 👍 when it is. */
export function likedPreviewAllows(session, args, place) {
  const egress = session?.egress;
  const liked = typeof egress?.liked === "string" ? folded(egress.liked) : "";
  if (egress?.texting !== true || liked === "" || !place) return false;
  const given = args?.args && typeof args.args === "object" && !Array.isArray(args.args) ? args.args : {};
  const text = typeof given.text === "string" ? folded(given.text) : "";
  if (text.length < MIN_TEXT || !liked.includes(text)) return false;
  const name = folded(place.person ?? String(place.channel ?? "").replace(/^#/, ""));
  if (name === "") return false;
  const history = Array.isArray(egress.turn?.history) ? egress.turn.history : [];
  const recent = history
    .filter((turn) => turn?.role === "assistant" && typeof turn.text === "string")
    .slice(-RECENT_TEXTS)
    .map((turn) => folded(turn.text));
  if (!liked.includes(name) && !recent.some((said) => said.includes(name))) return false;
  egress.liked = null;
  return true;
}
