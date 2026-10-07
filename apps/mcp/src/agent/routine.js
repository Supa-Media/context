/**
 * A routine's turn: a note under `routines/` read and carried out on its
 * schedule, as the person who wrote it (`docs/decisions/routines.md`).
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
  routineFromPath,
  routineRunsKey,
  routineSettings,
  wallClock,
} from "../../../../packages/shared/src/routines.cjs";
import { getWithLegacyFallback } from "../storageLayout.js";
import { MAX_QUESTION_LENGTH } from "./turn.js";

/** The routine runner's first-party client (`apps/convex`). Decided by the grant. */
export const ROUTINES_CLIENT_ID = "context_routines";

/** What a run that has nothing to say answers, and nothing else. */
export const SKIP_WORD = "SKIP";

/** What a run whose `until:` has come true starts its answer with. */
export const DONE_WORD = "DONE:";

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
  return { path, cadence, settings, problems, body: routineBody(note) };
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

/**
 * The turn's question: what this is, when it is, what it said last time, and
 * the routine's own words. The routine's words go last and are clipped to fit,
 * so the framing above them is never the part that is cut.
 */
export function routineQuestion(routine, { now, timeZone, lastRun }) {
  const lines = [
    "This is a scheduled routine, not a text from a person. Nobody is waiting on this turn.",
    `Routine: ${routine.path}. Schedule: ${describeSchedule(routine.cadence, routine.settings)}. It is now ${localTime(now, timeZone)}.`,
  ];
  if (lastRun && typeof lastRun.text === "string" && lastRun.text !== "") {
    lines.push(`Last time (${new Date(lastRun.at).toISOString()}) you answered:\n${clip(lastRun.text, MAX_LAST_RUN_IN_PROMPT)}`);
  }
  if (routine.settings.until) {
    lines.push(
      `This routine stops once this is true: ${routine.settings.until}. ` +
        `If it is true now, start your answer with ${DONE_WORD} and say what happened.`,
    );
  }
  lines.push(
    `Do what the routine below asks. If there is nothing worth telling this time, answer with exactly ${SKIP_WORD}.`,
    "Routine:",
  );
  const framing = `${lines.join("\n\n")}\n\n`;
  return framing + clip(routine.body, Math.max(0, MAX_QUESTION_LENGTH - framing.length));
}

/** How a run ended, read off its answer. */
export function runOutcome(answer) {
  const trimmed = typeof answer === "string" ? answer.trim() : "";
  if (trimmed === "" || trimmed.replace(/[.!]$/, "").toUpperCase() === SKIP_WORD) {
    return { outcome: "skipped", text: "" };
  }
  if (trimmed.toUpperCase().startsWith(DONE_WORD)) {
    return { outcome: "finished", text: trimmed.slice(DONE_WORD.length).trim() };
  }
  return { outcome: "answered", text: trimmed };
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

/** The note's text with `paused: yes` in its front matter, added or replaced. */
export function withPaused(text) {
  const lines = text.split("\n");
  if (lines[0]?.replace(/^\uFEFF/, "").trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === "---" || line === "...") {
        const kept = lines.slice(1, i).filter((l) => !/^paused\s*:/i.test(l.trim()));
        return [lines[0], ...kept, "paused: yes", ...lines.slice(i)].join("\n");
      }
    }
  }
  return `---\npaused: yes\n---\n${text}`;
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
    const read = await callTool("read_note", { path });
    const text = read?.content?.[0]?.text;
    if (read?.isError === true || typeof text !== "string") return "kept";
    const split = text.indexOf("\n\n");
    const etag = /^etag: (.+)$/m.exec(split === -1 ? text : text.slice(0, split))?.[1];
    const archived = await callTool("archive_note", { path, ...(etag ? { expected_etag: etag } : {}) });
    if (archived?.isError !== true) return "archived";
    const note = split === -1 ? "" : text.slice(split + 2);
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
