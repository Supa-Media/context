// Turning a meeting into a note somebody wants to read.
//
// Model-agnostic on purpose: this file builds a `{system, user}` pair and hands
// it back. Which model runs it, on whose key, behind which gateway, is a
// deployment decision — and a self-hoster has to be able to point this at their
// own. Nothing here imports a client or knows a provider's name.
//
// The idea worth protecting is the one the whole category is built on: the
// generated note follows the shape of what the human bothered to type. Somebody
// who wrote three bullets about pricing wants a note about pricing, not an
// even-handed summary of forty minutes. So the human's notes go in the prompt
// above the transcript, and the system message says what they are for.

import { applyEvent, MeetingEventError } from "./session.js";
import { formatClock, groupIntoTurns } from "./transcript.js";
import { renderTurn } from "./note.js";

/** @typedef {import("./protocol.js").MeetingSession} MeetingSession */

/**
 * @typedef {Object} EnhancementTemplate
 * @property {string} id
 * @property {string} label
 * @property {string} instruction  The shape of note this template produces.
 */

/** @type {Readonly<Record<string, EnhancementTemplate>>} */
export const TEMPLATES = Object.freeze({
  default: Object.freeze({
    id: "default",
    label: "General meeting",
    instruction: [
      "Produce: a two-to-four sentence summary; then `### Decisions`, `### Action items`",
      "and `### Open questions`, each a bullet list, each omitted entirely when the meeting",
      "produced none. Attribute an action item to a person only when the transcript names them.",
    ].join(" "),
  }),
  standup: Object.freeze({
    id: "standup",
    label: "Standup",
    instruction: [
      "Produce one `###` section per person who spoke, each with what they finished, what they",
      "are on next, and anything blocking them — in that order, omitting a line they did not",
      "cover. Close with `### Blockers` only if someone raised one. Keep it terse; a standup",
      "note nobody skims is a failed standup note.",
    ].join(" "),
  }),
  "one-on-one": Object.freeze({
    id: "one-on-one",
    label: "One-on-one",
    instruction: [
      "Produce `### Discussed`, `### Commitments` (who owes what, to whom, by when) and",
      "`### Follow up next time`. This is a private note between two people: keep feedback in",
      "the words it was given in, and do not soften or sharpen it.",
    ].join(" "),
  }),
  interview: Object.freeze({
    id: "interview",
    label: "Interview",
    instruction: [
      "Produce `### Background`, `### Signals` (evidence from what the candidate actually said,",
      "quoted where a quote is short and load-bearing), `### Concerns` and `### Suggested",
      "follow-ups`. Report evidence, never a hiring recommendation, and never infer anything",
      "about the candidate that was not said out loud.",
    ].join(" "),
  }),
  "sales-call": Object.freeze({
    id: "sales-call",
    label: "Sales call",
    instruction: [
      "Produce `### Where they are`, `### What they need`, `### Objections`, `### Next steps`",
      "with an owner and a date on each. Record budget, timeline and decision-maker only when",
      "they were stated; write nothing where they were not.",
    ].join(" "),
  }),
  lecture: Object.freeze({
    id: "lecture",
    label: "Lecture or talk",
    instruction: [
      "Produce `### Thesis`, then `###` sections following the speaker's own structure, then",
      "`### Terms` for anything defined and `### References` for anything cited. Favour the",
      "speaker's ordering over a tidier one.",
    ].join(" "),
  }),
});

export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

export const DEFAULT_TEMPLATE_ID = "default";

/** @param {unknown} id */
export function isTemplateId(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(TEMPLATES, id);
}

/**
 * How much transcript one request may carry.
 *
 * A budget rather than a token count because this file does not know the model,
 * and characters are the one unit every tokenizer agrees exists. Roughly forty
 * minutes of speech; longer meetings get the head and the tail, which is where
 * the framing and the decisions are.
 */
export const DEFAULT_TRANSCRIPT_BUDGET = 24000;

/** Room reserved for the elision marker, which cannot be sized before it exists. */
const ELISION_RESERVE = 64;

/**
 * Trim to a budget, keeping the start and the end and saying so.
 *
 * Silent truncation would be the bug here: a model handed a transcript that
 * stops mid-sentence writes a summary of a meeting that ended early, and
 * nothing downstream would ever know.
 *
 * @param {string} text
 * @param {number} [budgetChars]
 * @returns {string}
 */
