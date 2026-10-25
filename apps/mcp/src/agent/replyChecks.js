/**
 * FOUR THINGS A TEXTED ANSWER MUST NOT BE, CHECKED BEFORE IT GOES (the
 * owner's review of a chat, 2026-10-24).
 *
 * In one afternoon's chat about a spending breakdown, Tex:
 *
 *   1. answered nothing at all four times. The texting Worker sends no text
 *      for an empty answer (`apps/agent/src/reply.ts`), so "What in the
 *      actual heck, are you not working on this?" and "Im not sending this
 *      again" got silence;
 *   2. texted "The bulk of that is医保 and necessities": a word in a script
 *      the person never writes in, which the model later said slipped in;
 *   3. said "Your notes have been down all afternoon" and "your notes aren't
 *      saving right now" in turns where no note read or write had failed, and
 *      blamed that for not opening a file it had never kept;
 *   4. answered "is Kansi on the email thread?", then "you didn't answer",
 *      with "The email is already waiting for your 👍 above": pointing back at
 *      the ask that was waiting instead of answering the text in front of it.
 *
 * Each is something the gateway can see for itself, so each sends the model
 * one more round with a notice (`claimCheck.js` `check`, once per kind), and
 * an answer still empty after it is replaced with a line that says so
 * (`EMPTY_FALLBACK`), never sent as nothing.
 */

export const EMPTY_NOTICE =
  "Before this goes: your answer is empty, and an empty answer sends them nothing at all. " +
  "Reply now, in words, to their newest text: answer it if it's a question, and if you're still working on something, say in a line what's done and what's next.";

/** What is texted when the answer is still empty after the notice. */
export const EMPTY_FALLBACK = "Sorry, my answer to that one got lost. Text me again and I'll pick it up.";

/** Whether an answer has no words to send. */
export function isEmptyAnswer(answer) {
  return String(answer ?? "").trim() === "";
}

/** Scripts an English, French or Spanish texter doesn't write in: Han, kana, Hangul, Cyrillic, Arabic, Hebrew, Thai, Devanagari. */
const OTHER_SCRIPT = /[Ѐ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ㐀-䶿一-鿿가-힯]/u;

/** Whether the answer has words in a script their own text doesn't use. */
export function strayScript(answer, question) {
  return OTHER_SCRIPT.test(String(answer ?? "")) && !OTHER_SCRIPT.test(String(question ?? ""));
}

export const SCRIPT_NOTICE =
  "Before this goes: your answer has a word in another language's script that they didn't write in. " +
  "Send the same answer again with that word replaced by the plain word you meant, in their language, and nothing else changed. " +
  "If they asked for that script (a name, a translation), send it again as it was.";

/** "Your notes have been down all afternoon", "your notes aren't saving right now", "Context is having trouble saving". */
const NOTES_DOWN =
  /\b(?:(?:your|the|my)\s+(?:notes?|workspace)|context)\s+(?:(?:have|has)\s+been\s+|(?:are|is|were|was|keeps?|kept)\s+(?:being\s+)?|went\s+)?(?:down|not\s+(?:saving|working|loading)|having\s+trouble|failing|broken)\b|\b(?:notes?|workspace)\s+(?:aren't|are not|isn't|is not|weren't|wasn't)\s+(?:saving|working|loading)\b/i;
/** The calls that reach their notes; one of these failing in the turn is what "your notes are down" could rest on. */
const NOTE_TOOLS = new Set(["read_note", "write_note", "search_notes", "list_notes", "fetch", "search", "write", "edit_note", "append_note", "move_note", "archive_note"]);

/** Whether the answer says their notes are down when no call to them failed in this turn (`steps`: `{ name, ok }`). */
export function blamesNotes(answer, steps = []) {
  return NOTES_DOWN.test(String(answer ?? "").replace(/[‘’]/g, "'")) && !steps.some((step) => !step.ok && NOTE_TOOLS.has(step.name));
}

export const NOTES_NOTICE =
  "Before this goes: your answer says their notes are down or not saving, but nothing that reads or writes their notes failed in this turn. " +
  "Don't blame their notes for something they didn't do. If you need a note, read or write it now. Then answer with only what really happened: " +
  "say which call failed and what it said, or, if nothing failed, leave that sentence out.";

