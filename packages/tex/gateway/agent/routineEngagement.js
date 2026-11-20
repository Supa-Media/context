/**
 * WHETHER A ROUTINE STILL MATTERS TO THEM (Dev2, 2026-11-16: "routines shouldn't act as a message you've sent, they
 * should act like routines, and the front door should know its a routine and reason if the routine is relevant or
 * stale, and ask the user if they still want that routine if they see it hasnt been interacted with").
 *
 * Read from what is already kept: the routine's own runs (`routine.js` `readRuns`: each run's time, outcome and words)
 * and the chat's texts (`conversation.js`, each of their texts with its time). A run they answered is one followed by a
 * text of theirs (a reply or a tapback, which the chat keeps as their text) before the routine's next run, or within a
 * day when there is none. Nothing here decides; it says what happened, and the Front door judges from it.
 */
import { localStamp } from "./localNow.js";
import { DONE_WORD } from "./routine.js";

/** A run that texted them, the only kind they could have answered. */
const TEXTED = new Set(["answered", "finished"]);
/** How long after a run a text of theirs still counts as their answer to it, when the routine runs no sooner. */
const ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many texts in a row with no answer make a routine worth asking about. */
export const UNANSWERED_ASK = 3;
/** A person's text the chat keeps for Tex's own run (a routine, a check-in), which is never theirs. */
const BY_ITSELF = /^\(Not a text from them\./;

/** The times of their own texts, oldest first, from the chat's texts as `readConversation` gives them. */
function theirTimes(history) {
  return (Array.isArray(history) ? history : [])
    .filter((turn) => turn?.role === "user" && Number.isFinite(turn.at) && !(typeof turn.text === "string" && BY_ITSELF.test(turn.text)))
    .map((turn) => turn.at)
    .sort((a, b) => a - b);
}

/**
 * `{ texted, unanswered, lastAnsweredAt, since }`: how many of its runs texted them, how many of the newest of those in
 * a row went unanswered, when they last answered one (null: never, as far as the chat shows), and when the unanswered
 * streak began (null with none).
 */
export function routineEngagement(runs, history) {
  const sent = (Array.isArray(runs) ? runs : []).filter((run) => TEXTED.has(run?.outcome) && Number.isFinite(run.at)).sort((a, b) => a.at - b.at);
  const theirs = theirTimes(history);
  const answered = (run, i) => {
    const until = i + 1 < sent.length ? Math.min(sent[i + 1].at, run.at + ANSWER_WINDOW_MS) : run.at + ANSWER_WINDOW_MS;
    return theirs.some((at) => at > run.at && at <= until);
  };
  let unanswered = 0;
  let since = null;
  let lastAnsweredAt = null;
  for (let i = sent.length - 1; i >= 0; i -= 1) {
    if (answered(sent[i], i)) {
      lastAnsweredAt = sent[i].at;
      break;
    }
    unanswered += 1;
    since = sent[i].at;
  }
  return { texted: sent.length, unanswered, lastAnsweredAt, since };
}

/**
 * What the Front door is told about the routine's standing, or "" when it has texted them too few times to say. Every
 * run is told to weigh whether the routine still fits; one whose last `UNANSWERED_ASK` texts went unanswered is told so,
 * and to ask in a line whether they still want it, or end it when it is plainly over.
 */
export function engagementSection(engagement, timeZone) {
  const { texted, unanswered, lastAnsweredAt, since } = engagement ?? {};
  if (!(texted > 0)) return "";
  const stamp = (at) => (timeZone ? localStamp(at, timeZone) : new Date(at).toISOString());
  const lines = [
    `This routine has texted them ${texted} time${texted === 1 ? "" : "s"} that you can see. ` +
      (lastAnsweredAt === null ? "They have not answered or reacted to any of them." : `They last answered or reacted to one on ${stamp(lastAnsweredAt)}.`),
    "Before you text, judge whether this routine is still relevant to them or has gone stale: what it watches is over or past, it only repeats what they already know, or it no longer fits what they have said lately.",
  ];
  if (unanswered >= UNANSWERED_ASK) {
    lines.push(
      `Its last ${unanswered} texts, since ${stamp(since)}, got no answer or reaction. ` +
        `If it is plainly over, start your answer with ${DONE_WORD} and say in a line that you stopped it. ` +
        "Otherwise text what it found, if anything is worth telling, and ask in one short line whether they still want this routine.",
    );
  }
  return lines.join(" ");
}
