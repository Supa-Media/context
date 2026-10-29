/**
 * THEIR SLEEP LINES AND CHECK-IN ANSWERS ARE THEIR DATA, AND GET LOGGED
 * (Tex's self-review, 2026-10-28 and 2026-10-29; @context-lc
 * areas/tex-reviews/themes/sleep-log-wrong.md and time-audit-drops-plans.md).
 *
 * A person's phone Shortcut texts Tex a sleep line each morning ("I slept
 * from <date> at <time> to <date> at <time>, for a total of: <hours>,
 * <minutes>."), and an every-3-hours routine asks what the last three hours
 * went to. On those two days Tex:
 *
 *   1. took sleep totals the person's automation sent ("Total sleep time
 *      is …", "You have slept for a total of: …") for texts it had sent
 *      itself, and apologised for sending them;
 *   2. quoted a watch email's night as real when its total was more than
 *      twice the time between its asleep and up, and had logged a sleep of
 *      over 29 hours before;
 *   3. answered the check-in's answer (what they'd work on till 10, then
 *      after, and when they'd sleep) with "Will do." and saved nothing, so
 *      the next check-in knew nothing of it.
 *
 * So a sleep line in their text is read by the gateway before the model sees
 * it (`sleepLineNote`): whose it is, what it says, and whether it adds up as
 * one night. And the answer is checked before it goes (`replyChecks.js`): a
 * figure it takes back that only they ever sent (`disownsTheirFigure`), a
 * night it quotes that its own times contradict (`impossibleNight`), and a
 * check-in answer met with a bare "Will do." and no write (`dropsCheckInAnswer`).
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Mar 3, 2026 at 11:50 PM", "March 2, 2026 at 1:10 AM", "12:10 AM", "7:15": a moment as a sleep line or an answer writes it. */
const MOMENT = /(?:\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\s+at\s+)?\b(\d{1,2}):(\d{2})(?:\s*([ap])\.?m\b)?/gi;
/** "7 hours, 5 minutes", "13.5 hours", "8 hr 26 min", "7h 22m", "45 minutes". */
const DURATION = /\b(?:(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b(?:,?\s*(?:and\s+)?(\d+)\s*(?:minutes?|mins?|m)\b)?|(\d+)\s*(?:minutes?|mins?)\b)/gi;

/** The most one night's sleep can be: anything longer is two nights run together, or a broken read. */
const LONGEST_NIGHT = 16 * 60;
/** How far a total may run past the time between asleep and up before it can't be true. */
const SLACK = 15;

/** A text that is a sleep line: their automation's, or pasted. */
const SLEEP_LINE = /\bI slept from\b|\bsleep log\b|\bslept for a total\b|\btotal sleep\b|\bsleep time\b|\byou have slept\b/i;
/** The automation's line with nothing filled in: "I slept from  to , for a total of: ." */
const BLANK_LINE = /\bslept from\s+to\s*,/i;

function minutesOf(match) {
  if (match[3] !== undefined) return Number(match[3]);
  return Math.round(Number(match[1]) * 60) + (match[2] !== undefined ? Number(match[2]) : 0);
}

/** Each duration in a text, in minutes, in order. */
export function durationsIn(text) {
  return [...String(text ?? "").matchAll(DURATION)].map(minutesOf);
}

function momentsIn(text) {
  return [...String(text ?? "").matchAll(MOMENT)].map((match) => {
    const [, month, day, year, hours, minutes, half] = match;
    const clock = (Number(hours) % 12) * 60 + Number(minutes) + (half?.toLowerCase() === "p" ? 12 * 60 : 0);
    const dated = month !== undefined ? Date.UTC(Number(year), MONTHS.indexOf(month.toLowerCase()), Number(day)) / 60000 : null;
    return { said: match[0].trim(), clock, half: half !== undefined, at: dated === null ? null : dated + clock };
  });
}

/**
 * The minutes from one moment to the next, as the spans they could be: one
 * exact span when both carry a date, else each reading of a clock without a
 * date or an am/pm ("12:10 to 7:15 am" is 7h 5m or 19h 5m).
 */
function spansBetween(from, to) {
  if (from.at !== null && to.at !== null) return [to.at - from.at];
  const day = 24 * 60;
  const base = (((to.clock - from.clock) % day) + day) % day;
  return from.half && to.half ? [base] : [base % (12 * 60), (base % (12 * 60)) + 12 * 60];
}

function hoursAndMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} minutes` : rest === 0 ? `${hours} hours` : `${hours} hours ${rest} minutes`;
}

/**
 * A sleep line read for sense: `{ blank, from, to, total, problems }`, or
 * null when the text isn't one. `problems` names each way it isn't one night.
 */
export function readSleepLine(text) {
  const said = String(text ?? "");
  if (!SLEEP_LINE.test(said) || said.length > 600) return null;
  const moments = momentsIn(said);
  const [total] = durationsIn(said);
  if (BLANK_LINE.test(said) || (moments.length === 0 && total === undefined)) return { blank: true, from: null, to: null, total: null, problems: [] };
  const [from, to] = moments;
  const problems = [];
  const spans = from !== undefined && to !== undefined ? spansBetween(from, to) : [];
  const span = spans.length === 1 ? spans[0] : null;
  if (span !== null && span <= 0) problems.push("it wakes up before it falls asleep");
  if (span !== null && span > LONGEST_NIGHT) problems.push(`from asleep to up is ${hoursAndMinutes(span)}, more than one night`);
  if (total !== undefined && total > LONGEST_NIGHT) problems.push(`a total of ${hoursAndMinutes(total)} is more than one night's sleep`);
  else if (total !== undefined && spans.length > 0 && spans.every((each) => each > 0 && total > each + SLACK)) {
    problems.push(`its total, ${hoursAndMinutes(total)}, is longer than the time between asleep and up`);
  }
  return { blank: false, from: from?.said ?? null, to: to?.said ?? null, total: total ?? null, problems };
}

