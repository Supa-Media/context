// One meeting is one Markdown file, in the customer's own bucket.
//
// The owner decided this: no sibling `.transcript.md`, no attachment, no
// database row that the file is a view of. Frontmatter, `# title`,
// `## Summary`, `## My notes`, `## Transcript`, in that order, and the
// transcript goes last precisely so that a reader — human or AI client — can
// stop before it.
//
// Two properties this file exists to hold up:
//
// 1. **`## My notes` is the human's and is never rewritten.** Not reordered,
//    not reflowed, not fenced, not escaped. Which means the parser has to cope
//    with a human who pastes `---`, a YAML-looking line, or a literal
//    `## Transcript` into their own notes — and must not truncate the note when
//    they do. Everything ambiguous resolves in favour of keeping their text.
// 2. **The transcript is cheap to leave behind.** `splitTranscript` finds the
//    boundary with one linear pass over the lines. Forty minutes of speech is
//    about forty kilobytes, and no AI client should have to pull that to read a
//    summary.

import { DEFAULT_TITLE } from "./session.js";
import { UNKNOWN_SPEAKER, formatClock, groupIntoTurns } from "./transcript.js";

/** @typedef {import("./protocol.js").MeetingSession} MeetingSession */

export const SUMMARY_HEADING = "## Summary";
export const NOTES_HEADING = "## My notes";
export const TRANSCRIPT_HEADING = "## Transcript";

/** Stands in for a summary nobody has generated yet, so the section is never blank. */
export const SUMMARY_PLACEHOLDER = "_No summary yet._";

/**
 * Stands in for a transcript that was never captured.
 *
 * The section is written even when it is empty, and that is load-bearing rather
 * than tidy: `## Transcript` is always the *last* heading we wrote, which is
 * what lets the parser resolve a `## Transcript` the human typed in their own
 * notes in their favour. Omit the section on a notes-only meeting and that user
 * loses the tail of their notes.
 */
export const TRANSCRIPT_PLACEHOLDER = "_No transcript was captured._";

/** Frontmatter keys, in the order they are written. */
export const FRONTMATTER_KEYS = Object.freeze([
  "updated",
  "type",
  "meeting-id",
  "started",
  "ended",
  "duration",
  "source",
  "attendees",
  "status",
]);

/* ------------------------------- YAML ------------------------------------ */

// A meeting title, an attendee name and a detected app name are all strings
// somebody else chose. `Q3: "review"` is a perfectly ordinary title and it is
// also three ways to break a naive `key: value` line, so nothing goes into
// frontmatter without going through here.

/** Bare scalars we allow: no quotes, no colons, no leading indicator characters. */
const SAFE_BARE = /^[A-Za-z][A-Za-z0-9_./-]*(?: [A-Za-z0-9_./-]+)*$/;

/** Words YAML 1.1 readers turn into booleans or null if left unquoted. */
const RESERVED_WORDS = new Set(["y", "n", "yes", "no", "true", "false", "on", "off", "null", "~"]);

/**
 * @param {unknown} value
 * @returns {string}
 */
export function yamlScalar(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (text !== "" && SAFE_BARE.test(text) && !RESERVED_WORDS.has(text.toLowerCase())) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

/**
 * A flow sequence. Flow rather than a block list because it round-trips through
 * one line and this file's parser is deliberately not a YAML implementation.
 *
 * @param {unknown[]} values
 * @returns {string}
 */
export function yamlFlowList(values) {
  const items = (values ?? []).map((value) => yamlScalar(value));
  return items.length ? `[${items.join(", ")}]` : "[]";
}

/** @param {string} text */
function unescapeDoubleQuoted(text) {
  return text.replace(/\\(.)/g, (_match, char) => (char === "n" ? "\n" : char === "r" ? "\r" : char));
}

/**
 * Split a flow sequence body on commas that are not inside a quoted scalar.
 *
 * @param {string} body
 * @returns {string[]}
 */
function splitFlow(body) {
  const items = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === "," && !quoted) {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "" || items.length) items.push(current);
  return items;
}

/**
 * @param {string} raw
 * @returns {string|string[]}
 */
function yamlValue(raw) {
  const text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) {
    return splitFlow(text.slice(1, -1))
      .map((item) => yamlValue(item))
      .filter((item) => item !== "");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return unescapeDoubleQuoted(text.slice(1, -1));
  }
  return text;
}

/* ----------------------------- line scanning ----------------------------- */

