/**
 * The answer a card should have carried (owner, 2026-10-26, the morning the
 * visual answers went live: "visual answers don't look like they are live").
 * Asked "what does my week look like", Tex texted seven lines of days;
 * asked for dinner options around them, four lines of restaurants. The
 * prompt's one line about drawing lost to the setup's long rules for lists.
 *
 * So the turn's answer is read once (`claimCheck.js`): a texted answer that is
 * a list of three or more things, from a turn that drew nothing, goes back
 * with this notice, and the model draws the card and texts one line. A list
 * alone is one signal of the prompt's six, and a to-do list stays words: the
 * list must also be something to look at (they asked to see, compare, plan or
 * map it), or most of its lines carry a second signal (a day or time, a price
 * or figure, an address or distance). The prompt's own section says when to
 * draw; this is the floor under it, not the rule.
 */

/** The fewest list lines that make an answer a card. */
const MIN_ITEMS = 3;
/** A line longer than this is a paragraph, not an item. */
const MAX_ITEM_CHARS = 160;
/** The tools whose picture is the answer's card. */
const DRAWN = new Set(["draw_visual", "draw_picture", "make_picture"]);

/** They asked for words only, or for something a card would get in the way of. */
const WORDS_ONLY = /\b(?:text only|just text|no (?:picture|image|card|visual)s?|in words|copy(?:\s+and\s+|\s*\/\s*)paste|draft)\b/i;
/** An answer that is a draft for someone else, or a code or address to copy, stays words. */
const TO_COPY = /^(?:subject|to|dear|hi [A-Z][a-z]+,)\b|```/im;

/** They asked for something to look at. */
const TO_LOOK_AT = /\b(?:show|see|projects|look(?:s)? like|compare|options?|choices|picks|plan|map|itinerary|schedule|week|weekend|trip|which (?:one|is better))\b/i;
/** A line that carries a second signal: a day or time, a price or figure, an address or a distance. */
const SECOND_SIGNAL = new RegExp(
  [
    "\\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\\b|\\b(?:today|tonight|tomorrow)\\b",
    "\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.? \\d",
    "\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)\\b|\\b\\d{1,2}:\\d{2}\\b",
    "[$€£]\\s?\\d|\\$\\$",
    "\\b\\d+(?:\\.\\d+)?\\s?(?:%|mi|km|min|mins|hrs?|stars?|★)",
    "\\b\\d{2,5}(?:-\\d{2})? [A-Z0-9][a-z]* (?:st|ave|blvd|rd|dr|ln|way|pl)\\b",
  ].join("|"),
  "i",
);

/** The list lines in an answer: short, one thing each, not a question. */
function items(answer) {
  return answer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.length <= MAX_ITEM_CHARS && !line.endsWith("?") && !/^\[picture/i.test(line));
}

/**
 * Whether this answer should have been a card: a list of three or more
 * things, from a texted turn that drew nothing, not a draft or words they
 * asked for. `steps` are the turn's tool calls by name.
 */
export function wantsACard(answer, { question = "", steps = [] } = {}) {
  if (typeof answer !== "string") return false;
  if (steps.some((step) => DRAWN.has(step.name) && step.ok)) return false;
  if (WORDS_ONLY.test(question) || TO_COPY.test(answer)) return false;
  const lines = items(answer);
  // Three or more lines sitting together: the first text says what it is, the list follows.
  const runs = answer.split(/\n\s*\n/).map((text) => items(text));
  const list = lines.length >= MIN_ITEMS + 1 ? lines : runs.find((run) => run.length >= MIN_ITEMS);
  if (!list) return false;
  // A list of things to do stays words unless it is something to look at.
  if (TO_LOOK_AT.test(question)) return true;
  return list.filter((line) => SECOND_SIGNAL.test(line)).length * 2 >= list.length;
}

export const VISUAL_NOTICE =
  "That answer is a list, and they read lists better as a picture. Send it as one of your cards instead: call send with action " +
  "draw_visual and the template that fits (places for places to go, day for one day, trip for a week or a trip by day, compare or " +
  "option cards for options, board for work by status, plan for a plan over weeks), with every item and figure from what you found. " +
  "Then reply with ONE line, 25 words at most (the verdict and the next step), and [picture N] on its own line. Never repeat the list in words. " +
  "If the drawing fails again, send the whole list in words, every item with its figures, and don't mention the card.";

/** The card, asked for beside another notice that won the round (`claimCheck.js`). */
export const VISUAL_TOO =
  "And the answer is a list they'd read better as a picture: when you answer, send it as one of your cards (send with action " +
  "draw_visual, the template that fits, every item and figure you have), then ONE line of 25 words at most and [picture N] on its " +
  "own line. Never repeat the list in words.";

/** They asked for a picture outright: "make a graphic for this", "can you draw it", "send me a chart". */
const ASKS_FOR_A_PICTURE = /\b(?:make|draw|send|give|create|turn (?:it|this|that) into|show (?:me|us)|can (?:i|we) (?:get|have)|do)\b[^.?!\n]{0,40}\b(?:graphics?|pictures?|visuals?|charts?|diagrams?|infographics?|images?|cards?|one[- ]pagers?)\b/i;
/** An answer that says a picture is coming with it. */
const SAYS_A_PICTURE = /\b(?:here(?:'|’)?s|here is|attached|sent you|sending)\b[^.\n]{0,30}\b(?:graphic|picture|visual|chart|diagram|infographic|image|card|one[- ]pager|one[- ]page version)\b/i;

/**
 * Whether this answer owes a picture it has none of: they asked for one
 * outright, or the answer says "here's the graphic", and nothing drawn this
 * turn worked. (A drawing that worked goes with the answer even when the
 * answer forgot to name it: `outgoingPictures.js`.)
 */
export function owesAPicture(answer, { question = "", steps = [] } = {}) {
  if (typeof answer !== "string") return false;
  if (steps.some((step) => DRAWN.has(step.name) && step.ok)) return false;
  // A picture it names ("[picture 1]", one read from a note or a page) goes with the answer.
  if (/^\s*\[picture [^\]\n]+\]\s*$/im.test(answer)) return false;
  return ASKS_FOR_A_PICTURE.test(question) || SAYS_A_PICTURE.test(answer.replace(/[‘’]/g, "'"));
}

export const OWED_PICTURE_NOTICE =
  "That answer has no picture with it: nothing was drawn this turn, so nothing would be sent, yet they asked for one or your words say one is there. " +
  "Draw it now: call send with action draw_visual and the template that fits (board, plan, steps, system or compare for an idea or a project; " +
  "places or option for places and choices), then reply with ONE line and [picture N] on its own line. If drawing fails, say so in a few words and give the answer in words.";

/*
  A PICTURE SAID TO BE IN A NOTE (Tex Devs group, 2026-10-26): "The known-limit
  note now has a picture" after a write that carried none. Only a write with
  `images` puts a picture in a note (`pictureMaker.js` `withNotePictures`).
*/
const PICTURE_WORD = String.raw`(?:graphic|picture|visual|chart|diagram|infographic|image|card|one[- ]pager)`;
const NOTE_WORD = String.raw`(?:note|backlog|doc|document|page|write-?up)`;
const SAYS_NOTE_PICTURE = [
  new RegExp(String.raw`\b${NOTE_WORD}\b[^.\n]{0,40}\b(?:now\s+)?(?:has|have|includes?|carries|shows)\b[^.\n]{0,20}\b${PICTURE_WORD}`, "i"),
  new RegExp(String.raw`\b(?:added|put|saved|attached|embedded|dropped|included)\b[^.\n]{0,30}\b${PICTURE_WORD}s?\b[^.\n]{0,30}\b(?:to|in|into|on)\b[^.\n]{0,20}\b${NOTE_WORD}\b`, "i"),
  new RegExp(String.raw`\b${PICTURE_WORD}s?\b[^.\n]{0,20}\b(?:is|are)\s+(?:now\s+)?(?:in|on)\s+(?:the|that|your)\b[^.\n]{0,20}\b${NOTE_WORD}\b`, "i"),
];

/** Whether the answer says a note now holds a picture, and no write this turn carried one. */
export function claimsNotePicture(answer, steps = []) {
  if (typeof answer !== "string") return false;
  if (steps.some((step) => step.ok && step.images === true)) return false;
  const said = answer.replace(/[‘’]/g, "'");
  return SAYS_NOTE_PICTURE.some((pattern) => pattern.test(said));
}

export const NOTE_PICTURE_NOTICE =
  "Before this goes: your answer says a note now has a picture, but no write this turn put one in it. " +
  "Put it there now: draw it if it isn't drawn (send action draw_visual), then write_note that note with images [{ data: \"picture:N\" }] and its text kept. " +
  "If you can't, say plainly the note has no picture yet. Never say a picture is in a note without that write.";
