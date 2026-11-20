/**
 * THE ROUTER'S CONTEXT MODULES (Seyi, 2026-11-18: the router reads its context from its config `ctx`, like every other
 * node, so what it reads is edited in the Lab). The router's state is built from the modules its `ctx` names, in the
 * order it names them, from the same sources the other steps read them from:
 *
 *   `train:<nodeId>`                 that node's Training labels as short examples (`texTraining.cjs` `exampleText`);
 *   `train:<nodeId>:all:<chars>`     its whole Training conversations within `<chars>` (`wholeText`);
 *   `summaries:<days|all>:<chars>`   and `chat:<days|all>:<chars>`: the chat's history as the front door reads it
 *                                    (`weekHistory.js` `weekTurn`), the summaries of earlier days, then word for word;
 *   `recent`                         the last few texts, when no `chat:` module is named (read as one day's words);
 *   `groupBrief`                     what Tex is doing in this chat now, as Decide is told it (`textsDecide.js` `nowFacts`);
 *   `date`                           today's date and time where they are (`localNow.js` `nowLine`).
 *
 * Any other entry is read as nothing. The parts come in from the caller, read live by the router node
 * (`graph/nodes/router.js`) or from the conversation in the Training bench (`bench/setsRun.mjs` `routeCase`), and this
 * file only fits them. Clef reads `MAX_DECISION_STATE_CHARS` of a state and no more (`decide.js`), far under what the
 * modules' own caps allow, so the fit is Clef's: the text and the trigger always, the facts and the date next, then the
 * examples within half of what is left, then the history, newest kept, whatever room the examples leave. A module's own
 * cap still bounds it when it is the smaller.
 */
import { MAX_DECISION_STATE_CHARS } from "./decide.js";
import { runOrder } from "../../../../packages/tex/src/texModuleChange.cjs";
import { TRAIN_ENTRY, TRAINING_INTRO, exampleText, wholeText } from "../../../../packages/tex/src/texTraining.cjs";

/** The entries that read the chat's history, whose order puts the history among the other modules. */
const HISTORY_ENTRY = /^(?:chat|summaries):(?:\d{1,4}|all):\d{1,7}$/;
/** The most of the state the facts of the moment take (`textDecide.cjs` `MAX_FACTS`). */
export const MAX_FACTS = 3_200;
/** Room kept for the tags around each part. */
const TAGS = 64;

/** What a step's `ctx` asks the router's reader for: which parts to read, and how much of the chat. */
export function routerWants(ctx) {
  const list = Array.isArray(ctx) ? ctx.filter((entry) => typeof entry === "string") : [];
  return {
    training: list.some((entry) => TRAIN_ENTRY.test(entry)),
    history: list.some((entry) => HISTORY_ENTRY.test(entry)),
    recent: list.includes("recent"),
    facts: list.includes("groupBrief"),
    date: list.includes("date"),
  };
}

/** The newest of `text` within `room` characters, from a line's start, with a line saying how much was left out. */
function newestOf(text, room) {
  if (text.length <= room) return text;
  if (room < 80) return "";
  const kept = text.slice(text.length - (room - 60));
  const at = kept.indexOf("\n");
  return `(earlier chat left out for room)\n${at >= 0 ? kept.slice(at + 1) : kept}`;
}

/** A Training block of whole examples within `room`: `train:<node>` entries' moments in order, then each whole-conversation entry. */
function examplesWithin(entries, training, room) {
  const parts = [];
  let left = room;
  const moments = entries.filter((m) => m[2] === undefined).flatMap((m) => training?.nodes?.[m[1]] ?? []);
  if (moments.length > 0) {
    const open = `${TRAINING_INTRO}\n\n<examples>\n`;
    const close = "</examples>";
    const kept = [];
    let used = open.length + close.length + 60;
    for (const moment of moments) {
      const text = `${exampleText(moment)}\n`;
      if (used + text.length > left) continue;
      kept.push(text);
      used += text.length;
    }
    const out = moments.length - kept.length;
    if (kept.length > 0) {
      const block = `${open}${kept.join("")}${close}${out > 0 ? `\n(${out} more example${out === 1 ? "" : "s"} left out for room)` : ""}`;
      parts.push(block);
      left -= block.length + 2;
    }
  }
  for (const m of entries) {
    if (m[2] === undefined) continue;
    const block = wholeText(m[1], Math.min(Number(m[2]), left), training);
    if (block !== "") {
      parts.push(block);
      left -= block.length + 2;
    }
  }
  return parts.join("\n\n");
}

/**
 * The router's context, fitted within `room` characters: the modules `ctx` names, in its order, each in its tags, "" when
 * it names none that read anything. `training` is the Training module the process reads (production every conversation,
 * the bench the one it scores held out or cut at the moment), `history` the chat as the history module renders it,
 * `facts` lines of what Tex is doing now, `today` the date line.
 */
export function routerContextText(ctx, { training = null, history = "", facts = [], today = "" } = {}, room = MAX_DECISION_STATE_CHARS) {
  const list = Array.isArray(ctx) ? ctx.filter((entry) => typeof entry === "string") : [];
  const known = (Array.isArray(facts) ? facts : []).filter((fact) => typeof fact === "string" && fact !== "").join("\n").slice(0, MAX_FACTS);
  const blocks = {};
  let left = room;
  if (list.includes("date") && today !== "") {
    blocks.date = `<today>${today}</today>`;
    left -= blocks.date.length + 2;
  }
  if (list.includes("groupBrief") && known !== "") {
    blocks.groupBrief = `<now>\n${known}\n</now>`;
    left -= blocks.groupBrief.length + 2;
  }
  const chat = String(history ?? "").trim();
  const reads = chat !== "" && list.some((entry) => HISTORY_ENTRY.test(entry) || entry === "recent");
  const trains = list.map((entry) => TRAIN_ENTRY.exec(entry)).filter(Boolean);
  if (trains.length > 0 && left > TAGS) {
    const examples = examplesWithin(trains, training, reads ? Math.floor(left / 2) : left - TAGS);
    if (examples !== "") {
      blocks.train = examples;
      left -= examples.length + 2;
    }
  }
  if (reads && left > TAGS) {
    const shown = newestOf(chat, left - TAGS);
    if (shown !== "") blocks.history = `<chat-history>\n${shown}\n</chat-history>`;
  }
  // Each block where its first entry runs (`texModuleChange.cjs` `runOrder`): what changes less goes first, so the cache reads it.
  const order = [];
  for (const entry of runOrder(list)) {
    const key = TRAIN_ENTRY.test(entry) ? "train" : HISTORY_ENTRY.test(entry) || entry === "recent" ? "history" : entry;
    if (blocks[key] !== undefined && !order.includes(key)) order.push(key);
  }
  return order.map((key) => blocks[key]).join("\n\n");
}
