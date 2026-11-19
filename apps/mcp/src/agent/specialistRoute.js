/**
 * THE SPECIALIST ROUTER'S QUESTION: WHICH DOOR A TURN GOES THROUGH (`graph/nodes/router.js`, `doorTurn.js`).
 *
 * Clef reads the text, beside the Door, with the Shape gate's read when it had one: one choice, quick, read, act or
 * job. The state is what Clef needs to pick and nothing more: where the text came (a 1:1 or a group), what started the
 * turn (a text they sent, a check-in Tex runs on its own, a routine on schedule), the first read of it when there is
 * one, and the text itself, cut at `MAX_TEXT`. Clef never writes words; a pick it can't make is no route.
 */

import { ROUTE_AT } from "./doorTools.js";

/** The most of their text the router reads. */
const MAX_TEXT = 2_000;

/** The routes a router may pick, in the order they are offered. */
export const ROUTES = Object.freeze(["quick", "read", "act", "job"]);

const TRIGGERS = {
  text: "a text they sent",
  checkin: "a check-in Tex runs on its own, its text carrying what it found",
  routine: "a routine Tex runs on schedule",
};

/** The most recent chat lines the router reads before the text, oldest first, each cut at `MAX_LINE`. */
const MAX_LINES = 8;
const MAX_LINE = 240;

const QUESTION = {
  type: "choice",
  instructions:
    "Tex is an assistant people text, with their notes, mail, calendar, the web and tools. Which kind of answer does this turn need? " +
    "Read the text in the light of the recent chat before it: a short reply or a correction takes the route of what it agrees to, changes or asks for. " +
    "Pick quick when the answer comes from the chat itself, what the trigger says, or what anyone would know. " +
    "Pick read when something stored of theirs or on the web has to be read first. Pick act when something has to change. " +
    "Pick job when the work is long. When unsure between quick and read, pick read.",
  criteria: {
    quick: "answered from the chat, the trigger's own text or what anyone would know: a reply, an opinion, a joke, a question back, a quick yes, asking what is missing before doing anything, or a heads-up whose facts the check-in or routine text already carries (an email or event it quotes) even when it names mail or the calendar; nothing to look up, nothing to change",
    read: "first read something stored of theirs or on the web (a note, an email, the calendar, a chat's records, a web page), then answer, including checking what they say happened against the record; nothing changes",
    act: "change something: save or edit a note, a setting, a calendar event, a reminder; draft or send an email or a text; make a picture; telling Tex to behave differently from now on (that saves a preference); changing a draft Tex just showed, or a yes or send to one; including a lookup that ends in a change or a draft to confirm",
    job: "long or many-step work that takes minutes: research across several sites, finding or comparing prices or options from several places however it is asked, finding new people or options, gathering from many sources before writing, a task done on a website; a yes to such work Tex offered, or a text that steers a job Tex is already on; Tex says it's on it and comes back with the result",
  },
};

const lineOf = (line) => {
  const who = String(line?.who ?? "").trim() || "someone";
  const text = String(line?.text ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? "" : `${who}: ${text.length > MAX_LINE ? text.slice(0, MAX_LINE) + "…" : text}`;
};

/**
 * The router's state and question for one turn: `{ state, questions }`. `shape` is the Shape gate's read, when it had
 * one; `recent` the chat's last lines before this text, oldest first, as `{ who, text }` (Tex's own as who "Tex").
 */
export function routeRequest({ question, group = false, trigger = "text", shape = null, recent = [] } = {}) {
  const where = group ? "a group chat Tex is in" : "a one-to-one chat with Tex";
  const what = TRIGGERS[trigger] ?? TRIGGERS.text;
  const first = shape
    ? `<first-read>\nhow it ends: ${shape.ending} (sure ${Math.round(Number(shape.endingSure ?? 0) * 100)}%)\nan order to do something: ${Number(shape.order ?? 0) >= 0.5 ? "yes" : "no"}\nanswer is in something stored: ${Number(shape.records ?? 0) >= 0.5 ? "yes" : "no"}\n</first-read>\n\n`
    : "";
  const lines = (Array.isArray(recent) ? recent : []).slice(-MAX_LINES).map(lineOf).filter(Boolean);
  const before = lines.length > 0 ? `<recent-chat>\n${lines.join("\n")}\n</recent-chat>\n\n` : "";
  const state = `<where>${where}</where>\n<trigger>${what}</trigger>\n\n${before}${first}<text>\n${String(question ?? "").slice(0, MAX_TEXT)}\n</text>`;
  return { state, questions: { route: QUESTION } };
}

const sure = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

/** The router's answer as `{ route, sure }`, or null when it named no route of the four. */
export function readRoute(answers) {
  const pick = answers?.route;
  if (typeof pick?.choice !== "string" || !ROUTES.includes(pick.choice)) return null;
  return { route: pick.choice, sure: sure(pick.confidence) };
}

/** Whether a router's read is sure enough to send the turn to its door. */
export const sureEnough = (read) => typeof read?.sure === "number" && read.sure >= ROUTE_AT;
