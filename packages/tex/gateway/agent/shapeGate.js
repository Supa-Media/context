/**
 * THE SHAPE GATE: WHAT KIND OF ANSWER THIS TURN IS (`docs/decisions/testing/tex-quality-architecture-2026-11-17.md`,
 * change 2; step `shapeGate` in `texConfig.json`, off until a scored Training and Dev run says keep it).
 *
 * How long an answer is, what leads it, and whether a finished simple thing gets a sentence or a tapback were left to
 * one model reading the whole setup: nothing in the graph knew what kind of answer the turn was. The gate is three
 * typed questions asked of Clef beside the Door, on the text alone: how the turn should end, whether the text is an
 * order to act, and whether it asks about something stored. Its read is used twice.
 *
 * - The Front door is told it, in the turn's own note (`shapeNote`): a line, never a rule.
 * - The code checks hold it (`shapeFindings`, through `doItChecks.js`): each contract goes back at most once a turn,
 *   only when Clef was sure (`HOLD_AT`), and never on a text that tagged Tex by name, which is always answered in words.
 *
 * It never writes Tex's words and never ends a turn itself: a contract sends a draft back with what it found, and the
 * Front door decides. A gate that failed, timed out or was not sure says nothing.
 */
import { finding } from "./checkFindings.js";

/** The endings a turn can have, as the gate's choices. */
export const ENDINGS = Object.freeze({
  tapback: "a reaction is the whole reply: they asked for one small thing to be done, noted or changed, and once it is done there is nothing to tell them",
  one_line: "one short line answers it: a fact, a yes or no, a time, a number, a quick opinion",
  answer: "an answer of a few short lines: an explanation, a comparison, advice, a draft to look at",
  report: "what Tex found or did, in parts: several things looked up, checked or changed, each said briefly",
  job: "long work that takes minutes: Tex says it is on it, starts a background job and comes back with the result",
});

/** Told to the Front door from this confidence; held in code from this one. */
export const NOTE_AT = 0.6;
export const HOLD_AT = 0.85;
/** A one-line answer's length, and how many times that a draft may run before the contract sends it back. */
export const ONE_LINE_CHARS = 140;
export const ONE_LINE_TIMES = 3;
/** The most of their text the gate reads. */
const MAX_TEXT = 2_000;

/** The gate's questions over one text. `group`: whether it was sent in a group chat. */
export function shapeRequest(question, { group = false } = {}) {
  const where = group ? "a group chat Tex is in" : "a one-to-one chat with Tex";
  const state = `<where>${where}</where>\n\n<text>\n${String(question ?? "").slice(0, MAX_TEXT)}\n</text>`;
  const opening = `The state holds one text a person just sent in ${where}; Tex is an assistant they text, with their notes, mail, calendar, the web and tools.`;
  return {
    state,
    questions: {
      ending: { type: "choice", instructions: `${opening} How should Tex's reply to this text end, the way a capable friend would text back?`, criteria: { ...ENDINGS } },
      order: {
        type: "noul",
        instructions: "Is this text an order for Tex to do something (make, change, save, send, book, set, find out and come back), rather than a question to answer or a remark?",
        criteria: { true: "yes, it tells Tex to do something", false: "no, it asks something, or only says something" },
      },
      records: {
        type: "noul",
        instructions: "Does answering it need something of theirs that is stored read first: a note, an email, their calendar, a page, a picture or file, a contact?",
        criteria: { true: "yes, the answer is in something stored", false: "no, it can be answered without reading anything of theirs" },
      },
    },
  };
}

const sure = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

/** The gate's answers as a read: `{ ending, endingSure, order, records }`, or null when the model named no ending. */
export function readShape(answers) {
  const ending = answers?.ending?.choice;
  if (typeof ending !== "string" || !Object.hasOwn(ENDINGS, ending)) return null;
  return { ending, endingSure: sure(answers.ending.confidence), order: sure(answers?.order?.noul), records: sure(answers?.records?.noul) };
}

const ENDING_WORDS = {
  tapback: "once it is done, a tapback is the whole reply, unless there is something they need to know",
  one_line: "one short line, the answer first",
  answer: "a few short lines, the answer first",
  report: "what you found or did, the result first, each part in a few words",
  job: "say you are on it in a line, start the background job, and come back with the result",
};

/** The read as the Front door is told it, in the turn's own note; "" when the gate was not sure of anything. */
export function shapeNote(shape) {
  if (!shape) return "";
  const lines = [];
  if (shape.endingSure >= NOTE_AT) lines.push(`How this turn most likely ends: ${ENDING_WORDS[shape.ending]}.`);
  if (shape.order >= NOTE_AT) lines.push("This reads as an order: do it with your tools in this turn, then say what was done, rather than offering to.");
  if (shape.records >= NOTE_AT) lines.push("This asks about something of theirs that is stored: read it before you answer, and answer from what it says.");
  return lines.length === 0 ? "" : `A first read of this text, made before you saw it (trust what you find over it):\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export const TAPBACK_NOTICE =
  "Before this goes: what they asked for is done, and it was one small thing. A reaction says that better than a sentence. " +
  "Unless your draft tells them something they need and don't already have, end this turn with a tapback (send, action tapback) and no words.";
export const ONE_LINE_NOTICE = "Before this goes: this text takes one short line back, and your draft runs several times that. Say it in one line, the answer first, and leave out the rest.";
export const ORDER_NOTICE =
  "Before this goes: they told you to do something, and no call went out in this turn. Do it now with your tools and say what was done; " +
  "if something stops you, say what in one line.";

/**
 * The contracts the code holds on a draft, as findings (`checkFindings.js`). `calls` and `failed` count this turn's
 * tool calls; `done` names the contracts already sent back this turn (each goes once), and is added to.
 */
export function shapeFindings(shape, { answer, calls = 0, failed = 0, tagged = false, done = new Set() } = {}) {
  if (!shape || tagged === true) return [];
  const words = String(answer ?? "").trim();
  if (words === "") return [];
  const out = [];
  const once = (kind, notice) => {
    if (done.has(kind)) return;
    done.add(kind);
    out.push(finding(kind, notice));
  };
  const held = shape.endingSure >= HOLD_AT;
  if (held && shape.ending === "tapback" && calls > 0 && failed === 0) once("shape-tapback", TAPBACK_NOTICE);
  else if (held && shape.ending === "one_line" && words.length > ONE_LINE_CHARS * ONE_LINE_TIMES) once("shape-line", ONE_LINE_NOTICE);
  if (shape.order >= HOLD_AT && calls === 0 && !(held && shape.ending === "job")) once("shape-order", ORDER_NOTICE);
  return out;
}

/** This turn's tool calls, from its messages (`turn.js`: one `role: "tool"` message a call): how many, and how many failed. */
export function callsIn(messages) {
  const tools = (Array.isArray(messages) ? messages : []).filter((message) => message?.role === "tool");
  return { calls: tools.length, failed: tools.filter((message) => message.isError === true).length };
}
