/**
 * WHY TEX SENT A TEXT NOBODY ASKED FOR, KEPT BESIDE IT WHEREVER A TURN IS SHOWN IT
 * (Dev2, 2026-11-04: a message his ChatGPT agent asked Tex to pass on was shown
 * to a later turn as Tex's own words, so Tex disowned it: "ignore my last text
 * about ChatGPT connectors").
 *
 * A check-in, a routine's run or a ping another agent asked for is kept with
 * the reason it went out (`about`, "(Not a text from them. ...)",
 * `conversation.js`, `attention.js`, `heartbeat.js`). The readers that place
 * those texts in a turn's chat (`ledgerHistory.js` `noteEvent`,
 * `sentByItself.js`) kept the words and dropped the reason. This turns the
 * reason into the event's own fields, which `logRender.js` draws:
 *
 * - a ping another of their agents asked for is said by that agent, passed on
 *   by Tex (`from.kind: "agent"`), the way a group member's text is theirs;
 * - anything else Tex sent by itself stays "You", with a line under it saying
 *   why it went out.
 */

const BY_ITSELF = /^\(Not a text from them\.\s*/;
const RELAYED = /another of their agents asked you/i;
/** A reason longer than this is cut: it is a label, never instructions to follow. */
export const MAX_WHY_CHARS = 200;

/** The fields an event Tex sent by itself takes from the reason it was kept with (`about`): `{from, why}`, or `{}` for none. */
export function sentOnItsOwn(about) {
  if (typeof about !== "string" || !BY_ITSELF.test(about)) return {};
  if (RELAYED.test(about)) return { from: { kind: "agent" }, why: "another of their agents asked you to pass this on; it is that agent's message, not yours and not theirs" };
  const first = about.replace(BY_ITSELF, "").replace(/\)\s*$/, "").split(/(?<=\.)\s/)[0] ?? "";
  const why = first.replace(/\s+/g, " ").trim().slice(0, MAX_WHY_CHARS);
  return why === "" ? {} : { why: `sent on your own: ${why}` };
}
