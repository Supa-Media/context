/**
 * A DRAFT THAT OPENS WITH A LABEL THE PERSON WOULD SEE (2026-11-27).
 *
 * A real 1:1 check-in went out as "[check-in] Two things to check. X sent a new-login alert…". No code wrote the tag:
 * the look's model did, after reading bracketed tags at the start of line after line of what it was shown (the research
 * brief's "- [today] …", the recent texts' "[1] You (a check-in) …") and a marker it was told is never shown
 * ("[continues N]"). The prompt no longer teaches any of those (`checkinResearch.js`, `checkInTexts.js`), and this is the
 * net under it: a draft with a line that opens with a bracketed tag no step of Tex reads goes back once, as a fact.
 *
 * What a step does read is left alone: `[picture …]` and `[card …]` (`outgoingPictures.js`), a group answer's `[2] `
 * (`replyUnder.js`) and an old `[continues N]` (`checkInTexts.js`). So are a Markdown link (`[label](…)`), a wiki link
 * (`[[…]]`) and a checkbox (`[ ]`, `[x]`). Only the start of a line counts: a bracket inside a sentence is the person's
 * own kind of writing ("[sic]", a quoted "[last day]"). A guest's ledger key (`guest-1a2b`) anywhere goes back too.
 */

/** A bracketed tag opening a line, not a Markdown link, not a wiki link: the tag and what follows it on the line. */
const OPENING_TAG = /^[ \t]*(\[(?!\[)([^\[\]\n]{1,40})\])(?!\()/;
/** The tags a step of Tex reads and takes out before anything is sent. */
const READ_BY_TEX = /^\s*(?:picture\b.*|card\b.*|continues\s+\d{1,3}|\d{1,2}|x|X|\s*)\s*$/;

/** The first label a line of the draft opens with, as written (`"[check-in]"`), or null. */
export function openingLabel(draft) {
  for (const line of String(draft ?? "").split("\n")) {
    const match = OPENING_TAG.exec(line);
    if (match !== null && !READ_BY_TEX.test(match[2])) return match[1];
  }
  return null;
}

/**
 * A guest's key in the chat's ledger (`groupNames.js`, `guest-1a2b`): an internal key, never how anyone is named to a
 * person (Dev2, 2026-11-27: "say their phone number, never a guest-xxxx id"). Sent texts named people this way in five
 * chats between 2026-11-14 and 2026-11-27, the last after that rule.
 */
const GUEST_KEY = /\bguest-[0-9a-f]{4}\b/gi;

/** The guest keys a draft names, each once, as written. */
export function guestKeys(draft) {
  return [...new Set(String(draft ?? "").match(GUEST_KEY) ?? [])];
}

/**
 * The send-back for a draft that would show them an internal label, as data
 * (`docs/decisions/texting-assistant/no-scripted-wording.md`): the label a line opens with, the guest keys it names, and
 * that it would reach them as written. Null for any other draft.
 */
export function labelNotice(draft) {
  const label = openingLabel(draft);
  const keys = guestKeys(draft);
  if (label === null && keys.length === 0) return null;
  return JSON.stringify({
    ...(label !== null ? { line_opens_with: label } : {}),
    ...(keys.length > 0 ? { internal_guest_keys: keys } : {}),
    sent_as_written: true,
    read_by_tex: false,
  });
}

/** A turn's code checks when it has none of its own: nothing sends a draft back, so only the Claim checks' label check runs. */
export const NO_CHECKS = Object.freeze({ code: async () => ({ notice: null, review: false }), review: null });
