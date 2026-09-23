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

import { TRANSCRIPTION_ENGINES } from "./protocol.js";
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

/**
 * The line above a machine transcript that says it is one.
 *
 * ## Why a note now carries a caveat it did not
 *
 * Measured, twice, on the owner's own machine. Ninety seconds of a quiet room
 * with nobody speaking produced 166 words and filed them as a meeting note. And
 * — the finding that decides this line — parked batches from audio that was a
 * synthesised counting script carried sentences nobody said at all:
 * *"I'm going to put it in another room."*, *"I'm sorry."* So hallucination is
 * **not confined to silence**. It happens over real audio, in the middle of
 * real speech, and there is no signal on that path anybody here can filter on:
 * a confidently decoded sentence is exactly what a correctly heard one looks
 * like.
 *
 * The transcription service refuses what the engine's own evidence marks as
 * silence, which is the whole of what can be ruled out. What is left cannot be,
 * so it is disclosed instead. A person reading their own note eight months from
 * now — or, worse, quoting it back to somebody who was in the room — is
 * entitled to know that a sentence in it may never have been said.
 *
 * ## Why it is one line, in the section, and not frontmatter
 *
 * `transcription: cloud` already names the engine, and that key answers "where
 * did my audio go". It does not answer "can I trust this sentence", and it is
 * read by a machine rather than by the person skimming the transcript. A reader
 * meets this where the words are.
 *
 * It is written **only when there is a machine transcript to caveat**: never on
 * a notes-only meeting, never above the placeholder, and never over a
 * transcript no engine produced. A caveat on a note with nothing in it is
 * noise, and noise is what teaches somebody to stop reading the caveat that
 * matters.
 *
 * Nothing parses it back. `parseMeetingNote` returns the transcript section as
 * raw Markdown and `splitTranscript` cuts on the heading, so this rides inside
 * the section like any other line — which is also why it must never be the only
 * thing in the section.
 */
export const TRANSCRIPT_CAVEAT =
  "_Transcribed automatically. Speech recognition mishears, and can produce sentences nobody said._";

/** Frontmatter keys, in the order they are written. */
export const FRONTMATTER_KEYS = Object.freeze([
  "updated",
  "type",
  "meeting-id",
  "started",
  "ended",
  "duration",
  "source",
  "transcription",
  "device",
  "attendees",
  "status",
  "event",
]);

/**
 * Stands in for a meeting nothing transcribed.
 *
 * Written rather than omitted, and that is the whole of the rule: a key that is
 * absent is indistinguishable from a note written before this product recorded
 * how it was made, so a reader could not tell "nobody transcribed this" from
 * "nobody wrote it down". `none` is a word in a document a person opens, so it
 * says what happened rather than spelling `null`.
 */
export const TRANSCRIPTION_NONE = "none";

/**
 * ...and for a value this contract does not recognise.
 *
 * Only reachable from a session record somebody hand-edited in their own
 * bucket — the gateway refuses an unknown engine on the way in
 * (`normalizeTranscription`). The renderer still has to answer, and it may
 * neither guess an engine nor drop the key, so it says it does not know. It
 * never throws: refusing to write the note would lose the meeting to protect a
 * field.
 */
export const TRANSCRIPTION_UNKNOWN = "unknown";

/**
 * What the frontmatter says a meeting's words came from.
 *
 * @param {unknown} transcription
 * @returns {string}
 */
export function transcriptionLabel(transcription) {
  if (transcription === null) return TRANSCRIPTION_NONE;
  if (typeof transcription === "string" && TRANSCRIPTION_ENGINES.includes(transcription)) {
    return transcription;
  }
  return TRANSCRIPTION_UNKNOWN;
}

/**
 * The device that recorded it, for a human.
 *
 * The platform is the floor — every `MeetingDevice` has one, and "was this the
 * laptop or the phone" is answerable from it alone — and the name is the useful
 * half when there is one, because a person with two Macs is asking *which*. So:
 * `Studio Mac (macos)` when the device named itself, `macos` when it did not.
 *
 * `appVersion` is deliberately not here. It is a fact about the build, not
 * about the device that recorded, and the decision this key exists for asks for
 * the device; a note is not a support ticket.
 *
 * @param {unknown} device
 * @returns {string}
 */