export function budgetTranscript(text, budgetChars = DEFAULT_TRANSCRIPT_BUDGET) {
  const body = String(text ?? "");
  const budget = Number.isFinite(budgetChars) && budgetChars > ELISION_RESERVE * 2 ? Math.floor(budgetChars) : DEFAULT_TRANSCRIPT_BUDGET;
  if (body.length <= budget) return body;

  const room = budget - ELISION_RESERVE;
  const headRoom = Math.floor(room * 0.6);
  const tailRoom = room - headRoom;

  // Cut on a line boundary where one is close, so neither end starts or stops
  // mid-turn.
  let head = body.slice(0, headRoom);
  const headBreak = head.lastIndexOf("\n");
  if (headBreak > headRoom * 0.5) head = head.slice(0, headBreak);

  let tail = body.slice(body.length - tailRoom);
  const tailBreak = tail.indexOf("\n");
  if (tailBreak !== -1 && tailBreak < tailRoom * 0.5) tail = tail.slice(tailBreak + 1);

  const elided = body.length - head.length - tail.length;
  return `${head}\n\n… [${elided} characters of transcript elided] …\n\n${tail}`;
}

/**
 * The transcript as the model sees it: grouped turns, timestamped, one per line.
 *
 * @param {MeetingSession} session
 * @param {{maxGapMs?: number}} [options]
 * @returns {string}
 */
export function renderTranscriptForPrompt(session, options = {}) {
  const turns = groupIntoTurns(session.transcript ?? [], { maxGapMs: options.maxGapMs });
  return turns.map((turn) => renderTurn(turn)).join("\n");
}

/**
 * @typedef {Object} EnhancementRequest
 * @property {string} system
 * @property {string} user
 * @property {string} templateId
 */

/**
 * Build the request. Nothing is sent; that is the caller's job.
 *
 * @param {MeetingSession} session
 * @param {string} [templateId]
 * @param {{budgetChars?: number, maxGapMs?: number}} [options]
 * @returns {EnhancementRequest}
 */
export function buildEnhancementRequest(session, templateId = DEFAULT_TEMPLATE_ID, options = {}) {
  if (!session || typeof session !== "object") throw new MeetingEventError("buildEnhancementRequest needs a session");
  // Refusing an unknown template is deliberate: the gateway validates input and
  // answers `meeting_invalid`, rather than quietly writing somebody a standup
  // note when they asked for an interview one.
  if (!isTemplateId(templateId)) throw new MeetingEventError(`unknown enhancement template: ${String(templateId)}`);
  const template = TEMPLATES[templateId];

  const system = [
    "You write meeting notes that go straight into somebody's own Markdown notes, in storage they own.",
    "",
    "Rules, in order of precedence:",
    "1. The person's own typed notes are the skeleton. Whatever they bothered to write down is what they",
    "   care about: follow their emphasis, their ordering and their vocabulary, and expand on it from the",
    "   transcript. Never contradict them and never drop a point they made.",
    "2. Use only what is in the notes and the transcript. If something was not said, it is not in the note.",
    "   Where the transcript is unclear, say so in the note rather than resolving it.",
    "3. Do not repeat back their notes verbatim — those already appear elsewhere in the file.",
    "4. Output Markdown only, starting at a `###` heading or plain prose. No `#` or `##` headings (the",
    "   file already has them), no frontmatter, no code fence around the whole answer, no preamble such as",
    '   "Here is the summary".',
    "",
    `Template — ${template.label}: ${template.instruction}`,
  ].join("\n");

  const attendees = (session.attendees ?? []).map((attendee) => attendee.name).filter(Boolean);
  const transcript = budgetTranscript(renderTranscriptForPrompt(session, options), options.budgetChars);
  const notes = typeof session.notes === "string" ? session.notes.trim() : "";

  const user = [
    `Title: ${session.title ?? ""}`,
    `Started: ${session.startedAt ?? ""}`,
    `Recorded: ${formatClock(session.recordedMs ?? 0)}`,
    `Source: ${session.source?.kind ?? "unknown"}`,
    `Attendees: ${attendees.length ? attendees.join(", ") : "unknown"}`,
    "",
    "## Their own notes",
    "",
    notes || "_They typed nothing. Fall back to the template's default shape._",
    "",
    "## Transcript",
    "",
    transcript || "_No transcript was captured._",
  ].join("\n");

  return { system, user, templateId };
}

/**
 * Fold a generated note back into the session.
 *
 * Goes through `applyEvent` rather than assigning, so enhancement obeys the
 * same replay and immutability rules as everything else.
 *
 * @param {MeetingSession} session
 * @param {string} markdown
 * @param {string} [templateId]
 * @returns {MeetingSession}
 */
export function applyEnhancement(session, markdown, templateId = DEFAULT_TEMPLATE_ID) {
  if (!isTemplateId(templateId)) throw new MeetingEventError(`unknown enhancement template: ${String(templateId)}`);
  return applyEvent(session, { type: "enhanced", markdown, templateId });
}
