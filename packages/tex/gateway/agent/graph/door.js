/**
 * THE DOOR: what a turn needs gathered in code before any model runs (Dev2, 2026-11-16: the eleven door steps are one
 * "Door" step in Intake; "we don't really need the door ... we can consolidate into intake").
 *
 * The door's parts are the steps under `../texEntryPoint/`, run in this order on the turn so far, `t`. Each part reads
 * and extends `t`; a part that answers the turn itself (a refusal, a settled yes or a thumbs-up, a paused routine)
 * returns its answer, and the door stops there. Every part's run is kept as data (`parts`: its name, how long it took
 * and what it found, never `t` itself), so the one step that runs the door logs each part inside its own row: nothing
 * of the door runs unlogged.
 *
 * Two steps run the door: Door (`nodes/doorStep.js`) for a text, and Routine runs (`nodes/routine.js`) for a routine's
 * run, which goes on to the Front door as a routine and never as a text. This file is not a node; it is the code those
 * two nodes share.
 */
import { readTheText } from "../texEntryPoint/readTheText.js";
import { groupReachOut } from "../groupGuests.js";
import { runARoutine } from "../texEntryPoint/runARoutine.js";
import { checkTheQuestion } from "../texEntryPoint/checkTheQuestion.js";
import { settleAYesOrNo } from "../texEntryPoint/settleAYesOrNo.js";
import { watchWhatLeaves } from "../texEntryPoint/watchWhatLeaves.js";
import { checkItMayRun } from "../texEntryPoint/checkItMayRun.js";
import { readTheHistory } from "../texEntryPoint/readTheHistory.js";
import { openTheWeb } from "../texEntryPoint/openTheWeb.js";
import { readTheSetup } from "../texEntryPoint/readTheSetup.js";
import { prepareBookkeeping } from "../texEntryPoint/prepareBookkeeping.js";
import { prepareTheAnswer } from "../texEntryPoint/prepareTheAnswer.js";

const has = (v) => v !== null && v !== undefined;
const count = (v) => (Array.isArray(v) ? v.length : 0);

/**
 * The door's parts, in the order they run: `[name, step, found]`, `found(t, ctx)` being what the part found, as data
 * for the log. The names are the parts' old step names, so a turn logged before the door was one step reads the same.
 */
export const DOOR_PARTS = Object.freeze([
  ["readTheText", readTheText, (t) => ({ chat: has(t.group) ? "group" : "one", kind: String(t.tex?.kind ?? ""), job: t.job != null, routine: t.runner === true, report: t.report != null, asked: typeof t.question === "string" && t.question.length > 0, covers: Array.isArray(t.body?.covers) ? t.body.covers.filter((id) => typeof id === "string").slice(0, 32) : [], ...groupReachOut(t.group) })],
  ["runARoutine", runARoutine, (t) => ({ routine: has(t.routine), runs: count(t.runs), supervised: has(t.supervision) })],
  ["checkTheQuestion", checkTheQuestion, (t) => ({ quoted: has(t.quoted), reacted: count(t.reacted), attachments: count(t.sent), steering: has(t.steer) })],
  ["settleAYesOrNo", settleAYesOrNo, (t) => ({ front: t.front === true, thumbsUp: t.thumbsUp === true, setAside: count(t.setAside), dropped: count(t.dropped), paid: count(t.paid) })],
  ["watchWhatLeaves", watchWhatLeaves, (t) => ({ ledger: has(t.ledger), seenWhole: t.session?.egress?.complete === true, texting: t.session?.egress?.texting === true })],
  ["checkItMayRun", checkItMayRun, (t) => ({ allowedStarted: t.allowedRead != null, historyStarted: t.historyRead != null, toolsStarted: t.offeredRead != null })],
  ["readTheHistory", readTheHistory, (t) => ({ history: count(t.history), attachments: count(t.attachments), tools: count(t.offered), logged: has(t.logged), background: t.background != null })],
  ["openTheWeb", openTheWeb, (t) => ({ texting: t.texting === true, streamed: t.streamed === true, channel: t.channel != null, writeTools: count(t.textingWriting), groupWriteTools: count(t.groupWriting) })],
  ["readTheSetup", readTheSetup, (t, ctx) => ({ production: t.production != null, productionModel: t.productionModel != null, router: t.router != null, delegation: t.delegation != null, shown: count(t.shown), variant: typeof ctx?.useSetup === "function" ? ctx.useSetup(t.production) : "" })],
  ["prepareBookkeeping", prepareBookkeeping, (t) => ({ ledgerTurn: typeof t.ledgerTurn === "string" ? t.ledgerTurn : "", chatLog: t.chatLog != null, keepPictures: typeof t.keepPictures === "function" })],
  ["prepareTheAnswer", prepareTheAnswer, (t) => ({ texted: t.texted === true, claims: has(t.claims), tries: t.tries != null, forwarding: count(t.forwarding), pictures: t.maker != null, knowsStarted: t.knowsRead != null })],
]);

/** The fields the Front door is handed from the door's last part (its input schema names them). */
const HANDED = ["texted", "claims", "tries", "forwarding", "pictures", "knowsStarted"];

/**
 * Run the door on `t`. Answers `{ answer, answeredBy, parts, handed }`: `answer` the Response of the part that answered
 * the turn (`answeredBy` its name), or undefined when every part ran; `parts` each part's log; `handed` what the last
 * part found, for the Front door. A part that throws stops the door, its error carried with its part logged. `steps`
 * is the door's parts, swapped only by a test. `afterRead(t)` is called once the first part has read the text.
 */
export async function runDoor(t, ctx = {}, now = Date.now, steps = DOOR_PARTS, { afterRead = null } = {}) {
  const parts = [];
  for (const [name, step, found] of steps) {
    const began = now();
    let answer;
    try {
      answer = await step(t);
    } catch (error) {
      parts.push({ part: name, ms: now() - began, ok: false, error: String(error?.message ?? error).slice(0, 300) });
      error.doorParts = parts;
      throw error;
    }
    if (answer !== undefined) {
      parts.push({ part: name, ms: now() - began, ok: true, answered: true, status: answer?.status ?? null });
      return { answer, answeredBy: name, parts, handed: {} };
    }
    // The text is read: what runs beside the rest of the door starts now (`nodes/doorStep.js`, the Shape gate).
    if (name === "readTheText" && typeof afterRead === "function") afterRead(t);
    const seen = found(t, ctx);
    parts.push({ part: name, ms: now() - began, ok: true, ...seen });
    if (name === "prepareTheAnswer") return { answer: undefined, answeredBy: "", parts, handed: Object.fromEntries(HANDED.map((k) => [k, seen[k]])) };
  }
  return { answer: undefined, answeredBy: "", parts, handed: {} };
}