export function deviceLabel(device) {
  const raw = device && typeof device === "object" ? /** @type {Record<string, unknown>} */ (device) : {};
  const platform = typeof raw.platform === "string" && raw.platform.trim() ? raw.platform.trim() : "unknown";
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  return name ? `${name} (${platform})` : platform;
}

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
 * One flagged moment, as an Obsidian-style callout.
 *
 * A callout rather than a line of bold text because this note is read in
 * somebody's vault: `> [!flag]` renders as a marked block there and as an
 * ordinary blockquote everywhere else, which is the plain-file behaviour we
 * want — degraded, never broken.
 *
 * @param {import("./protocol.js").MeetingFlag} flag
 * @returns {string}
 */
export function renderFlag(flag) {
  const clock = formatClock(flag.at);
  return flag.label ? `> [!flag] ${clock} — ${flag.label}` : `> [!flag] ${clock}`;
}

/**
 * Flags, filed against the turn they were pressed during.
 *
 * The turn a flag belongs to is the last one that had started when the button
 * was pressed — the wearer marks the sentence they are hearing. A flag pressed
 * before anybody spoke belongs to no turn and is rendered first, which is index
 * `-1` here; it is a real case, because the wrist is how a meeting gets started
 * and a mark can come before the first word is transcribed.
 *
 * @param {import("./protocol.js").MeetingFlag[]} flags
 * @param {import("./transcript.js").TranscriptTurn[]} turns
 * @returns {Map<number, import("./protocol.js").MeetingFlag[]>}
 */
function flagsByTurn(flags, turns) {
  /** @type {Map<number, import("./protocol.js").MeetingFlag[]>} */
  const byTurn = new Map();
  for (const flag of [...(flags ?? [])].sort((a, b) => a.at - b.at)) {
    if (!flag || typeof flag.at !== "number" || !Number.isFinite(flag.at)) continue;
    let index = -1;
    for (let i = 0; i < turns.length; i += 1) {
      if (turns[i].startMs <= flag.at) index = i;
      else break;
    }
    const list = byTurn.get(index);
    if (list) list.push(flag);
    else byTurn.set(index, [flag]);
  }
  return byTurn;
}

/**
 * The lines under `## Transcript`: the turns, with the wearer's flags in them.
 *
 * Shared by `renderMeetingNote` and `continueMeetingNote`, so a part added to a
 * note later is drawn by the same code as the part the note was written with.
 * `offsetMs` is how much of the meeting was already recorded before this
 * session began — zero for a note's first part — and it moves every clock, so
 * the second part of a 31-minute meeting reads `[31:02]` rather than `[00:02]`.
 *
 * @param {MeetingSession} session
 * @param {number} offsetMs
 * @param {number} [maxGapMs]
 * @returns {{body: string[], machine: boolean}}
 */