/**
 * Which lines sit inside a fenced code block.
 *
 * This is the whole defence against a user pasting `## Transcript` into their
 * own notes inside a fence — a very normal thing to do when the notes are about
 * this file format. One pass, no AST.
 *
 * @param {string[]} lines
 * @param {number} from  First line to consider; frontmatter's `---` is not a fence.
 * @returns {boolean[]}
 */
function fencedLines(lines, from = 0) {
  const inCode = new Array(lines.length).fill(false);
  /** @type {string|null} */
  let fence = null;
  for (let i = from; i < lines.length; i += 1) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence === null) {
      // An info string may not contain a backtick when the fence is backticks.
      if (match && !(match[1][0] === "`" && match[2].includes("`"))) {
        fence = match[1];
        inCode[i] = true;
      }
      continue;
    }
    inCode[i] = true;
    if (match && match[1][0] === fence[0] && match[1].length >= fence.length && match[2].trim() === "") {
      fence = null;
    }
  }
  return inCode;
}

/**
 * Heading lines must be flush left and carry nothing but the heading. That
 * alone keeps an indented code block from being mistaken for a section break;
 * `fencedLines` handles the fenced kind.
 *
 * @param {string} line
 * @param {string} heading
 */
function isHeading(line, heading) {
  return line === heading || (line.startsWith(heading) && line.slice(heading.length).trim() === "");
}

/**
 * @typedef {Object} SectionIndex
 * @property {number} frontmatterEnd  Index of the closing `---`, or -1.
 * @property {number} title           Index of the `# ` line, or -1.
 * @property {number} summary
 * @property {number} notes
 * @property {number} transcript
 * @property {string[]} lines
 */

/**
 * Locate the sections in one pass.
 *
 * The tie-breaks are the interesting part, and both favour the human's text:
 *
 * - `## Summary` and `## My notes` take their **first** occurrence, because we
 *   write them before the notes body.
 * - `## Transcript` takes its **last** occurrence, because we write it after.
 *   So a user who types `## Transcript` into their own notes keeps every word:
 *   the real boundary is still the one further down.
 *
 * @param {string} markdown
 * @returns {SectionIndex}
 */
function indexSections(markdown) {
  const lines = String(markdown ?? "").split("\n");

  let frontmatterEnd = -1;
  if (lines[0] === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] === "---") {
        frontmatterEnd = i;
        break;
      }
    }
  }

  const bodyStart = frontmatterEnd === -1 ? 0 : frontmatterEnd + 1;
  const inCode = fencedLines(lines, bodyStart);

  let title = -1;
  let summary = -1;
  let notes = -1;
  let transcript = -1;
  for (let i = bodyStart; i < lines.length; i += 1) {
    if (inCode[i]) continue;
    const line = lines[i];
    if (title === -1 && /^# \S/.test(line)) title = i;
    if (summary === -1 && isHeading(line, SUMMARY_HEADING)) summary = i;
    if (notes === -1 && isHeading(line, NOTES_HEADING)) notes = i;
    if (isHeading(line, TRANSCRIPT_HEADING)) transcript = i;
  }
  // A `## Transcript` above the notes heading is the user's, not ours.
  if (transcript !== -1 && notes !== -1 && transcript < notes) transcript = -1;

  return { frontmatterEnd, title, summary, notes, transcript, lines };
}

/**
 * The body of a section, undoing exactly the blank lines the renderer added:
 * one after the heading, one before the next.
 *
 * That is what makes the round trip exact rather than approximate — a note
 * whose body genuinely ends in two blank lines comes back with two.
 *
 * @param {string[]} lines
 * @param {number} start  Heading index.
 * @param {number} end    Index of the next boundary, or lines.length.
 * @returns {string}
 */
function sectionBody(lines, start, end) {
  const body = lines.slice(start + 1, end);
  if (body.length && body[0] === "") body.shift();
  if (body.length && body[body.length - 1] === "") body.pop();
  return body.join("\n");
}

/* ------------------------------- rendering ------------------------------- */

/**
 * Human-readable, because this lands in somebody's vault and gets read by
 * people before it gets read by a query.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * One turn, as it appears under `## Transcript`.
 *
 * @param {import("./transcript.js").TranscriptTurn} turn
 * @returns {string}
 */
export function renderTurn(turn) {
  return `**[${formatClock(turn.startMs)}] ${turn.speaker ?? UNKNOWN_SPEAKER}** — ${turn.text}`;
}

/**
 * The whole note.
 *
 * @param {MeetingSession} session
 * @param {{now?: string, maxGapMs?: number}} [options]
 * @returns {string}
 */
