/**
 * HOW A TURN'S STEPS READ AS MARKDOWN, AND WHERE TEX'S DAILY TRANSCRIPTS WERE.
 *
 * From 2026-10-15 every texted turn was written into
 * `tex/transcripts/YYYY-MM-DD.md` as it happened. Those notes are no longer
 * written (decided by the owner, 2026-11-02): the chat's ledger is its one
 * record, open in the app as `tex/history.ledger.json`
 * (`docs/decisions/texting-assistant/chat-ledger.md`), and the pictures they
 * text are kept in `tex/pictures/` (`textedPictures.js`). The transcripts
 * already written stay theirs, in their folder.
 *
 * What remains here is the rendering every reader of a turn's steps shares
 * (the nightly dream, the check-in, housekeeping): a step as one line, a
 * tool's arguments with secrets hidden and a note's text as its length, and
 * never a tool's result.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";
import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";

export const TRANSCRIPTS_FOLDER = "tex/transcripts";

/** What a texted turn is told about the notes, so it never mistakes them for the person's own. */
export const TRANSCRIPTS_PROMPT =
  "\n\ntex/history.ledger.json in their personal workspace is this chat's whole history, kept as it happens; " +
  "they can open it in the app. Never cite it or file from it; read it only when they ask about it or an earlier conversation.";

const MAX_THINKING_CHARS = 6_000;
const MAX_SAID_CHARS = 4_000;
const MAX_ARG_CHARS = 300;
const MAX_ARGS_CHARS = 800;
/** A list longer than this is shown as its first two items and a count. */
const LONG_LIST = 5;

/** Argument names that may carry something secret; their values are never written. */
const SECRET_KEY = /pass|secret|token|otp|pin\b|cvv|card|api[-_]?key|credential|^code$/i;
/**
 * Argument names that carry a note's text, which can be another workspace's
 * words the model read: written as their length, like a tool's result.
 */
const CONTENT_KEY = /^(content|body|old_text|new_text|replacement|images)$/;


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



function cut(text, max) {
  const value = String(text ?? "").trim();
  return value.length > max ? `${value.slice(0, max)}… [cut, ${value.length} characters]` : value;
}

/** A tool's arguments as one line of JSON: secrets hidden, long values cut. */
export function argsLine(args) {
  const hide = (value, key) => {
    if (typeof key === "string" && SECRET_KEY.test(key) && value !== null && value !== undefined && value !== "") return "[hidden]";
    if (typeof key === "string" && CONTENT_KEY.test(key) && value !== null && value !== undefined) {
      return `[${typeof value === "string" ? value.length : JSON.stringify(value)?.length ?? 0} characters]`;
    }
    if (typeof value === "string") return value.length > MAX_ARG_CHARS ? `${value.slice(0, MAX_ARG_CHARS)}…` : value;
    // A long list (a batch of moves) shows its first items and how many more, so the line's cut never
    // swallows the arguments after it: a housekeeping log hid `dry_run` behind 100 moves (2026-10-26).
    if (Array.isArray(value)) {
      const shown = value.slice(0, value.length > LONG_LIST ? 2 : LONG_LIST).map((item) => hide(item, null));
      return value.length > shown.length ? [...shown, `… ${value.length - shown.length} more`] : shown;
    }
    if (value && typeof value === "object") {
      // Plain values first, lists and objects after, for the same reason.
      const entries = Object.entries(value).slice(0, 30);
      const flat = (v) => v === null || typeof v !== "object";
      return Object.fromEntries([...entries.filter(([, v]) => flat(v)), ...entries.filter(([, v]) => !flat(v))].map(([k, v]) => [k, hide(v, k)]));
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
export function eventLines(event) {
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
    case "steered": {
      const text = cut(event.text, MAX_SAID_CHARS);
      return text ? `**They texted, while Tex worked:** ${text}\n` : null;
    }
    case "model":
      return event.model ? `_Answering on ${event.model}${event.reason ? `, ${event.reason}` : ""}._\n` : null;
    default:
      return null;
  }
}
