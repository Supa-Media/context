/**
 * A routine's turn: a note under `tex/routines/` (or `routines/`, where
 * routines lived first) read and carried out on its schedule, as the person
 * who wrote it (`docs/decisions/routines.md`).
 *
 * The control plane decides *when*; this file decides nothing about time. It
 * re-reads the routine at the moment it runs, through the same `read_note` a
 * client's call goes through, so a routine whose writer lost sight of it, that
 * was paused, moved out of its schedule folder or deleted since it was queued
 * does not run. What was due an hour ago is not what is true now.
 *
 * What it answered is kept beside it, at a plumbing path in the same bucket
 * (`routineRunsKey`), never in the control plane: an answer is note content.
 */

import {
  describeSchedule,
  frontMatter,
  routineFromPath,
  routineRunsKey,
  routineSettings,
  wallClock,
} from "../../../../packages/shared/src/routines.cjs";
import { getWithLegacyFallback } from "../storageLayout.js";
import { MAX_QUESTION_LENGTH } from "./turn.js";
import { readMailHealth, routineMailSection } from "./mailHealth.js";
import { QUIET_WORD, saysQuiet, spokenToThem } from "./checkInGuards.js";
import { readConversation } from "./conversation.js";

/** The routine runner's first-party client (`apps/convex`). Decided by the grant. */
export const ROUTINES_CLIENT_ID = "context_routines";

/** What a run that has nothing to say answers, and nothing else. */
export const SKIP_WORD = QUIET_WORD;

/** What a run whose `until:` has come true starts its answer with. */
export const DONE_WORD = "DONE:";

/** The one write a run is offered: a change to the person's own calendar (`calendarGate.js`). */
export const ROUTINE_CALENDAR_TOOL = "calendar_event";

export const MAX_RUNS_KEPT = 20;
export const MAX_RUN_TEXT = 2000;
const MAX_LAST_RUN_IN_PROMPT = 1500;

/** Refused, with a code the runner reads. Never the note's text. */
export class RoutineRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The path a routine request names, or a refusal. */
export function routinePathFrom(value) {
  const path = typeof value?.path === "string" ? value.path : null;
  if (path === null) throw new RoutineRefusal("invalid_request", "Name the routine's path.");
  const found = routineFromPath(path);
  if (found === null || found.kind !== "routine") {
    throw new RoutineRefusal("not_a_routine", "That note isn't in a routine's schedule folder.");
  }
  return path;
}

/** The note's text below its front matter, or all of it when it has none. */
export function routineBody(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text.trim();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "---" || line === "...") return lines.slice(i + 1).join("\n").trim();
  }
  return text.trim();
}

/**
 * Read the routine through the caller's own dispatcher, so the writer's
 * access decides whether it runs. `read_note` answers with header lines, a
 * blank line, then the note.
 */
export async function loadRoutine(callTool, path) {
  const result = await callTool("read_note", { path });
  const text = result?.content?.[0]?.text;
  if (result?.isError === true || typeof text !== "string") {
    throw new RoutineRefusal("routine_gone", "That routine is gone, or its writer can't see it any more.");
  }
  const split = text.indexOf("\n\n");
  const header = split === -1 ? text : text.slice(0, split);
  // A note that has moved is not the routine that was queued: the control
  // plane re-reads the folder and schedules it under its new path, or not.
  if (/^moved_from:/m.test(header) || !header.split("\n").includes(`path: ${path}`)) {
    throw new RoutineRefusal("routine_gone", "That routine has moved.");
  }
  if (/^kind: drawing$/m.test(header)) {
    throw new RoutineRefusal("not_a_routine", "A drawing can't be a routine.");
  }
  const note = split === -1 ? "" : text.slice(split + 2);
  const { cadence } = routineFromPath(path);
  const { settings, problems } = routineSettings(note, cadence);
  // `fields` is every front matter line, for the routines that read more than a schedule (`supervise.js`).
  return { path, cadence, settings, problems, body: routineBody(note), fields: frontMatter(note) };
}

