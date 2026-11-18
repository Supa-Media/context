/**
 * Which text each bubble of a group answer goes under (Dev2, 2026-11-18, the
 * "Battle of the Bots" chat: "tex, say alpha" and "tex, say bravo" landed in
 * one turn, and both bubbles were threaded under "say bravo", because the
 * Worker threaded every bubble under the newest message the turn answered).
 *
 * When a group turn answers two or more texts, the front door is shown them
 * numbered (`underNote`) and may start a paragraph with that number, "[2] ",
 * to put it under that text. `splitUnder` takes the numbers out of the answer,
 * so no marker ever reaches the chat, and says which event each run of
 * paragraphs answers; the Worker threads those bubbles there
 * (`apps/agent/src/groupModelTurn.ts` `bubblesUnder`). Paragraphs before the
 * first number, and any answer with no number, go where they always went.
 */

/** "[2] " at the start of a paragraph: the number of the text it answers. */
const MARK = /^[ \t]*\[(\d{1,2})\][ \t]*/;
/** Any marker left anywhere in a line, taken out whatever it numbered. */
const ANY_MARK = /^([ \t]*)\[(\d{1,2})\][ \t]*/gm;
const LINE_CHARS = 160;

const oneLine = (text) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > LINE_CHARS ? `${flat.slice(0, LINE_CHARS - 1)}…` : flat;
};

/** The texts a group turn answers that a person sent, oldest first: each a number the answer can name. */
export function answeredTexts(covered) {
  if (!Array.isArray(covered)) return [];
  return covered.filter((event) => event?.from?.kind === "person" && typeof event.id === "string" && oneLine(event.text) !== "");
}

/** The turn's note on numbering, or "" for a turn answering fewer than two texts, or not in a group. */
export function underNote(covered, { group = false, speaker = (from) => `@${from?.name || "someone"}` } = {}) {
  const texts = group ? answeredTexts(covered) : [];
  if (texts.length < 2) return "";
  const lines = texts.map((event, index) => `[${index + 1}] ${speaker(event.from)}: ${oneLine(event.text)}`);
  return [
    `This turn answers ${texts.length} texts at once:`,
    ...lines,
    "Each answer bubble is threaded under one of them in the chat. When a paragraph answers one text in particular, start it with that text's number, like \"[2] \", and it goes under that text; the number itself is never sent. A paragraph with no number goes under the newest text. One reply that answers them all together needs no numbers.",
  ].join("\n");
}

/** The answer with every marker taken out. */
export function withoutMarks(answer) {
  return String(answer ?? "").replace(ANY_MARK, "$1");
}

/**
 * The answer as sent (markers out) and, when it numbered any paragraph, the
 * runs of paragraphs in order with the event each goes under: `under` is null
 * for a run with no number (the turn's newest text, as before).
 */
export function splitUnder(answer, covered) {
  const text = String(answer ?? "");
  const texts = answeredTexts(covered);
  // Only a turn shown the numbers has any: anything else is left exactly as written.
  if (texts.length < 2) return { answer: text, parts: null };
  if (!text.split(/\n{2,}/).some((paragraph) => MARK.test(paragraph))) return { answer: withoutMarks(text), parts: null };
  const parts = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const mark = paragraph.match(MARK);
    const number = mark ? Number(mark[1]) : null;
    const under = number !== null && number >= 1 && number <= texts.length ? texts[number - 1].id : number === null ? parts.at(-1)?.under ?? null : null;
    const words = withoutMarks(paragraph).trim();
    if (words === "") continue;
    const last = parts.at(-1);
    if (last && last.under === under) last.text = `${last.text}\n\n${words}`;
    else parts.push({ under, text: words });
  }
  const answered = parts.map((part) => part.text).join("\n\n");
  return { answer: answered, parts: parts.some((part) => part.under !== null) ? parts : null };
}

/**
 * The parts as the Worker sends them: `parts` from `splitUnder` over the answer
 * `told`, carried onto what is really sent (`sent`), which may end with the
 * gateway's own lines after it (an ask, an offer, a browser link): those go
 * with the last part. Null when there are no parts, or `sent` no longer starts
 * with the answer they were cut from, so nothing is threaded on a guess.
 */
export function underOf(parts, told, sent) {
  if (!Array.isArray(parts) || parts.length === 0) return null;
  const answer = String(told ?? "");
  const all = String(sent ?? "");
  if (!all.startsWith(answer)) return null;
  const tail = all.slice(answer.length).trim();
  const out = parts.map((part) => ({ ...(part.under !== null ? { under: part.under } : {}), text: part.text }));
  if (tail !== "") out[out.length - 1] = { ...out.at(-1), text: `${out.at(-1).text}\n\n${tail}` };
  return out;
}
