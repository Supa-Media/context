/**
 * TEX'S OWN OPEN QUESTION, AS A FACT (Dev2, 2026-11-27, launch-day rehearsal finding 5a).
 *
 * Tex asked a group "what area should I search?", the answer came back ("poconos! driving distance from nyc"), and
 * Tex's thinking read it as a new question and offered to search instead of searching. The question was in the
 * history, but nothing told the turn that it was still waiting on it. The judge already reads Tex's newest text as
 * its question when it asks something (`packages/tex/worker/events.ts` `renderTranscript`, `open`); this hands the
 * turn the same fact, by the same rule, so the two read one chat alike.
 *
 * Data only (`docs/decisions/texting-assistant/no-scripted-wording.md`): what Tex asked and when, never what to do
 * with it.
 */

const MAX_WORDS = 300;
/** A question older than this is history, not one Tex is waiting on. */
export const OPEN_FOR_MS = 24 * 60 * 60_000;

const textOf = (event) => String(event?.text ?? "").replace(/\s+/g, " ").trim();

/** The sentences of `text` that ask something, in order: "What area should I search?" from a longer text. */
export function askedIn(text) {
  const sentences = String(text ?? "").match(/[^.!?\n]*\?+/g) ?? [];
  return sentences.map((sentence) => sentence.trim()).filter(Boolean).join(" ").slice(0, MAX_WORDS);
}

/**
 * The fact for this turn, or "": Tex's newest delivered text before the texts it is answering now, when that text
 * asks something and was sent within a day of them. `shown` is the chat's events, unfaded, oldest first (`loggedTurn.js` `parts.answeredBy`); `covered` the texts
 * this turn answers.
 */
export function openQuestionFact(shown, covered) {
  const people = (Array.isArray(covered) ? covered : []).filter((event) => event?.from?.kind === "person" && Number.isFinite(event.at));
  if (people.length === 0 || !Array.isArray(shown)) return "";
  const first = Math.min(...people.map((event) => event.at));
  const tex = shown.filter((event) => event?.from?.kind === "tex" && event.kind === "text" && event.delivered !== false && Number.isFinite(event.at) && event.at < first).sort((a, b) => a.at - b.at).at(-1);
  if (tex === undefined || first - tex.at > OPEN_FOR_MS) return "";
  const asked = askedIn(textOf(tex));
  if (asked === "") return "";
  return JSON.stringify({ your_open_question: asked });
}