function transcriptBody(session, offsetMs, maxGapMs) {
  const shift = Number.isFinite(offsetMs) && offsetMs > 0 ? offsetMs : 0;
  const segments = (session.transcript ?? []).map((segment) =>
    shift === 0 ? segment : { ...segment, startMs: segment.startMs + shift, endMs: segment.endMs + shift }
  );
  const flags = (session.flags ?? []).map((flag) =>
    shift === 0 || !flag || typeof flag.at !== "number" ? flag : { ...flag, at: flag.at + shift }
  );
  const turns = groupIntoTurns(segments, { maxGapMs });
  /*
    A flag sits *after* the turn it was pressed during — you press during a
    sentence, and the mark reads as a note on what was just said — except for
    one pressed before anybody spoke, which has no turn to follow and leads.
    A meeting with flags and no transcript still writes them: the press
    happened, and the heading stays the last one this renderer wrote.
  */
  const byTurn = flagsByTurn(flags, turns);
  const body = [];
  const push = (line) => {
    if (body.length) body.push("");
    body.push(line);
  };
  for (const flag of byTurn.get(-1) ?? []) push(renderFlag(flag));
  for (let i = 0; i < turns.length; i += 1) {
    push(renderTurn(turns[i]));
    for (const flag of byTurn.get(i) ?? []) push(renderFlag(flag));
  }
  /*
    The caveat leads the section, and only where there is a machine transcript.

    `turns.length` rather than `body.length`: a meeting with flags and no
    transcript writes a body — the presses happened — and none of it came from
    an engine, so there is nothing there to caveat. And `transcriptionLabel`
    rather than a truthiness check on the field, because `none` and `unknown`
    are both real values that mean no engine named itself, and a note that
    cannot say what produced its words must not claim one did.
  */
  const machine =
    turns.length > 0 && TRANSCRIPTION_ENGINES.includes(transcriptionLabel(session.transcription ?? null));
  return { body, machine };
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
    // Beside `source` on purpose: `source` is where the audio came from,
    // `transcription` is what turned it into text, and `device` is what was in
    // the room. A reader asking "where did my audio go" reads three adjacent
    // lines rather than hunting the block.
    // A session carrying no field at all reads as no engine, which is the same
    // normalization `createSession` does at the gateway's door: absent has one
    // meaning here, and it is not a second kind of unknown.
    transcription: yamlScalar(transcriptionLabel(session.transcription ?? null)),
    device: yamlScalar(deviceLabel(session.device)),
    attendees: yamlFlowList((session.attendees ?? []).map((attendee) => attendee.name)),
    status: yamlScalar(session.state ?? "idle"),
    // Last, and optional: the calendar event this meeting was matched to, as
    // an ordinary `[[path#anchor]]` wikilink, or empty when there is none —
    // written the same way `ended` is, so "no match yet" and "never written
    // before this key existed" read as the same sentence to a client that
    // does not know about calendar matching at all. Set once, by
    // `docs/decisions/communications.md`'s "The link lives in a frontmatter
    // key, not a new section" — never by this renderer, which only ever
    // carries forward whatever `session.event` already says.
    event: yamlScalar(session.event ?? ""),
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
  const { body, machine } = transcriptBody(session, 0, options.maxGapMs);
  out.push(
    TRANSCRIPT_HEADING,
    "",
    ...(machine ? [TRANSCRIPT_CAVEAT, ""] : []),
    ...(body.length ? body : [TRANSCRIPT_PLACEHOLDER]),
    ""
  );
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

/* ------------------------------ continuation ----------------------------- */

/*
 * A MEETING PICKED BACK UP IS ADDED TO THE NOTE IT ALREADY IS.
 *
 * Somebody stops a meeting, the note lands, and ten minutes later the meeting
 * starts again. What they want is the same file with both halves in it — not
 * a second note beside the first. So a resumed recording is a *part*: a new
 * session with its own id (its segment ids name it, which is what the identity
 * guards check), recorded like any other, and written by splicing it into the
 * note that is already in the bucket.
 *
 * Spliced, not re-rendered. The note has been the customer's since it landed:
 * they may have fixed a name in the summary, added a line under `## My notes`
 * in Obsidian, retitled it. Rendering the whole file again from what this
 * device remembers would put back what they changed, and the device that
 * resumes may not be the one that recorded the first part at all. Everything
 * already in the file stays byte for byte, except three frontmatter values
 * that describe the meeting as a whole — `updated`, `ended` and `duration` —
 * which now describe more of it.
 *
 * The seam is written into the transcript as one line, because the gap between
 * the parts was not recorded and the note may not pretend otherwise. It also
 * carries the part's own start, to the second, and that is what makes the
 * write idempotent: a retry after a write whose answer was lost finds its own
 * seam already in the file and adds nothing (`continuesMeetingNote`).
 */

/** How a seam line starts, so a reader of the file can find every one. */
export const RESUMED_PREFIX = "_Resumed ";

/**
 * @typedef {Object} MeetingPart
 * @property {MeetingSession} session  The part's own session: its transcript
 *   and flags count from the moment it started, like any session's.
 * @property {number} offsetMs  How much of the meeting the note already held
 *   when this part began. Every clock in the part is moved by it.
 * @property {string|null} previousEndedAt  When the meeting last stopped, as
 *   the note said at the moment it was resumed, or null when it did not say.
 */

/**
 * The part's start, as the seam prints it: `2026-09-21 14:14:03 UTC`.
 *
 * UTC because every clock in the frontmatter is UTC, and a file that mixes the
 * recording device's zone into one line is a file whose times disagree with
 * each other. To the second because the seam is also the part's identity.
 *
 * @param {string} startedAt
 * @returns {string}
 */
function seamStamp(startedAt) {
  const ms = Date.parse(startedAt);
  if (!Number.isFinite(ms)) return String(startedAt);
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

/**
 * The line between two parts of one meeting.
 *
 * @param {MeetingPart} part
 * @returns {string}
 */
export function resumeSeam(part) {
  const stamp = seamStamp(part.session.startedAt);
  const started = Date.parse(part.session.startedAt);
  const stopped = part.previousEndedAt === null ? NaN : Date.parse(part.previousEndedAt);
  const gap =
    Number.isFinite(started) && Number.isFinite(stopped) && started >= stopped
      ? `, ${formatDuration(started - stopped)} after it stopped`
      : "";
  return `${RESUMED_PREFIX}${stamp}${gap}._`;
}

/**
 * Whether this part is already in the note.
 *
 * Keyed on the seam's stamp rather than the whole line, so a retry still finds
 * its part if the "after it stopped" half would now be worded differently.
 *
 * @param {string} markdown
 * @param {MeetingPart} part
 * @returns {boolean}
 */
export function continuesMeetingNote(markdown, part) {
  const marker = `${RESUMED_PREFIX}${seamStamp(part.session.startedAt)}`;
  return String(markdown ?? "")
    .split("\n")
    .some((line) => line.startsWith(marker));
}

/**
 * Rewrite one `key: value` line inside the frontmatter, if the key is there.
 *
 * A key the person deleted stays deleted: putting it back is a change to their
 * file that nothing asked for.
 *
 * @param {string[]} lines
 * @param {number} frontmatterEnd
 * @param {string} key
 * @param {string} value
 */
function setFrontmatter(lines, frontmatterEnd, key, value) {
  for (let i = 1; i < frontmatterEnd; i += 1) {
    if (lines[i].startsWith(`${key}:`)) {
      lines[i] = `${key}: ${yamlScalar(value)}`;
      return;
    }
  }
}

/**
 * The note with this part added to it.
 *
 * The part's typed notes go at the end of `## My notes`, verbatim; its
 * transcript goes at the end of the file — which is the end of `## Transcript`,
 * the heading this renderer always writes last — after the seam. A note that
 * has lost either heading gets it back rather than losing the part.
 *
 * @param {string} markdown  The note as it is in the bucket now.
 * @param {MeetingPart} part
 * @param {{now?: string, maxGapMs?: number}} [options]
 * @returns {string}
 */
export function continueMeetingNote(markdown, part, options = {}) {
  if (!part || !part.session || typeof part.session !== "object") {
    throw new TypeError("continueMeetingNote needs a part");
  }
  const { session } = part;
  const offsetMs = Number.isFinite(part.offsetMs) && part.offsetMs > 0 ? part.offsetMs : 0;
  const { frontmatterEnd, notes, summary, transcript, lines } = indexSections(markdown);
  const out = [...lines];

  if (frontmatterEnd > 0) {
    setFrontmatter(out, frontmatterEnd, "updated", options.now ?? new Date().toISOString());
    if (session.endedAt) setFrontmatter(out, frontmatterEnd, "ended", session.endedAt);
    setFrontmatter(out, frontmatterEnd, "duration", formatDuration(offsetMs + (session.recordedMs ?? 0)));
  }

  /*
    The transcript first, because it goes at the very end and so moves no
    index the notes insertion below still needs.
  */
  const { body, machine } = transcriptBody(session, offsetMs, options.maxGapMs);
  const alreadyCaveated = out.includes(TRANSCRIPT_CAVEAT);
  const added = [
    resumeSeam(part),
    "",
    ...(machine && !alreadyCaveated ? [TRANSCRIPT_CAVEAT, ""] : []),
    ...(body.length ? body : [TRANSCRIPT_PLACEHOLDER]),
  ];
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const appendAt = out.length;
  if (transcript === -1) out.push("", TRANSCRIPT_HEADING);
  out.push("", ...added, "");

  const typed = typeof session.notes === "string" ? session.notes.replace(/\s+$/, "") : "";
  if (typed.trim() !== "") {
    if (notes === -1) {
      /*
        No `## My notes` in the file any more. It goes back in above the
        transcript, where the renderer puts it, rather than the part's notes
        being dropped because the person tidied the heading away.
      */
      const at = transcript === -1 ? appendAt + 1 : transcript;
      out.splice(at, 0, NOTES_HEADING, "", ...typed.split("\n"), "");
    } else {
      // The section runs to whichever of our headings comes next, as `parseMeetingNote` reads it.
      const bounds = [summary, transcript].filter((index) => index > notes);
      const end = bounds.length ? Math.min(...bounds) : appendAt;
      let last = end - 1;
      while (last > notes && out[last] === "") last -= 1;
      out.splice(last + 1, 0, "", ...typed.split("\n"));
    }
  }

  return out.join("\n");
}

/**
 * What a meeting note says about the meeting, for offering to resume it.
 *
 * `null` for anything that is not a meeting note — no `type: meeting`, no
 * `meeting-id` — which includes an encrypted note, whose frontmatter is inside
 * the envelope.
 *
 * `recordedMs` is read from the file rather than remembered, because the
 * device resuming a meeting need not be the one that recorded it: the larger
 * of `duration` and the last clock in the transcript. `duration` is written to
 * the minute, so the next part's clocks start where the file says the meeting
 * got to, not a minute before its last turn.
 *
 * @param {string} markdown
 * @returns {{meetingId: string, title: string, endedAt: string|null, recordedMs: number, parts: number}|null}
 */
export function meetingNoteFacts(markdown) {
  const text = String(markdown ?? "");
  const parsed = parseMeetingNote(text);
  if (parsed.frontmatter.type !== "meeting") return null;
  const meetingId = parsed.frontmatter["meeting-id"];
  if (typeof meetingId !== "string" || meetingId === "") return null;

  const ended = parsed.frontmatter.ended;
  let lastClock = 0;
  let parts = 1;
  for (const line of (parsed.transcript ?? "").split("\n")) {
    if (line.startsWith(RESUMED_PREFIX)) parts += 1;
    const clock = /^\*\*\[(?:(\d+):)?(\d{2}):(\d{2})\]/.exec(line);
    if (clock) {
      const ms = ((Number(clock[1] ?? 0) * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1000;
      if (ms > lastClock) lastClock = ms;
    }
  }

  return {
    meetingId,
    title: parsed.title,
    endedAt: typeof ended === "string" && ended !== "" ? ended : null,
    recordedMs: Math.max(parseDuration(parsed.frontmatter.duration), lastClock),
    parts,
  };
}

/**
 * `formatDuration`, backwards: `45s`, `31m`, `1h 05m`. Anything else is zero.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function parseDuration(value) {
  if (typeof value !== "string") return 0;
  const text = value.trim();
  let match = /^(\d+)s$/.exec(text);
  if (match) return Number(match[1]) * 1000;
  match = /^(\d+)m$/.exec(text);
  if (match) return Number(match[1]) * 60_000;
  match = /^(\d+)h (\d{1,2})m$/.exec(text);
  if (match) return (Number(match[1]) * 60 + Number(match[2])) * 60_000;
  return 0;
}
