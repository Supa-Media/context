/**
 * Mail on a note: messages agents (and people) working on one note leave for
 * each other, kept in the note's own file.
 *
 * Decided with the owner, 2026-10-15 (docs/decisions/note-mail.md). Agents
 * cannot be woken by a server, so this is mail, not chat: an orchestrator sets
 * how often everyone checks, and every Context answer to an agent that joined
 * says how many messages are new for it.
 *
 * ## The format
 *
 * One fenced block with the info string `mail`, append-only, one entry per
 * line:
 *
 *     ```mail
 *     - 2026-10-15T18:20:00.000Z lead (Claude) joined
 *     - 2026-10-15T18:21:04.512Z lead (Claude) to everyone: Plan is above. We check mail every 10 minutes.
 *     - 2026-10-15T18:25:40.001Z builder (Codex) to lead: Pricing page done.
 *         A second line is indented four spaces.
 *     - 2026-10-15T18:26:00.000Z @seyi to everyone: Keep the launch on Tuesday.
 *     ```
 *
 * A sender is a name an agent chose when it joined (`[a-z0-9-]`, up to 24) with
 * its app in brackets, or a person's `@handle`. A recipient is `everyone` or a
 * name. Later lines of a message are indented four spaces, deeper than a
 * closing fence may be, so no message can end the block.
 *
 * ## Why append-only, and why here
 *
 * Every write is an insertion at the end of the block, which the collaborative
 * editor merges without losing anybody's line, and nothing here edits or
 * removes one. The block is plain Markdown in the note (non-negotiable #3),
 * so, as with comments, anybody who may write the note may also edit it by
 * hand; the tools never do. It is hidden wherever comments are (share links,
 * websites, search: `stripComments` removes both), and does not count
 * towards a note's length.
 */

"use strict";

const comments = require("./comments.cjs");

const MAIL_INFO = "mail";
const EVERYONE = "everyone";
const NAME = "[a-z0-9][a-z0-9-]{0,23}";
const NAME_RE = new RegExp(`^${NAME}$`);
const PERSON = "@[a-z0-9][a-z0-9-]{0,63}";
const LINE_RE = new RegExp(
  `^- (\\S+) (${NAME}|${PERSON})(?: \\(([^()\\n]{1,40})\\))? (?:(joined)|to (${NAME}): ?(.*))$`
);
const CONTINUATION = "    ";
/** Longest message kept, in characters. */
const MAX_TEXT = 4000;

/** The note's mail block: the last closed ```mail fence, or null. */
function findMailBlock(text) {
  const blocks = comments.fencedBlocks(typeof text === "string" ? text : "").filter((b) => b.info === MAIL_INFO && b.closed);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

/**
 * Every entry, oldest first: `{ at, from, app, kind: "joined" | "mail", to,
 * text, start, end }`. Lines the parser does not recognise are skipped: people
 * may edit the file by hand.
 */
function parseMail(text) {
  const source = typeof text === "string" ? text : "";
  const block = findMailBlock(source);
  if (!block) return { block: null, events: [] };
  const events = [];
  let last = null;
  for (const row of comments.lines(source.slice(block.bodyStart, block.bodyEnd))) {
    if (block.bodyStart + row.start >= block.bodyEnd) break;
    const match = LINE_RE.exec(row.text);
    if (match && Number.isFinite(Date.parse(match[1]))) {
      last = {
        at: match[1],
        from: match[2],
        app: match[3] ?? null,
        kind: match[4] ? "joined" : "mail",
        to: match[4] ? null : match[5],
        text: match[4] ? "" : match[6],
        start: block.bodyStart + row.start,
        end: block.bodyStart + row.next,
      };
      events.push(last);
      continue;
    }
    if (last && last.kind === "mail" && row.text.startsWith(CONTINUATION)) {
      last.text += `\n${row.text.slice(CONTINUATION.length)}`;
      last.end = block.bodyStart + row.next;
      continue;
    }
    last = null;
  }
  return { block, events };
}

/**
 * A name an agent may join as: lower case, spaces become dashes, anything
 * else dropped; `null` when nothing usable is left or it is `everyone`.
 */
function mailName(raw) {
  const name = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+/, "")
    .slice(0, 24)
    .replace(/-+$/, "");
  if (!NAME_RE.test(name) || name === EVERYONE) return null;
  return name;
}

