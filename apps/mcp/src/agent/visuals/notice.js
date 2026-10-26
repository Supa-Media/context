/**
 * The answer a card should have carried (owner, 2026-10-26, the morning the
 * visual answers went live: "visual answers don't look like they are live").
 * Asked "what does my week look like", Tex texted seven lines of days;
 * asked for dinner options around them, four lines of restaurants. The
 * prompt's one line about drawing lost to the setup's long rules for lists.
 *
 * So the turn's answer is read once (`claimCheck.js`): a texted answer that is
 * a list of three or more things, from a turn that drew nothing, goes back
 * with this notice, and the model draws the card and texts one line.
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
  const runs = answer.split(/\n\s*\n/).map((text) => items(text).length);
  return lines.length >= MIN_ITEMS + 1 || runs.some((n) => n >= MIN_ITEMS);
}

export const VISUAL_NOTICE =
  "That answer is a list, and they read lists better as a picture. Send it as one of your cards instead: call send with action " +
  "draw_visual and the template that fits (places for places to go, day for one day, trip for a week or a trip by day, compare or " +
  "option cards for options, board for work by status, plan for a plan over weeks), with every item and figure from what you found. " +
  "Then reply with ONE line, 25 words at most (the verdict and the next step), and [picture N] on its own line. Never repeat the list in words.";
