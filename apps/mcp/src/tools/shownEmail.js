/**
 * "SEND" TO AN EMAIL TEX SHOWED IS THE YES TO THAT COPY (Training, trial-hire 123, 2026-11-19).
 *
 * Tex showed John the whole email in its text and asked "Send?"; John said "send". Two things went wrong, both here:
 *
 *  - "Send?" was not read as an offer (`claimCheck.js` `offersAHeldChange` knows "Want me to send it?", "Say yes and
 *    I'll send it", a To:/Subject: preview), so John's "send" agreed to nothing (`session.egress.liked` stayed unset)
 *    and the email could only be held for a second 👍. `lastShownSend` reads such a text as the words they agreed to.
 *  - Tex then wrote the email again in other words before calling send_email, and the Mail checker, reading John's
 *    "send" against a copy he had never seen, refused it. Their yes covers the copy they read and nothing else, so a
 *    rewrite is sent back to Tex once with the copy they saw (`shownCopyOf`), to call again with exactly that.
 *
 * And the recipient: Tex named it in an earlier text of the same ask ("Send to bram.visser@example.com on his
 * thread?"), and later showed only the reworded body. `recipientsShown` finds every recipient in Tex's own recent
 * texts; the email then goes at once only when the Mail checker, reading the same texts, says they asked for it, and
 * the body is in the words they agreed to word for word (`likedPreview.js` `agreedToShownEmail`).
 */

import { folded } from "../../../../packages/tex/gateway/agent/folded.js";

/** A text that ends by asking whether to send: "Send?", "Send it? 👍 or 👎?", "Send to bram@x.com on his thread?". */
const SEND_ASK = /(?:^|\n)\s*(?:(?:ok(?:ay)?\s+to|should\s+I|shall\s+I)\s+)?send(?:\s+(?:it|this|that|the email|the reply))?(?:\s+(?:to|on|as)\b[^?\n]{0,160})?\s*\?[\s\u{1F44D}\u{1F44E}or?]*$/iu;

/** Whether Tex's text ends by asking whether to send what it showed. */
export function asksToSend(text) {
  return SEND_ASK.test(String(text ?? "").trimEnd());
}

/** Tex's last text when it ends by asking "Send?" (`asksToSend`); null otherwise. */
export function lastShownSend(history) {
  const said = (Array.isArray(history) ? history : []).filter((turn) => turn?.role === "assistant" && typeof turn.text === "string").at(-1)?.text;
  return typeof said === "string" && asksToSend(said) ? said : null;
}

const wordsOf = (text) => folded(String(text ?? "")).split(" ").filter(Boolean);

/** The share of either text's distinct words the other has too, the smaller of the two. */
function overlap(a, b) {
  const [x, y] = [new Set(wordsOf(a)), new Set(wordsOf(b))];
  if (x.size === 0 || y.size === 0) return 0;
  const both = [...x].filter((word) => y.has(word)).length;
  return Math.min(both / x.size, both / y.size);
}

/** At least this much of a shown copy must be the email's own words for it to be the same email. */
const SAME_EMAIL = 0.6;
/** A copy shorter than this is not an email anybody approved by reading it. */
const MIN_COPY = 40;

/**
 * The copy of this email they were shown, when it differs from `body`: the lines of `liked` from the one that opens
 * as the body opens (its first three words) to the one that ends as it ends (its last two), when those lines share
 * most of their words with the body. Null when they saw this body word for word, or nothing like it.
 */
export function shownCopyOf(liked, body) {
  if (typeof liked !== "string" || typeof body !== "string") return null;
  const words = wordsOf(body);
  if (words.length < 5) return null;
  const opens = words.slice(0, 3).join(" ");
  const ends = words.slice(-2).join(" ");
  const lines = liked.split("\n");
  const start = lines.findIndex((line) => wordsOf(line).join(" ").startsWith(opens));
  if (start === -1) return null;
  let end = -1;
  // The first line that ends as it ends: a text showing two emails never runs one into the next.
  for (let i = start; i < lines.length && end === -1; i += 1) if (` ${wordsOf(lines[i]).join(" ")}`.endsWith(` ${ends}`)) end = i;
  if (end === -1) return null;
  const shown = lines.slice(start, end + 1).join("\n").trim();
  if (shown.length < MIN_COPY || overlap(shown, body) < SAME_EMAIL) return null;
  return wordsOf(shown).join(" ") === words.join(" ") ? null : shown;
}

/** How many of the latest history turns are read for a recipient Tex named: the Mail checker's own window. */
export const SHOWN_TURNS = 12;

/** Whether Tex itself named every recipient in its texts among the latest `SHOWN_TURNS` turns. */
export function recipientsShown(history, recipients) {
  const said = (Array.isArray(history) ? history : [])
    .slice(-SHOWN_TURNS)
    .filter((turn) => turn?.role === "assistant" && typeof turn.text === "string")
    .map((turn) => turn.text.toLowerCase())
    .join("\n");
  const list = Array.isArray(recipients) ? recipients.map((r) => String(r).trim().toLowerCase()).filter(Boolean) : [];
  // Whole addresses only: "ram@example.com" is not named by "bram@example.com".
  const named = (address) => new RegExp(`(?<![a-z0-9._%+-])${address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9._%+-]*[a-z0-9])`).test(said);
  return list.length > 0 && list.every(named);
}
