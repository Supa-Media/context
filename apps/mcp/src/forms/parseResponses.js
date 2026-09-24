import { RESPONSE_ID_RE, SECTION_HEADER_RE } from "./grammar.js";
import { MARKER_RE, columnsFor, unescapeCell, unescapeBlock } from "./render.js";

/* -------------------------------- parsing -------------------------------- */

/**
 * Read a response file back into responses.
 *
 * Refuses anything it did not write: the marker must be the first line and must
 * name this form and this layout. That check is not tidiness — `responses:` is
 * an editor-chosen path, and without it a form pointed at `index.md` would let
 * the first submission rewrite somebody's front page.
 */
export function parseResponsesFile(text, config) {
  if (typeof text !== "string") return { error: "the response file is unreadable" };
  const lines = text.split("\n");
  const marker = MARKER_RE.exec((lines[0] || "").trim());
  if (!marker) return { error: "that file is not a form response file" };
  if (marker[1] !== config.id) {
    return { error: `that response file belongs to form "${marker[1]}"` };
  }
  if (marker[2] !== config.layout) {
    return {
      error:
        `that response file is laid out as ${marker[2]} and the form now says ${config.layout}. ` +
        "Point the form at a new response file; the existing answers are not rewritten.",
    };
  }
  const body = lines.slice(1);
  return config.layout === "table" ? parseTable(body, config) : parseSections(body, config);
}

/**
 * What a response file may not hold, said the same way for both layouts.
 *
 * Named constants because the refusal is the guarantee: a caller reading
 * "only the table" has to be able to act on it, and a message that drifts
 * between the two layouts reads as two different problems.
 */
const STRAY_TABLE_CONTENT =
  "this response file holds text outside its table, and a response is written by rewriting the " +
  "whole file — that text cannot be reproduced, so nothing has been written. Move the notes to " +
  "the form's own note, or point the form at a response file holding only the table.";

const STRAY_SECTION_CONTENT =
  "this response file holds text before its first response, and a response is written by " +
  "rewriting the whole file — that text cannot be reproduced, so nothing has been written. Move " +
  "the notes to the form's own note, or point the form at a response file holding only the responses.";

function parseTable(lines, config) {
  const columns = columnsFor(config);
  const trimmed = lines.map((line) => line.trim());
  // `renderTable` writes rows and nothing else, so a line that is neither a
  // row nor blank is content this file cannot be written back with. Refusing
  // is the point: dropping it parsed cleanly and made the next submission a
  // rewrite that deleted the author's own headings and notes — and the person
  // that write belongs to is a `member`, who cannot read a private response
  // file to see what went. Inert rather than half-working, the rule `forms.md`
  // states for a form block, applied to the file it names.
  const stray = trimmed.find((line) => line !== "" && !line.startsWith("|"));
  if (stray !== undefined) return { error: STRAY_TABLE_CONTENT };
  const rows = trimmed.filter((line) => line.startsWith("|"));
  if (!rows.length) return { error: "the response file has lost its table header" };
  const heading = splitRow(rows[0]);
  if (heading.length !== columns.length || heading.some((cell, i) => cell !== columns[i])) {
    return { error: "the response table's columns no longer match the form" };
  }
  const responses = [];
  for (const row of rows.slice(2)) {
    const cells = splitRow(row);
    if (cells.length !== columns.length) return { error: "a response row has the wrong number of columns" };
    const [id, by, at] = cells;
    if (!RESPONSE_ID_RE.test(id)) return { error: `"${id}" is not a response id` };
    const values = {};
    config.fields.forEach((field, index) => {
      values[field.name] = unescapeCell(cells[3 + index]);
    });
    const votes =
      config.votes === "named" ? parseVotes(unescapeCell(cells[columns.length - 1])) : [];
    responses.push({ id, by, at, values, votes });
  }
  return { responses };
}

/**
 * Split one table row on its unescaped pipes.
 *
 * Hand-written rather than a regex with a lookbehind, because `\\|` — an
 * escaped backslash followed by a real delimiter — is exactly what a lookbehind
 * for "not preceded by a backslash" gets wrong, and it is reachable from any
 * submission ending in a backslash.
 */
function splitRow(line) {
  const cells = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "\\" && i + 1 < line.length) {
      current += char + line[i + 1];
      i++;
      continue;
    }
    if (char === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  // A row is `| a | b |`, so the split yields an empty cell at each end.
  return cells.slice(1, -1).map((cell) => cell.trim());
}

function parseSections(lines, config) {
  const responses = [];
  let current = null;
  let pending = null; // the text field currently collecting lines
  const byName = new Map(config.fields.map((field) => [field.name, field]));

  const flush = () => {
    if (!current) return;
    if (pending) {
      current.values[pending.name] = unescapeBlock(pending.lines.join("\n").trim());
      pending = null;
    }
    responses.push(current);
    current = null;
  };
  const closePending = () => {
    if (!pending) return;
    current.values[pending.name] = unescapeBlock(pending.lines.join("\n").trim());
    pending = null;
  };

  // The same rule the table layout keeps, at the one place this layout can
  // hold a line the renderer will not write back: before the first response.
  // Everything after a header belongs to a text field and round-trips.
  for (const line of lines) {
    if (SECTION_HEADER_RE.test(line)) break;
    if (line.trim() !== "") return { error: STRAY_SECTION_CONTENT };
  }

  for (const line of lines) {
    const header = SECTION_HEADER_RE.exec(line);
    if (header && !isEscaped(line)) {
      flush();
      if (!RESPONSE_ID_RE.test(header[1])) return { error: `"${header[1]}" is not a response id` };
      current = {
        id: header[1],
        by: header[2],
        at: header[3],
        values: Object.fromEntries(config.fields.map((field) => [field.name, ""])),
        votes: [],
      };
      continue;
    }
    if (!current) continue;

    const bullet = /^-\s+\*\*([a-z][a-z0-9_]*):\*\*\s*(.*)$/.exec(line);
    if (bullet && byName.has(bullet[1]) && byName.get(bullet[1]).type !== "text") {
      closePending();
      current.values[bullet[1]] = bullet[2] === "—" ? "" : bullet[2];
      continue;
    }
    const votes = /^\*\*Votes:\*\*\s*(.*)$/.exec(line);
    if (votes && !isEscaped(line)) {
      closePending();
      current.votes = config.votes === "named" ? parseVotes(votes[1]) : [];
      continue;
    }
    const opener = /^\*\*([a-z][a-z0-9_]*):\*\*\s*$/.exec(line);
    if (opener && byName.has(opener[1]) && byName.get(opener[1]).type === "text" && !isEscaped(line)) {
      closePending();
      pending = { name: opener[1], lines: [] };
      continue;
    }
    if (pending) pending.lines.push(line);
  }
  flush();
  return { responses };
}

/** A structural line a submission escaped, so it is content rather than syntax. */
function isEscaped(line) {
  return line.startsWith("\\");
}

function parseVotes(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "—") return [];
  return trimmed
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