function isTimeZone(value) {
  if (typeof value !== "string" || value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The file's own zone, else the account's, else UTC. */
export function routineTimeZone(settings, fallback) {
  if (settings?.timeZone) return settings.timeZone;
  return isTimeZone(fallback) ? fallback : "UTC";
}

function localTime(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  const date = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  const time = `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
  return `${date} ${time} (${timeZone})`;
}

function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** How many of the last texts with them a run is shown, and how much of each. */
const RECENT_TEXTS_SHOWN = 8;
const RECENT_TEXT_CHARS = 300;
const ROUTINE_LINE = /^\(Not a text from them\. Your routine (\S+) ran/;
const CHECK_IN_LINE = /^\(Not a text from them\. This was your own check-in/;

/** Who sent the assistant's text at `i`: a routine (this one or another), a check-in, or a reply. */
function senderOf(turns, i, path) {
  const before = turns[i - 1]?.role === "user" ? String(turns[i - 1].text ?? "") : "";
  const from = ROUTINE_LINE.exec(before)?.[1];
  if (from === path) return "You (this routine, an earlier run)";
  if (from) return `You (your routine ${from})`;
  return CHECK_IN_LINE.test(before) ? "You (a check-in)" : "You";
}

/**
 * The last texts with them, for a run to read before it texts (the owner,
 * 2026-10-23: a one-off reminder and an every-3-hours one about the same call
 * both texted at 9:00). Tex's own texts say which routine or check-in sent
 * them. A turn that read something from outside is left out, so a routine's
 * question is never someone else's words.
 */
export function recentTextsSection(history, path) {
  const turns = Array.isArray(history) ? history : [];
  const lines = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (typeof turn?.text !== "string" || turn.tainted === true) continue;
    if (turn.role === "user" && (ROUTINE_LINE.test(turn.text) || CHECK_IN_LINE.test(turn.text))) continue;
    const who = turn.role === "user" ? "Them" : senderOf(turns, i, path);
    lines.push(`${who}: ${clip(turn.text.replace(/\s+/g, " ").trim(), RECENT_TEXT_CHARS)}`);
  }
  const shown = lines.slice(-RECENT_TEXTS_SHOWN);
  if (shown.length === 0) return "";
  return (
    `Your last texts with them, oldest first:\n${shown.join("\n")}\n\n` +
    `If another routine or a check-in above already told them what this run would, or they already said it is done, answer ${SKIP_WORD}.`
  );
}

/**
 * The turn's question: what this is, when it is, what it said last time, and
 * the routine's own words. The routine's words go last and are clipped to fit,
 * so the framing above them is never the part that is cut.
 */
export function routineQuestion(routine, { now, timeZone, lastRun, mail = "", recent = "" }) {
  const lines = [
    "This is a scheduled routine, not a text from a person. Nobody is waiting on this turn.",
    `Routine: ${routine.path}. Schedule: ${describeSchedule(routine.cadence, routine.settings)}. It is now ${localTime(now, timeZone)}.`,
  ];
  if (lastRun && typeof lastRun.text === "string" && lastRun.text !== "") {
    lines.push(`Last time (${new Date(lastRun.at).toISOString()}) you answered:\n${clip(lastRun.text, MAX_LAST_RUN_IN_PROMPT)}`);
  }
  if (recent) lines.push(recent);
  if (routine.cadence.unit === "once") {
    lines.push(
      "This is a one-off reminder the person set: it runs this once. Text them the reminder itself, " +
        "in a line or two with any link it has, the way a friend would.",
    );
  }
  if (routine.settings.until) {
    lines.push(
      `This routine stops once this is true: ${routine.settings.until}. ` +
        `If it is true now, start your answer with ${DONE_WORD} and say what happened.`,
    );
  }
  // The owner, 2026-10-23: an every-5-minutes check said "Planning Center's connected." while every read failed,
  // then "I couldn't stop this check myself" and sent a pause for approval.
  lines.push(
    `To stop this routine (its job is done, it can't be done, or they asked to stop it), start your answer with ${DONE_WORD}: ` +
      "it stops at once. Never send a change to it for approval. " +
      "Say something worked only when a call in this run showed it working: an app listed as connected is not a read that worked.",
  );
  // A review, 2026-10-26: an hourly "retry adding Tabi's birthday" routine had no calendar and texted
  // "I can't reach your calendar from this chat right now ... Text me again later", every hour.
  lines.push(
    "You can change their own calendar in this run (send action calendar): add, edit, move or cancel an event nobody else is on, at once. " +
      "A change that would tell a guest can't be made while nobody is on the line: text them the change in one line, and their yes makes it. " +
      "Never ask them to text you again, try later, or do it themselves: do it now, or say what stopped it and that this routine tries again next run.",
    // The same review: a daily reminder texted "This is the last one." and went on.
    `Say a reminder is the last one only when you start your answer with ${DONE_WORD}, which ends it; otherwise never say it is the last or that they end.`,
  );
  if (mail) lines.push(mail);
  lines.push(
    // The owner, 2026-10-23: "Remind them to call Apple ..." went out word for word, and "... no status update. SKIP" with it.
    "Your answer is texted to them exactly as you write it. Speak to them (you, your), never about them, " +
      'and never read the routine\'s instructions back: a routine that says "Remind them to call the bank" texts "Reminder: call the bank".',
    `Do what the routine below asks. If there is nothing worth telling this time, answer with exactly ${SKIP_WORD} and nothing else: no reason, no other words.`,
    "Routine:",
  );
  const framing = `${lines.join("\n\n")}\n\n`;
  return framing + clip(routine.body, Math.max(0, MAX_QUESTION_LENGTH - framing.length));
}

/**
 * The question for a run now: in the routine's zone, with what it said last
 * time, the last texts with them, and any of the person's mailboxes that
 * stopped syncing (`mailHealth.js`), which a routine is told and never texts
 * for alone.
 */
export async function routineRunQuestion(store, routine, runs, givenTimeZone) {
  const mailboxes = await readMailHealth(store);
  const now = Date.now();
  return routineQuestion(routine, {
    now,
    timeZone: routineTimeZone(routine.settings, givenTimeZone),
    lastRun: runs.findLast((run) => run.outcome === "answered" || run.outcome === "finished"),
    mail: routineMailSection(mailboxes, now),
    recent: recentTextsSection(await readConversation(store, "texts", { entries: RECENT_TEXTS_SHOWN * 2 }), routine.path),
  });
}

/**
 * How a run ended, read off its answer, and what it texts: a SKIP that closes
 * an explanation is still quiet, and instructions read back are said to them
 * (`checkInGuards.js`).
 */
export function runOutcome(answer, { routine = null, runs = [] } = {}) {
  const trimmed = typeof answer === "string" ? answer.trim() : "";
  if (saysQuiet(trimmed)) return { outcome: "skipped", text: "" };
  if (trimmed.toUpperCase().startsWith(DONE_WORD)) {
    return { outcome: "finished", text: spokenToThem(trimmed.slice(DONE_WORD.length)) };
  }
  const text = withoutLastClaim(spokenToThem(trimmed));
  return repeatsItself(routine, runs, text) ? { outcome: "skipped", text: "" } : { outcome: "answered", text };
}

/** A sentence that says this run is the last, or that no more reminders come. */
const LAST_CLAIM =
  /\b(?:this|that|it)(?:\s+is|'s|\u2019s)\s+(?:the|my|your)\s+(?:last|final)(?:\s+(?:one|reminder|time|text)\b|\s*[.!?]*$)|\bno\s+more\s+reminders\b|\bfinal\s+reminder\b/i;

/**
 * A run that goes on saying it is the last (a review, 2026-10-26: a daily
 * reminder texted "This is the last one." and the person had to ask for the
 * rest of the week). Only a run that ends its routine (`DONE_WORD`) may; any
 * other has that sentence taken off, and "Final reminder:" becomes "Reminder:".
 */
export function withoutLastClaim(text) {
  const said = String(text ?? "").replace(/^(?:last|final)\s+reminder\b/i, "Reminder");
  const sentences = said.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => !LAST_CLAIM.test(sentence));
  return kept.length === 0 || kept.length === sentences.length ? said : kept.join(" ");
}

/**
 * The calendar tool a routine run is offered, when the grant offered it: their
 * own events change at once, and nothing that tells a guest goes
 * (`calendarGate.js`). No other write (`docs/decisions/routines.md`).
 */
export function routineCalendarTools(offered) {
  return (Array.isArray(offered) ? offered : []).filter((tool) => tool?.name === ROUTINE_CALENDAR_TOOL);
}

const sameWords = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Whether a routine that runs more than once an hour would text exactly what
 * its last answer did (the owner, 2026-10-23: an every-5-minutes check texted
 * "Planning Center's connected." again and again). A reminder every few hours
 * is meant to repeat, so only minute cadences are held to this.
 */
export function repeatsItself(routine, runs, text) {
  if (routine?.cadence?.unit !== "minute" || !Array.isArray(runs)) return false;
  const last = runs.findLast((run) => run.outcome === "answered" || run.outcome === "finished");
  return last !== undefined && sameWords(last.text) === sameWords(text);
}

function isRun(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.at === "number" &&
    typeof value.outcome === "string" &&
    typeof value.text === "string"
  );
}

/** The routine's past runs, newest last. Unreadable is empty, never an error. */
export async function readRuns(store, path) {
  try {
    const object = await getWithLegacyFallback(store, routineRunsKey(path));
    if (!object) return [];
    const parsed = JSON.parse(await object.text());
    return Array.isArray(parsed?.runs) ? parsed.runs.filter(isRun).slice(-MAX_RUNS_KEPT) : [];
  } catch {
    return [];
  }
}

/** Append one run, keeping the newest `MAX_RUNS_KEPT`. */
export async function recordRun(store, path, runs, run) {
  const entry = { at: run.at, outcome: run.outcome, text: clip(run.text ?? "", MAX_RUN_TEXT) };
  const kept = [...runs, entry].slice(-MAX_RUNS_KEPT);
  await store.put(routineRunsKey(path), JSON.stringify({ version: 1, runs: kept }));
}

/** The note's text with `key: value` in its front matter, added or replaced. */
function withFrontMatterLine(text, key, value) {
  const lines = text.split("\n");
  const same = new RegExp(`^${key}\\s*:`, "i");
  if (lines[0]?.replace(/^\uFEFF/, "").trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "---" || line === "...") {
        const kept = lines.slice(1, i).filter((l) => !same.test(l.trim()));
        return [lines[0], ...kept, `${key}: ${value}`, ...lines.slice(i)].join("\n");
      }
    }
  }
  return `---\n${key}: ${value}\n---\n${text}`;
}