/** An app's name as it may appear in brackets: no brackets, colons or line breaks. */
function appName(raw) {
  const cleaned = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029()]/g, " ")
    .replace(/:/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return cleaned || null;
}

/** A message as log lines: the first after the colon, the rest indented. */
function formatText(text) {
  const rows = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim()
    .split("\n");
  return rows.map((row, i) => (i === 0 ? row : row ? `${CONTINUATION}${row}` : CONTINUATION.trimEnd())).join("\n");
}

/**
 * Append one entry. Returns `{ changes }` against `text` (apply them with
 * `applyChanges`), or `{ error }`. `entry` is `{ at, from, app, kind, to,
 * text }`; `from` is a joined name or an `@handle`.
 */
function appendMail(text, entry) {
  const source = typeof text === "string" ? text : "";
  const at = typeof entry?.at === "string" && Number.isFinite(Date.parse(entry.at)) ? entry.at : new Date().toISOString();
  const from = String(entry?.from ?? "");
  if (!new RegExp(`^(${NAME}|${PERSON})$`).test(from)) return { error: "mail needs a sender name" };
  const app = entry?.app ? appName(entry.app) : null;
  const who = app ? `${from} (${app})` : from;
  let line;
  if (entry?.kind === "joined") {
    line = `- ${at} ${who} joined`;
  } else {
    const to = entry?.to ?? EVERYONE;
    if (!NAME_RE.test(to)) return { error: `mail.to must be "${EVERYONE}" or a name that joined` };
    const body = formatText(entry?.text);
    if (!body) return { error: "mail.text is empty" };
    if (body.length > MAX_TEXT) return { error: `mail.text is too long; keep a message under ${MAX_TEXT} characters` };
    line = `- ${at} ${who} to ${to}: ${body}`;
  }
  const block = findMailBlock(source);
  if (block) {
    // Before the closing fence. `bodyEnd` is where that fence line starts.
    const before = source.slice(block.bodyStart, block.bodyEnd);
    const insert = before === "" || before.endsWith("\n") ? `${line}\n` : `\n${line}\n`;
    return { changes: [{ from: block.bodyEnd, to: block.bodyEnd, insert }] };
  }
  const lead = source === "" ? "" : source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : "\n\n";
  return { changes: [{ from: source.length, to: source.length, insert: `${lead}\`\`\`${MAIL_INFO}\n${line}\n\`\`\`\n` }] };
}

/** The note without its mail block, and the blank lines that led up to it. */
function stripMail(text) {
  const source = typeof text === "string" ? text : "";
  const block = findMailBlock(source);
  if (!block) return source;
  let start = block.start;
  while (start > 0 && source[start - 1] === "\n") start -= 1;
  const tail = source.slice(block.end).replace(/^\n+/, "");
  return source.slice(0, start) + (start > 0 ? "\n" : "") + tail;
}

/**
 * The messages that are new for one member: after `since` (an ISO time),
 * addressed to them or to everyone, and not their own.
 */
function newFor(events, name, since) {
  const after = Number.isFinite(Date.parse(since)) ? Date.parse(since) : -Infinity;
  return events.filter(
    (event) =>
      event.kind === "mail" &&
      Date.parse(event.at) > after &&
      event.from !== name &&
      (event.to === EVERYONE || event.to === name)
  );
}

/** One entry as an agent reads it. */
function describeEntry(event) {
  const who = event.app ? `${event.from} (${event.app})` : event.from;
  if (event.kind === "joined") return `- ${event.at} ${who} joined`;
  const body = event.text.split("\n").join(`\n${CONTINUATION}`);
  return `- ${event.at} ${who} to ${event.to}: ${body}`;
}

module.exports = {
  MAIL_INFO,
  EVERYONE,
  findMailBlock,
  parseMail,
  mailName,
  appName,
  appendMail,
  stripMail,
  newFor,
  describeEntry,
};