/**
 * What the model is told about a sleep line in their text, after the text, or
 * "" when there is none.
 */
export function sleepLineNote(text) {
  const line = readSleepLine(text);
  if (line === null) return "";
  const whose =
    "(About that text: it is a sleep line from their own phone automation, or one they pasted. It is their data, " +
    'never a text you sent, even when it says "you", so never apologise for it or call it yours.';
  if (line.blank) return `${whose} It came through blank, so there is nothing in it to log. Don't ask again for times they already gave you today.)`;
  const reads = [line.from && `asleep ${line.from}`, line.to && `up ${line.to}`, line.total !== null && `total ${hoursAndMinutes(line.total)}`].filter(Boolean).join(", ");
  if (line.problems.length > 0) {
    return (
      `${whose} It reads: ${reads}. It doesn't add up: ${line.problems.join("; ")}. Don't log it, and don't quote its figures as a real night. ` +
      "Say in one line what doesn't add up. Use times they already gave you for that night if they did; otherwise ask once for when they fell asleep and woke.)"
    );
  }
  return (
    `${whose} It reads: ${reads}. Before you log it, compare it with the last night in their log: the same night again is a stale line, so say so in one line and don't log it twice. ` +
    "Otherwise log it, replacing an older line for the same night, and say what you logged in one line. Never work out or quote a total the line doesn't give.)"
  );
}

