/**
 * TEX'S DAILY TRANSCRIPTS, IN THE PERSON'S OWN `tex/` FOLDER (owner, 2026-10-15).
 *
 * "Save a daily transcript of people's Tex conversations to their tex folder
 * … would be nice if the transcript updated in real time, would be nice to
 * save the thinking and tool calls as well." So every texted turn (and every
 * routine run) is written into `tex/transcripts/YYYY-MM-DD.md`, dated in the
 * person's own time zone, as it happens: the text they sent, what the model
 * thought, what it said between steps, each tool it called with its
 * arguments, and the answer. A note, like everything else Tex keeps
 * (`aboutMe.js`, `jobs.js`): readable, exported, and theirs to delete.
 *
 * ## What it never holds
 *
 *   - A tool's result. It can quote a note from a shared workspace the person
 *     may later lose, and this note stays in their personal one; the same rule
 *     as the conversation history (`conversation.js`). Outcome and time only.
 *   - A secret. Saved logins never reach the model (`fillLogin.js`), so they
 *     never reach this either; an argument whose name looks like one
 *     (`password`, `token`, `code`…) is written as `[hidden]` all the same.
 *   - An attachment's bytes: names only, as the history keeps them.
 *
 * ## Written through the dispatcher, never around it
 *
 * Each write is a `write_note` under the turn's own session, so the tree, the
 * privacy engine and the note's history see it like any other write, and it
 * is attributed to Tex. A day's note is read once per turn; this turn's part
 * is written between markers after what was there, and rewritten in place as
 * the turn goes on. A write that lost a race re-reads and goes again. A note
 * that could not be read (anything but "not found") is left alone: a
 * transcript is never worth overwriting a day with one turn.
 *
 * Best effort throughout: a transcript that could not be written costs the
 * person a log line, never their answer.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";
import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";

export const TRANSCRIPTS_FOLDER = "tex/transcripts";

/** What a texted turn is told about the notes, so it never mistakes them for the person's own. */
export const TRANSCRIPTS_PROMPT =
  `\n\n${TRANSCRIPTS_FOLDER}/ is your own record of these texts, kept for improving you. ` +
  "It is not their notes: never cite it or file from it, and read it only when they ask about an earlier conversation.";

/** Past this, a day carries on in `YYYY-MM-DD-2.md`: the whole note is rewritten on every write. */
export const MAX_DAY_CHARS = 200_000;
const MAX_PARTS = 20;
/** One turn's part, bounded so a runaway turn cannot fill a day by itself. */
const MAX_TURN_CHARS = 60_000;
const MAX_THINKING_CHARS = 6_000;
const MAX_SAID_CHARS = 4_000;
const MAX_ARG_CHARS = 300;
const MAX_ARGS_CHARS = 800;

/** Argument names that may carry something secret; their values are never written. */
const SECRET_KEY = /pass|secret|token|otp|pin\b|cvv|card|api[-_]?key|credential|^code$/i;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(value) {
  return String(value).padStart(2, "0");
}

function zoneOf(timeZone) {
  return readTimeZone(timeZone) ?? DEFAULT_TIME_ZONE;
}

/** The day's note: `tex/transcripts/2026-10-15.md`, or `-2`, `-3`… once a day outgrows one note. */
export function transcriptPath(now, timeZone, part = 1) {
  const w = wallClock(now, zoneOf(timeZone));
  const day = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  return `${TRANSCRIPTS_FOLDER}/${day}${part > 1 ? `-${part}` : ""}.md`;
}

function heading(now, timeZone) {
  const w = wallClock(now, zoneOf(timeZone));
  return `# Tex, ${MONTHS[w.month - 1]} ${w.day}, ${w.year}\n\nEvery text with Tex today, with its thinking and the tools it used, written as it happens.\n`;
}

