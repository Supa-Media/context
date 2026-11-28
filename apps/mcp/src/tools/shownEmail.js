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
 * Tex's own texts lately held the body word for word (`emailShown`, below; 2026-11-26).
 */

import { folded } from "../../../../packages/shared/src/folded.cjs";

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

/*
  THE BODY TEX SHOWED, WHATEVER IT ASKED AROUND IT (Sayo's group email to SupaSounds, 2026-11-26). Tex showed the draft
  and asked which Gmail to send it from; "send it from my supa email. draft is good. go ahead" agreed to nothing,
  because only a text worded as an offer ("Send?", "Want me to send it?") counted as the words they agreed to, so the
  gateway held the email and asked again. Whether they asked for it is the Mail checker's to say, reading their own
  words; what was shown is a fact read here: the whole body, word for word, in one of Tex's own texts lately.
*/
/*
  IN A GROUP, ONLY WHAT TEX SHOWED THE TAGGER (2026-11-27). The tagger's own account sends, so a copy Tex showed
  in answer to somebody else, or put to another member by name (an offer to @cy), was never shown to them to send: a
  text counts only when it answered the tagger's own turn (its question's last line is theirs, `groupTurn.js`
  `groupQuestionLine`, `groupLedgerHistory.js`) and names no other member unless it names the tagger too.
*/
/*
  WHOSE TURN IT WAS IS NOT THEIRS TO WRITE (2026-11-27). A kept group question is the chatter block, a blank line, then
  the text that tagged Tex, each text prefixed `@who: ` (`groupLedgerHistory.js` `groupQuestion`). Reading the
  question's last line made that prefix something a member could write: a text of @kim's ending in a line of its own,
  `@sayo: send it`, read as @sayo's turn, so a draft Tex showed @kim counted as shown to @sayo. The prefix is the
  first line of the last block instead, which nothing inside a text can reach. A tagging text with a blank line of its
  own reads as nobody's and is asked about, the answer this was before a shown copy counted at all.
*/
function askedBy(question, from) {
  const text = String(question ?? "").trimEnd();
  const at = text.lastIndexOf("\n\n");
  const first = (at === -1 ? text : text.slice(at + 2)).split("\n")[0] ?? "";
  return first.startsWith(`@${from}:`) || first.startsWith(`@${from} (`);
}

/** Whether a text names this handle whole: "@jo" is not named by "@joan". */
const namesHandle = (text, who) => new RegExp(`(?:^|[^a-z0-9-])@${who.replace(/[^a-z0-9-]/gi, "")}(?![a-z0-9-])`, "i").test(text);

/** Tex's texts among the latest `SHOWN_TURNS` turns that showed the person this email; in a group, only those shown to the tagger. */
function texTexts(history, group) {
  const turns = (Array.isArray(history) ? history : []).slice(-SHOWN_TURNS);
  return turns
    .map((turn, at) => ({ turn, asked: turns.slice(0, at).findLast((before) => before?.role === "user") }))
    .filter(({ turn }) => turn?.role === "assistant" && typeof turn.text === "string")
    .filter(({ turn, asked }) => {
      if (!group?.from) return true;
      if (!askedBy(asked?.text, group.from)) return false;
      const others = (Array.isArray(group.people) ? group.people : []).filter((who) => typeof who === "string" && who !== group.from);
      return namesHandle(turn.text, group.from) || !others.some((who) => namesHandle(turn.text, who));
    })
    .map(({ turn }) => turn.text);
}

/** A text's words with a space each side, so a run of words is found whole. */
const runOf = (text) => ` ${wordsOf(text).join(" ")} `;

/** The opening and closing words that name which email a later copy of it is, as `shownCopyOf` anchors on. */
const OPENS_WORDS = 3;
const ENDS_WORDS = 2;

/*
  A LATER COPY REPLACES THE ONE IT CHANGED (2026-11-27). Tex showed a draft, they asked for its last sentence out, Tex
  showed the shorter copy, and they said "yes send it": their go-ahead is about the copy they were shown last, and the
  one they had just turned down is not theirs to send. The Mail checker reads a cut sentence as no contradiction, so
  nothing else holds it. A body is therefore shown only until Tex shows the same email in other words: a text that
  opens as the body opens and does not hold it whole.
*/
function replacedIn(texts, body, words) {
  const said = wordsOf(body);
  const anchors = [said.slice(0, OPENS_WORDS).join(" "), said.slice(-ENDS_WORDS).join(" ")].filter((anchor) => anchor !== "");
  if (anchors.length === 0) return false;
  // Either anchor: a copy may change the opening ("Dear Bram", not "Hi Bram") as readily as the words between.
  return texts.some((text) => !runOf(text).includes(` ${words} `) && anchors.some((anchor) => runOf(text).includes(` ${anchor} `)));
}

/**
 * Whether one of Tex's texts among the latest `SHOWN_TURNS` turns holds this body whole, word for word, with no later
 * text of its own showing the same email in other words (`replacedIn`).
 */
export function bodyShown(history, body, group = null) {
  if (typeof body !== "string" || body.trim().length < MIN_COPY) return false;
  const words = wordsOf(body).join(" ");
  if (words === "") return false;
  const texts = texTexts(history, group);
  const last = texts.findLastIndex((text) => runOf(text).includes(` ${words} `));
  if (last === -1) return false;
  return !replacedIn(texts.slice(last + 1), body, words);
}

/**
 * Whether Tex itself showed this email lately: every recipient named and the whole body, in its own texts; in a group
 * (`group`: `{ from, people }`), in texts that answered the tagger and were not put to somebody else.
 */
export function emailShown(history, recipients, body, group = null) {
  const shown = group?.from ? texTexts(history, group).map((text) => ({ role: "assistant", text })) : history;
  return recipientsShown(shown, recipients) && bodyShown(history, body, group);
}