export function renderMeetingNote(session, options = {}) {
  if (!session || typeof session !== "object") throw new TypeError("renderMeetingNote needs a session");

  const updated = options.now ?? new Date().toISOString();
  const turns = groupIntoTurns(session.transcript ?? [], { maxGapMs: options.maxGapMs });

  // Keyed off FRONTMATTER_KEYS so the documented order and the written order
  // cannot drift: the on-bucket layout is a stable format, not an internal
  // detail, and changing it is a breaking change.
  const values = {
    updated: yamlScalar(updated),
    type: yamlScalar("meeting"),
    "meeting-id": yamlScalar(session.id),
    started: yamlScalar(session.startedAt),
    ended: yamlScalar(session.endedAt ?? ""),
    duration: yamlScalar(formatDuration(session.recordedMs ?? 0)),
    source: yamlScalar(session.source?.kind ?? "unknown"),
    attendees: yamlFlowList((session.attendees ?? []).map((attendee) => attendee.name)),
    status: yamlScalar(session.state ?? "idle"),
  };
  const frontmatter = FRONTMATTER_KEYS.map((key) => `${key}: ${values[key]}`);

  const summary = typeof session.enhanced === "string" && session.enhanced.trim() ? session.enhanced : SUMMARY_PLACEHOLDER;
  // Verbatim. The one field in this file nothing is allowed to touch.
  const notes = typeof session.notes === "string" ? session.notes : "";
  const title = String(session.title ?? "").replace(/\s+/g, " ").trim() || DEFAULT_TITLE;

  const out = ["---", ...frontmatter, "---", ""];
  out.push(`# ${title}`, "");
  out.push(SUMMARY_HEADING, "", ...summary.split("\n"), "");
  out.push(NOTES_HEADING, "", ...notes.split("\n"), "");
  const body = [];
  for (const turn of turns) {
    if (body.length) body.push("");
    body.push(renderTurn(turn));
  }
  out.push(TRANSCRIPT_HEADING, "", ...(body.length ? body : [TRANSCRIPT_PLACEHOLDER]), "");
  return out.join("\n");
}

/* -------------------------------- parsing -------------------------------- */

/**
 * @typedef {Object} ParsedMeetingNote
 * @property {Record<string, string|string[]>} frontmatter
 * @property {string} title
 * @property {string} summary
 * @property {string} notes
 * @property {string|null} transcript  Raw Markdown of the section, or null.
 */

/**
 * Read a note back.
 *
 * `parseMeetingNote(renderMeetingNote(session))` recovers the frontmatter and
 * `notes` exactly — including notes that contain `---`, YAML-looking lines, or
 * a fenced `## Transcript`.
 *
 * @param {string} markdown
 * @returns {ParsedMeetingNote}
 */
export function parseMeetingNote(markdown) {
  const { frontmatterEnd, title, summary, notes, transcript, lines } = indexSections(markdown);

  /** @type {Record<string, string|string[]>} */
  const frontmatter = {};
  if (frontmatterEnd > 0) {
    for (let i = 1; i < frontmatterEnd; i += 1) {
      const line = lines[i];
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      if (!key) continue;
      frontmatter[key] = yamlValue(line.slice(colon + 1));
    }
  }

  // Boundaries, in document order. A missing section simply does not bound the
  // one before it, which is what lets a hand-edited note still parse.
  const boundaries = [summary, notes, transcript].filter((index) => index !== -1);
  const nextAfter = (index) => {
    for (const boundary of boundaries) if (boundary > index) return boundary;
    return lines.length;
  };

  return {
    frontmatter,
    title: title === -1 ? "" : lines[title].slice(2).trim(),
    summary: summary === -1 ? "" : sectionBody(lines, summary, nextAfter(summary)),
    notes: notes === -1 ? "" : sectionBody(lines, notes, nextAfter(notes)),
    transcript: transcript === -1 ? null : sectionBody(lines, transcript, lines.length),
  };
}

/**
 * The note without its transcript, cheaply.
 *
 * One linear pass over the lines — no AST, no Markdown parser — because the
 * gateway calls this on the read path for every meeting note an AI client asks
 * for, and the whole point is not to move the forty kilobytes it is dropping.
 *
 * @param {string} markdown
 * @returns {{head: string, transcript: string|null}}
 */
export function splitTranscript(markdown) {
  const text = String(markdown ?? "");
  const { transcript, lines } = indexSections(text);
  if (transcript === -1) return { head: text, transcript: null };
  const head = lines.slice(0, transcript).join("\n");
  return {
    head: head.endsWith("\n") || head === "" ? head : `${head}\n`,
    transcript: sectionBody(lines, transcript, lines.length),
  };
}