function clock(now, timeZone) {
  const w = wallClock(now, zoneOf(timeZone));
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${h}:${pad(w.minute)} ${w.hour < 12 ? "am" : "pm"}`;
}

function cut(text, max) {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max)}… [cut, ${value.length} characters]` : value;
}

/** A tool's arguments as one line of JSON: secrets hidden, long values cut. */
export function argsLine(args) {
  const hide = (value, key) => {
    if (typeof key === "string" && SECRET_KEY.test(key) && value !== null && value !== undefined && value !== "") return "[hidden]";
    if (typeof value === "string") return value.length > MAX_ARG_CHARS ? `${value.slice(0, MAX_ARG_CHARS)}…` : value;
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => hide(item, null));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).slice(0, 30).map(([k, v]) => [k, hide(v, k)]));
    }
    return value;
  };
  let line;
  try {
    line = JSON.stringify(hide(args && typeof args === "object" ? args : {}, null));
  } catch {
    line = "{}";
  }
  return line.length > MAX_ARGS_CHARS ? `${line.slice(0, MAX_ARGS_CHARS)}…` : line;
}

function quoted(text) {
  return text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

function seconds(ms) {
  return `${(Math.max(0, ms ?? 0) / 1000).toFixed(1)} s`;
}

/** One event of a turn as Markdown. */
function eventLines(event) {
  switch (event.kind) {
    case "thinking": {
      const text = cut(event.text, MAX_THINKING_CHARS);
      return text ? `${quoted(`💭 ${text}`)}\n` : null;
    }
    case "say": {
      const text = cut(event.text, MAX_SAID_CHARS);
      return text ? `**Tex, while working:** ${text}\n` : null;
    }
    case "tool": {
      const outcome = event.held ? "held for their yes" : event.ok ? "ok" : `failed${event.reason ? ` (${event.reason})` : ""}`;
      return `- \`${event.name}\` \`${argsLine(event.args)}\` → ${outcome}, ${seconds(event.ms)}\n`;
    }
    case "model":
      return event.model ? `_Answering on ${event.model}${event.reason ? `, ${event.reason}` : ""}._\n` : null;
    default:
      return null;
  }
}

const startMarker = (id) => `<!-- tex-turn ${id} -->`;
const endMarker = (id) => `<!-- /tex-turn ${id} -->`;

/** `text` without this turn's own earlier part, so a re-read after a lost race does not keep it twice. */
function withoutTurn(text, id) {
  const start = text.indexOf(startMarker(id));
  if (start === -1) return text;
  const endAt = text.indexOf(endMarker(id), start);
  const end = endAt === -1 ? text.length : endAt + endMarker(id).length;
  return `${text.slice(0, start).replace(/\n+$/, "\n")}${text.slice(end).replace(/^\n+/, "")}`;
}

/** read_note's header lines (`etag: …`) end at the first blank line. */
const HEADER_LINE = /^[a-z_]+: /;

/** `{ etag, body }`, `{ missing: true }` when there is no such note, or null when it could not be read. */
async function readDay(callTool, path) {
  try {
    const result = await callTool("read_note", { path });
    const text = (Array.isArray(result?.content) ? result.content : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    if (result?.isError === true) return /^not found\b/i.test(text.trim()) ? { missing: true } : null;
    const lines = text.split("\n");
    let i = 0;
    let etag = null;
    while (i < lines.length && HEADER_LINE.test(lines[i])) {
      if (lines[i].startsWith("etag: ")) etag = lines[i].slice("etag: ".length).trim();
      i += 1;
    }
    if (i === 0 || etag === null || lines[i]?.trim() !== "") return null;
    return { etag, body: lines.slice(i + 1).join("\n") };
  } catch {
    return null;
  }
}

/** The etag `write_note` answered with, or null. */
function writtenEtag(result) {
  const text = (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");
  return /\(etag ([^)\s]+)\)/.exec(text)?.[1] ?? null;
}

/**
 * Start this turn's part of today's transcript. Returns `{ record(event),
 * finish({ answer, outcome }) }`; `record` never waits and never throws, and
 * `finish` resolves once the last write has landed (or failed).
 *
 * @param {(name: string, args: object) => Promise<object>} callTool the session's dispatcher
 * @param {object} options
 * @param {number} options.now when the text arrived
 * @param {string} [options.timeZone] theirs; the day and the times are in it
 * @param {string} options.question what they sent, or the routine's name
 * @param {string} [options.attachments] the attachments line, names only
 * @param {string|null} [options.routine] the routine's path, when this is one's run
 * @param {() => number} [options.clock]
 */
export function openTranscript(callTool, { now, timeZone, question, attachments = "", routine = null, clock: tick = Date.now }) {
  const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const events = [];
  let ending = null;
  let state = null; // { path, etag, before } once the day's note is read; false when it can't be
  let dirty = false;
  let running = null;

  const opening =
    routine === null
      ? `**Them:** ${cut(question, MAX_SAID_CHARS)}\n${attachments ? `_${attachments}_\n` : ""}`
      : `**Routine** \`${routine}\` ran.\n`;

  function part() {
    const body = [`## ${clock(now, timeZone)}${routine === null ? "" : " · routine"}`, "", opening];
    for (const event of events) {
      const lines = eventLines(event);
      if (lines) body.push(lines);
    }
    if (ending) {
      body.push(
        ending.answer ? `**Tex:** ${cut(ending.answer, MAX_SAID_CHARS)}\n` : `_No answer: ${ending.outcome ?? "failed"}._\n`,
      );
    } else {
      body.push("_…working_\n");
    }
    let text = body.join("\n");
    if (text.length > MAX_TURN_CHARS) text = `${text.slice(0, MAX_TURN_CHARS)}\n\n_[the rest of this turn was cut]_\n`;
    return `${startMarker(id)}\n${text}\n${endMarker(id)}\n`;
  }

  /** Today's note to write into: the first part with room, read now. */
  async function open() {
    for (let n = 1; n <= MAX_PARTS; n += 1) {
      const path = transcriptPath(now, timeZone, n);
      const day = await readDay(callTool, path);
      if (day === null) return false;
      if (day.missing) return { path, etag: null, before: heading(now, timeZone) };
      if (day.body.length < MAX_DAY_CHARS) return { path, etag: day.etag, before: withoutTurn(day.body, id) };
    }
    return false;
  }

  async function writeOnce(retry = true) {
    const content = `${state.before.replace(/\n*$/, "\n\n")}${part()}`;
    const result = await callTool("write_note", {
      path: state.path,
      content,
      ...(state.etag ? { expected_etag: state.etag } : {}),
    });
    if (result?.isError !== true) {
      state.etag = writtenEtag(result) ?? state.etag;
      return;
    }
    if (!retry) return;
    // Another turn wrote the day first (or it was made since): read it again and go again.
    const day = await readDay(callTool, state.path);
    if (day === null) return;
    state.before = day.missing ? heading(now, timeZone) : withoutTurn(day.body, id);
    state.etag = day.missing ? null : day.etag;
    await writeOnce(false);
  }

  async function drain() {
    try {
      if (state === null) state = await open();
      while (dirty && state) {
        dirty = false;
        await writeOnce();
      }
    } catch {
      // Best effort: see the top of this file.
    } finally {
      running = null;
    }
  }

  function schedule() {
    dirty = true;
    if (running === null) running = drain();
  }

  // The text is in the note before the model has said a word.
  schedule();

  return {
    id,
    record(event) {
      if (ending || !event || typeof event !== "object") return;
      events.push({ ...event, at: tick() });
      schedule();
    },
    async finish({ answer = "", outcome = "answered" } = {}) {
      if (ending) return;
      ending = { answer, outcome };
      schedule();
      // A write started before the ending may still be running; the loop picks the ending up.
      while (running !== null) await running;
    },
  };
}