/** "The Kansi forward is already waiting above", "give it your 👍 there", "it's still waiting for your yes". */
const POINTS_AT_ASK =
  /\b(?:already|still)\s+waiting\b|\bwaiting\s+(?:above|for your (?:\u{1F44D}|yes|ok))|\b(?:give|tap|send)\s+it\s+(?:a|your)\s+\u{1F44D}\s*(?:above|there|up there)\b|\b\u{1F44D}\s+(?:above|there)\b/iu;

/** Whether, with an ask waiting, the answer only points them back at it. */
export function pointsAtWaitingAsk(answer, waiting) {
  return waiting === true && POINTS_AT_ASK.test(String(answer ?? ""));
}

export const ASK_NOTICE =
  "Before this goes: your answer points them back at the ask that's waiting for their 👍, but it is still waiting on its own and needs nothing from this reply. " +
  "Answer what their newest text actually asks or says, starting with the answer itself; if it's a question about something you can look up, look it up first. " +
  "Mention the waiting ask only if this text is about it, and if their answer makes it unnecessary, say so plainly. If your answer already did that, send it again as it was.";

/**
 * They sent a picture and the answer asks them something (a review of a chat,
 * 2026-10-24: a screenshot of the tailor agreeing "Sunday after 3pm", and Tex
 * asked "Is there a time you want me to block?"). A question mark is enough
 * to look again: one round, once.
 */
export function asksPastPicture(answer, pictures) {
  return pictures === true && /\?/.test(String(answer ?? ""));
}

export const PICTURE_NOTICE =
  "Before this goes: they sent a picture with this text, and your answer asks them something. Look at the picture again first: " +
  "a screenshot of a chat, an email, a ticket or a receipt often already answers it (a time agreed, a place, a name, an amount). " +
  "If it does, use what it shows and don't ask. If it doesn't, send your answer again as it was.";

/** "1h 37m", "46m", "$12.50", "30%", "2,017", "7:30": a figure, as a screenshot shows one. */
const FIGURE = /\b\d+\s?(?:h|hr|hrs|hours?|m|min|mins|minutes?)\b|[$£€]\s?\d|\b\d+(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+\b|\b\d+[:.]\d{2}\b|\b\d{2,}\b/i;

/**
 * Figures in an answer about a picture: one sent with this text, or one read
 * back with read_image this turn (a review of a chat, 2026-10-25: asked about
 * a Screen Time screenshot, Tex quoted category totals that weren't in it,
 * then took them back when the next screenshot came).
 */
export function figuresFromPicture(answer, pictures, steps = []) {
  const looked = pictures === true || steps.some((step) => step.ok && step.name === "read_image");
  return looked && FIGURE.test(String(answer ?? ""));
}

export const FIGURES_NOTICE =
  "Before this goes: your answer gives figures about a picture. Check each one against the picture now. Keep only the figures you can read in it, " +
  "say that a sum you worked out is yours (\"those add up to 3h 51m\"), and say plainly what the picture doesn't show instead of filling it in. " +
  "Never give a figure the picture doesn't show. If every figure checks out, send your answer again as it was.";

/**
 * The check for one turn: `{ question, waiting, pictures }` from the turn, `steps` as
 * `claimCheck.js` records them. Answers a notice, each kind once, or null.
 */
export function replyChecks({ question, waiting = false, pictures = false }) {
  const given = new Set();
  const checks = [
    ["empty", (answer) => isEmptyAnswer(answer), EMPTY_NOTICE],
    ["script", (answer) => strayScript(answer, question), SCRIPT_NOTICE],
    ["notes", (answer, steps) => blamesNotes(answer, steps), NOTES_NOTICE],
    ["ask", (answer) => pointsAtWaitingAsk(answer, waiting), ASK_NOTICE],
    ["picture", (answer) => asksPastPicture(answer, pictures), PICTURE_NOTICE],
    ["figures", (answer, steps) => figuresFromPicture(answer, pictures, steps), FIGURES_NOTICE],
  ];
  return (answer, steps = []) => {
    for (const [kind, fails, notice] of checks) {
      if (given.has(kind) || !fails(answer, steps)) continue;
      given.add(kind);
      return notice;
    }
    return null;
  };
}
