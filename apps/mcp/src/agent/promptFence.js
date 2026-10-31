/**
 * The fence a group turn's prompt quotes one of the chat's own notes in.
 *
 * A note Tex keeps for a chat — how the chat talks (`chatVoice.js`), what it
 * is about (`chatHome.js`) — is shown to the model between a `<<<WORD` line
 * and a `WORD` line. The words inside are the chat's: Tex writes them from
 * what people say, and anyone in the chat may edit the note by hand. So a line
 * that is the closing marker would end the quote early and put everything
 * after it into the gateway's own words — on this turn and on every later one,
 * since these notes are read into every turn. Such a line is never what the
 * note is for, so it is dropped before the note is quoted.
 *
 * Dropped as a reader sees it, not as the bytes are: a zero-width space shows
 * as nothing, so `WORD\u200b` reads as the marker to a model while matching
 * nothing. The sharing judge strips its fence out of a note's title the same
 * way (`privacy/judgeSubject.js`).
 *
 * A prompt that quotes in tags rather than in lines — the advisor's whole-turn
 * brief (`advisor.js`), whose transcript holds whatever the turn read — uses
 * `withoutTag` for the same reason: a closing tag inside the quoted words
 * would end it early.
 */

/** Characters that show as nothing, so "VOICE\u200b" reads as the marker but would not match it. */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Whether this line, as a reader sees it, is `word`'s fence, opening or closing. */
export function isFenceLine(word, line) {
  const seen = String(line ?? "").replace(INVISIBLE, "").trim().toLowerCase();
  const name = String(word).toLowerCase();
  return seen === name || seen === `<<<${name}` || seen === `${name}>>>`;
}

/** `text` with every line that is `word`'s fence dropped. */
export function withoutFence(word, text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => !isFenceLine(word, line))
    .join("\n");
}

/**
 * `text` with `name`'s own tags neutralized, opening and closing, so quoted
 * content cannot close the tag it is quoted in. The words are kept and shown,
 * in brackets rather than angle brackets, because they are what was read; only
 * their power to end the quote goes. `name` is one of the prompt's own tag
 * names, so it is taken as written after the characters a tag name may hold.
 */
export function withoutTag(name, text) {
  const word = String(name).replace(/[^A-Za-z0-9_-]/g, "");
  const body = String(text ?? "");
  if (word === "") return body;
  return body.replace(new RegExp(`<\\s*(/?)\\s*${word}\\s*>`, "gi"), (_whole, slash) => `(${slash}${word})`);
}