/** An answer that takes a figure back as one it sent: "I shouldn't have sent it", "at the end of my last text", "my earlier '12 hours 40 minutes' was wrong". */
const DISOWNS_SENDING =
  /\bI\s+should(?:\s*n['’]?t|\s+not)\s+have\s+(?:sent|texted|said|given)\b|\b(?:of|in|from)\s+my\s+(?:last|earlier|previous)\s+(?:text|message|reply)\b|\bmy\s+(?:earlier|last|previous)\s+["“']?[^"”'.!?\n]{0,40}["”']?\s+was\s+(?:wrong|a mistake|made up)\b|\bI\s+(?:sent|texted)\s+(?:you\s+)?(?:that|it|this|those)\s+by\s+mistake\b/i;

/** How many of the latest texts count, theirs and Tex's. */
const RECENT = 8;

/**
 * Whether the answer takes back, as its own, a duration that only they sent:
 * one in their text or their recent texts, and in none of Tex's recent texts.
 */
export function disownsTheirFigure(answer, { question = "", history = [] } = {}) {
  const said = String(answer ?? "");
  if (!DISOWNS_SENDING.test(said)) return false;
  const recent = (Array.isArray(history) ? history : []).slice(-RECENT).filter((turn) => typeof turn?.text === "string");
  const theirs = new Set([question, ...recent.filter((turn) => turn.role === "user").map((turn) => turn.text)].flatMap(durationsIn));
  const ours = new Set(recent.filter((turn) => turn.role === "assistant").flatMap((turn) => durationsIn(turn.text)));
  return durationsIn(said).some((minutes) => theirs.has(minutes) && !ours.has(minutes));
}

export const THEIR_FIGURE_NOTICE =
  "Before this goes: your answer takes back a figure as if you had texted it, but it came from them: their own texts have it, and none of yours do. " +
  'Texts they paste, and the lines their phone\'s automations send (sleep, screen time), are their data, even when they say "you". ' +
  "Don't apologise for it or call it yours. Answer about it as theirs: if it doesn't add up, say so in one line; if it does, log it and say what you logged.";

/** Words that say the night it gives is not real: "doesn't fit", "not one night", "that's wrong". */
const REJECTS = /\b(?:does\s*n['’]?t|doesn['’]t|can['’]?t|cannot|is\s*n['’]?t|isn['’]t|not)\s+(?:fit|add up|be (?:right|real|one night)|right|real|possible|one night|using)\b|\bimpossible\b|\bwrong\b|\bbroken\b/i;
const SLEEP_WORDS = /\b(?:asleep|slept|sleep|woke|wake|bed)\b/i;

/**
 * Whether the answer quotes a night whose own times contradict its total
 * ("asleep 1:10 AM, up 6:50 AM, 13.5 hours") or that is longer than a night,
 * as real. A sentence that says it doesn't fit is the right answer, not this.
 */
export function impossibleNight(answer) {
  for (const sentence of String(answer ?? "").split(/(?<=[.!?])\s+|\n+/)) {
    if (!SLEEP_WORDS.test(sentence) || REJECTS.test(sentence)) continue;
    const moments = momentsIn(sentence);
    if (moments.length < 2) continue;
    const [total] = durationsIn(sentence.slice(sentence.indexOf(moments[1].said) + moments[1].said.length));
    if (total === undefined) continue;
    const spans = spansBetween(moments[0], moments[1]).filter((span) => span > 0);
    if (total > LONGEST_NIGHT || spans.every((span) => total > span + SLACK)) return true;
  }
  return false;
}

export const IMPOSSIBLE_NIGHT_NOTICE =
  "Before this goes: your answer gives a night of sleep whose total doesn't fit its own times (or runs past 16 hours), as if it were real. " +
  "Work out the time between asleep and up yourself. If the source's total is longer than that, the source is wrong: say so in one line, don't quote its total as their night, and don't log it. " +
  "Use the times they gave you, or ask once when they fell asleep and woke.";

/** The line a routine's or a check-in's text is kept under (`conversation.js`, `heartbeat.js`). */
const SCHEDULED_TEXT = /^\(Not a text from them\. (?:Your routine \S+ ran on its schedule|This was your own check-in)/;

/** How many of Tex's latest texts a check-in may be among and still be what they're answering. */
const CHECK_IN_REACH = 3;

/**
 * Whether one of the last few texts Tex sent them came from a routine or a
 * check-in. Not only the last: on 2026-10-28 the plan came two texts after
 * the routine's question, once Tex had answered their first reply to it.
 */
export function answersACheckIn(history) {
  const turns = Array.isArray(history) ? history : [];
  let seen = 0;
  for (let i = turns.length - 1; i > 0 && seen < CHECK_IN_REACH; i -= 1) {
    if (turns[i]?.role !== "assistant") continue;
    seen += 1;
    if (turns[i - 1]?.role === "user" && SCHEDULED_TEXT.test(String(turns[i - 1].text ?? ""))) return true;
  }
  return false;
}

/** A plan or a stretch of their day: "till 10", "at 11:30", "after 10", "9pm", "don't bother me". */
const PLAN =
  /\b(?:till|til|until|by|at|after|before|from|around)\s+(?:\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?|noon|midnight|lunch|dinner|tonight)\b|\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\b|\bdon['’]?t\s+(?:bother|text|ping|message|disturb)\s+me\b|\b(?:working on|tonight)\b/i;
/** A reply that only acknowledges: "Will do.", "Got it", "Ok", "Sounds good", "Noted.". */
const BARE_ACK = /^(?:will do|got it|ok(?:ay)?|sounds good|noted|sure|on it|perfect|great|cool|understood|nice)\b[\s.!👍]*$/iu;
/** The calls that keep what they said: a note saved, a fact remembered, their calendar changed. */
const KEEPS = new Set(["write", "write_note", "edit_note", "append_note", "update_note", "remember", "calendar_event"]);

/**
 * Whether their text answers a routine's or a check-in's text with a plan,
 * and the answer only acknowledges it with nothing saved this turn.
 */
export function dropsCheckInAnswer(answer, { question = "", history = [], steps = [] } = {}) {
  const asked = String(question ?? "");
  if (!answersACheckIn(history) || !PLAN.test(asked) || /\?\s*$/.test(asked.trim())) return false;
  if (!BARE_ACK.test(String(answer ?? "").trim())) return false;
  return !steps.some((step) => step?.ok !== false && KEEPS.has(step?.name));
}

export const CHECK_IN_ANSWER_NOTICE =
  "Before this goes: they answered your scheduled check-in with what they're doing or plan to do, and nothing in this turn saved it, so the next check-in won't know. " +
  "Save it where that routine or check-in keeps its log (read the routine's note if you don't know where): each block with the times they gave, " +
  'and a "don\'t bother me until 5" as a line the next check-in reads, so it stays quiet till then. ' +
  'Then say in one line what you logged ("Logged: writing till 10, the videos till 11:30, then sleep."). ' +
  "If their text isn't an answer to the check-in, send your answer again as it was.";