/** The note's text with `paused: yes` in its front matter, added or replaced. */
export function withPaused(text) {
  return withFrontMatterLine(text, "paused", "yes");
}

/** A one-off's text once it has run: `done:` says when, and keeps it from running again. */
export function withDone(text, when) {
  return withFrontMatterLine(text, "done", when);
}

/** Read a routine note for rewriting: its text below the header, and its etag. */
async function readForRewrite(callTool, path) {
  const read = await callTool("read_note", { path });
  const text = read?.content?.[0]?.text;
  if (read?.isError === true || typeof text !== "string") return null;
  const split = text.indexOf("\n\n");
  const etag = /^etag: (.+)$/m.exec(split === -1 ? text : text.slice(0, split))?.[1];
  return { note: split === -1 ? "" : text.slice(split + 2), etag };
}

/**
 * Mark a one-off as run, in place: the note stays where it was, as the record
 * of the reminder, and `done:` stops it (the owner, 2026-10-14: reminders are
 * notes anyone can see). Best effort, like `stopRoutine`; the control plane has
 * already moved a one-off's next run to never, so a note left unmarked does not
 * run twice.
 */
export async function finishOnce(callTool, path, { now, timeZone }) {
  try {
    const read = await readForRewrite(callTool, path);
    if (read === null) return "kept";
    const written = await callTool("write_note", {
      path,
      content: withDone(read.note, localTime(now, timeZone)),
      ...(read.etag ? { expected_etag: read.etag } : {}),
    });
    return written?.isError === true ? "kept" : "done";
  } catch {
    return "kept";
  }
}

/**
 * Stop a routine whose `until:` came true: archived, so it can be recovered,
 * and where the layout has no archive, paused in place. Best effort: a routine
 * that could not be stopped runs again and says DONE again, which is noisy but
 * not wrong.
 */
export async function stopRoutine(callTool, path) {
  try {
    // Read first: a shared workspace's archive and write both want the etag.
    const read = await readForRewrite(callTool, path);
    if (read === null) return "kept";
    const { note, etag } = read;
    const archived = await callTool("archive_note", { path, ...(etag ? { expected_etag: etag } : {}) });
    if (archived?.isError !== true) return "archived";
    const written = await callTool("write_note", {
      path,
      content: withPaused(note),
      ...(etag ? { expected_etag: etag } : {}),
    });
    return written?.isError === true ? "kept" : "paused";
  } catch {
    return "kept";
  }
}

/**
 * A run goes in the routine's history whatever became of it. Best effort: a
 * history that failed to save costs the next run its "last time", not this
 * one its answer.
 */
export async function keepRun(store, routine, runs, outcome, text) {
  try {
    await recordRun(store, routine.path, runs, { at: Date.now(), outcome, text });
  } catch {
    // See above.
  }
}
