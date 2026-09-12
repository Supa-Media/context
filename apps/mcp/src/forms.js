/**
 * Markdown forms: the grammar, the validator, and the response renderer.
 *
 * ## What this file is for
 *
 * A note may carry a fenced ```form block. That block declares fields and one
 * policy — who may submit, whether a submitter may edit their own answer,
 * whether votes are kept. Answers are written to a **separate note**, named by
 * the block, whose visibility is decided the ordinary way in `privacy.md` and
 * never by the block. The gateway renders every response row itself; a
 * submitter sends values and never Markdown.
 *
 * ## Three rules hold the whole design up
 *
 * 1. **The gateway writes the response file, so it can round-trip it.**
 *    Editing one answer or taking back one vote means finding a response in a
 *    file and rewriting it, which means parsing back what we rendered. So
 *    `renderResponsesFile(parseResponsesFile(x))` must equal `x` for anything
 *    we produced — that is the property `formsRoundTrip` checks, and every
 *    escaping rule below exists to keep it true for arbitrary submitted text.
 *
 * 2. **A block that does not parse makes the form inert, never half-working.**
 *    Same discipline as the privacy manifest: fail closed. `parseFormBlocks`
 *    returns the error rather than a best guess, callers refuse submissions,
 *    and the surrounding note stays ordinary readable Markdown.
 *
 * 3. **Layout is declared, not inferred.** `table` puts a response on one row;
 *    `sections` gives it a heading. A paragraph field in a table is allowed —
 *    it renders cramped, which is the author's call to make. What is *not*
 *    allowed is losing it: a raw newline in a cell would end the row and spill
 *    the rest of the answer out of the table, so cells are escaped.
 *
 * Zero dependencies, Workers runtime: no Node APIs, no YAML library. The
 * grammar is deliberately a small strict subset rather than "some YAML", so
 * that what an editor's autocomplete offers and what this accepts are the same
 * list.
 */

/** The info string that marks a fenced block as a form. */
export const FORM_FENCE_LANG = "form";

/** Field types, and whether a value may span lines. */
const FIELD_TYPES = new Map([
  ["line", { multiline: false, needsMax: true }],
  ["text", { multiline: true, needsMax: true }],
  ["select", { multiline: false, needsMax: false }],
  ["number", { multiline: false, needsMax: false }],
  ["date", { multiline: false, needsMax: false }],
  ["checkbox", { multiline: false, needsMax: false }],
]);

/** Every key the block accepts. Anything else is an error, not a warning. */
const CONFIG_KEYS = new Set(["id", "responses", "layout", "submit", "edit_own", "votes", "fields"]);

/** Every key one field entry accepts. */
const FIELD_KEYS = new Set(["name", "type", "max", "min", "required", "options"]);

const LAYOUTS = new Set(["table", "sections"]);
const SUBMIT_ROLES = new Set(["member", "editor", "owner"]);
const VOTE_MODES = new Set(["named", "off"]);

/**
 * Column headings the renderer owns, so a field may not be called one of them.
 *
 * Case-insensitive: a field named `votes` and the votes column would render two
 * columns with one heading, and parsing that back is a guess.
 */
const RESERVED_FIELD_NAMES = new Set(["id", "by", "at", "votes"]);

const MAX_FIELDS = 24;
const MAX_OPTIONS = 24;
const MAX_OPTION_LENGTH = 64;
const MAX_LINE_CAP = 500;
const MAX_TEXT_CAP = 20000;

const FORM_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELD_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESPONSE_ID_RE = /^r-[0-9a-f]{8}$/;

/* ------------------------------- the fence ------------------------------- */

/**
 * Every ```form block in a note, parsed.
 *
 * Returns one entry per block in document order, each either `{ config }` or
 * `{ error }` — never both, and never a partially applied config. A note with
 * no form block returns an empty array, which is the overwhelmingly common
 * case and costs one `indexOf`.
 *
 * Blocks are found by scanning lines rather than with a regex over the whole
 * note, because a note legitimately contains other fenced blocks (including
 * ones *quoting* a form block in a tutorial) and the only honest way to know
 * which fence a line closes is to walk them in order.
 */
export function parseFormBlocks(text) {
  if (typeof text !== "string" || !text.includes(FORM_FENCE_LANG)) return [];
  const lines = text.split("\n");
  const blocks = [];
  let fence = null; // the open fence's marker, e.g. "```"
  let isForm = false;
  let body = [];
  let openedAt = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opener = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`~]*)\s*$/.exec(line);
    if (fence === null) {
      if (opener) {
        fence = opener[2][0].repeat(opener[2].length);
        isForm = opener[3].toLowerCase() === FORM_FENCE_LANG;
        body = [];
        openedAt = i;
      }
      continue;
    }
    // Inside a fence. It closes on a marker of the same character, at least as
    // long, with no info string.
    const closer = /^(\s{0,3})(`{3,}|~{3,})\s*$/.exec(line);
    if (closer && closer[2][0] === fence[0] && closer[2].length >= fence.length) {
      if (isForm) blocks.push({ ...parseFormBody(body), line: openedAt + 1 });
      fence = null;
      isForm = false;
      body = [];
      continue;
    }
    if (isForm) body.push(line);
  }
  // An unclosed form fence is an error the author can see and fix, not a block
  // we quietly read to the end of the note.
  if (fence !== null && isForm) {
    blocks.push({ error: "the form block is never closed", line: openedAt + 1 });
  }
  return blocks;
}

/** Parse one block body into a config, or into the first reason it is not one. */
function parseFormBody(lines) {
  const raw = new Map();
  const fields = [];
  let inFields = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;

    if (inFields && /^\s+-\s/.test(line)) {
      const entry = parseInlineMap(line.replace(/^\s+-\s*/, ""));
      if (entry.error) return { error: `field ${fields.length + 1}: ${entry.error}` };
      fields.push(entry.map);
      continue;
    }

    const keyed = /^([a-z_]+)\s*:\s*(.*)$/.exec(line);
    if (!keyed) return { error: `line ${i + 1} of the block is not "key: value"` };
    const key = keyed[1];
    const value = keyed[2].trim();
    if (!CONFIG_KEYS.has(key)) {
      return { error: `unknown key "${key}" (accepted: ${[...CONFIG_KEYS].join(", ")})` };
    }
    if (raw.has(key)) return { error: `"${key}" is set twice` };
    if (key === "fields") {
      if (value) return { error: '"fields" takes a list on the lines beneath it, not a value' };
      inFields = true;
      raw.set(key, true);
      continue;
    }
    inFields = false;
    raw.set(key, value);
  }

  return normalizeConfig(raw, fields);
}

/**
 * `{ name: summary, type: line, max: 120 }` → a map.
 *
 * A hand-rolled scanner rather than a regex, because a bracketed list may hold
 * commas and a quoted scalar may hold both commas and colons — and a regex that
 * gets that almost right is the kind of parser that accepts a form nobody can
 * round-trip.
 */
function parseInlineMap(source) {
  const text = source.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return { error: 'expected { key: value, … } on one line' };
  }
  const inner = text.slice(1, -1);
  const map = new Map();
  let i = 0;

  const skipSpace = () => {
    while (i < inner.length && /\s/.test(inner[i])) i++;
  };

  while (i < inner.length) {
    skipSpace();
    if (i >= inner.length) break;
    const keyStart = i;
    while (i < inner.length && /[a-z_]/.test(inner[i])) i++;
    const key = inner.slice(keyStart, i);
    if (!key) return { error: `unexpected "${inner[i]}"` };
    skipSpace();
    if (inner[i] !== ":") return { error: `"${key}" is missing its colon` };
    i++;
    skipSpace();

    let value;
    if (inner[i] === "[") {
      const end = inner.indexOf("]", i);
      if (end === -1) return { error: `the list after "${key}" is never closed` };
      const body = inner.slice(i + 1, end);
      i = end + 1;
      value = body
        .split(",")
        .map((part) => unquote(part.trim()))
        .filter((part) => part !== "");
      if (value.some((part) => part === null)) return { error: `the list after "${key}" has an unclosed quote` };
    } else if (inner[i] === '"') {
      const scanned = scanQuoted(inner, i);
      if (!scanned) return { error: `the value of "${key}" has an unclosed quote` };
      value = scanned.value;
      i = scanned.next;
    } else {
      const start = i;
      while (i < inner.length && inner[i] !== ",") i++;
      value = inner.slice(start, i).trim();
    }

    if (map.has(key)) return { error: `"${key}" is set twice` };
    map.set(key, value);
    skipSpace();
    if (i < inner.length) {
      if (inner[i] !== ",") return { error: `expected a comma after "${key}"` };
      i++;
    }
  }
  return { map };
}

function scanQuoted(source, at) {
  if (source[at] !== '"') return null;
  let out = "";
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === "\\" && i + 1 < source.length) {
      out += source[i + 1];
      i++;
      continue;
    }
    if (source[i] === '"') return { value: out, next: i + 1 };
    out += source[i];
  }
  return null;
}

/** A bare or double-quoted scalar; `null` when the quoting is broken. */
function unquote(part) {
  if (!part.startsWith('"')) return part;
  const scanned = scanQuoted(part, 0);
  return scanned && scanned.next === part.length ? scanned.value : null;
}

/* ------------------------------ the config ------------------------------- */

function normalizeConfig(raw, fieldMaps) {
  const id = raw.get("id");
  if (typeof id !== "string" || !id) return { error: '"id" is required' };
  if (!FORM_ID_RE.test(id)) {
    return { error: '"id" must be lowercase letters, digits and dashes (max 40)' };
  }

  const responses = raw.get("responses");
  if (typeof responses !== "string" || !responses) return { error: '"responses" is required' };
  if (!responses.endsWith(".md")) return { error: '"responses" must be a path ending in .md' };

  const layout = raw.get("layout");
  if (typeof layout !== "string" || !layout) {
    return { error: '"layout" is required — use table or sections' };
  }
  if (!LAYOUTS.has(layout)) return { error: '"layout" must be table or sections' };

  const submit = raw.has("submit") ? raw.get("submit") : "member";
  if (!SUBMIT_ROLES.has(submit)) return { error: '"submit" must be member, editor or owner' };

  const editOwn = raw.has("edit_own") ? parseBool(raw.get("edit_own")) : true;
  if (editOwn === null) return { error: '"edit_own" must be true or false' };

  const votes = raw.has("votes") ? raw.get("votes") : "off";
  if (!VOTE_MODES.has(votes)) return { error: '"votes" must be named or off' };

  if (!raw.has("fields")) return { error: '"fields" is required' };
  if (!fieldMaps.length) return { error: "a form needs at least one field" };
  if (fieldMaps.length > MAX_FIELDS) return { error: `a form takes at most ${MAX_FIELDS} fields` };

  const fields = [];
  const seen = new Set();
  for (const map of fieldMaps) {
    const field = normalizeField(map);
    if (field.error) return field;
    if (seen.has(field.name)) return { error: `two fields are called "${field.name}"` };
    seen.add(field.name);
    fields.push(field);
  }

  return { config: { id, responses, layout, submit, edit_own: editOwn, votes, fields } };
}

function normalizeField(map) {
  for (const key of map.keys()) {
    if (!FIELD_KEYS.has(key)) {
      return { error: `unknown key "${key}" (accepted: ${[...FIELD_KEYS].join(", ")})` };
    }
  }
  const name = map.get("name");
  if (typeof name !== "string" || !name) return { error: '"name" is required' };
  if (!FIELD_NAME_RE.test(name)) {
    return { error: `"${name}" must be lowercase letters, digits and underscores, starting with a letter` };
  }
  if (RESERVED_FIELD_NAMES.has(name)) {
    return { error: `"${name}" is a column this gateway writes; choose another name` };
  }

  const type = map.get("type");
  if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
    return { error: `"${name}": type must be one of ${[...FIELD_TYPES.keys()].join(", ")}` };
  }
  const spec = FIELD_TYPES.get(type);
  const field = { name, type, required: false };

  if (map.has("required")) {
    const required = parseBool(map.get("required"));
    if (required === null) return { error: `"${name}": required must be true or false` };
    field.required = required;
  }

  if (spec.needsMax) {
    if (!map.has("max")) {
      return { error: `"${name}": a ${type} field needs max, so a submission cannot be unbounded` };
    }
    const cap = Number(map.get("max"));
    const ceiling = type === "text" ? MAX_TEXT_CAP : MAX_LINE_CAP;
    if (!Number.isInteger(cap) || cap < 1 || cap > ceiling) {
      return { error: `"${name}": max must be a whole number from 1 to ${ceiling}` };
    }
    field.max = cap;
  } else if (map.has("max") && type !== "number") {
    return { error: `"${name}": max applies to line, text and number fields only` };
  }

  if (type === "select") {
    const options = map.get("options");
    if (!Array.isArray(options) || !options.length) {
      return { error: `"${name}": a select field needs options: [a, b, …]` };
    }
    if (options.length > MAX_OPTIONS) {
      return { error: `"${name}": at most ${MAX_OPTIONS} options` };
    }
    if (options.some((option) => option.length > MAX_OPTION_LENGTH)) {
      return { error: `"${name}": an option may be at most ${MAX_OPTION_LENGTH} characters` };
    }
    if (options.some((option) => /[\r\n|]/.test(option))) {
      return { error: `"${name}": an option may not contain a newline or a pipe` };
    }
    if (new Set(options).size !== options.length) {
      return { error: `"${name}": two options are the same` };
    }
    field.options = options;
  } else if (map.has("options")) {
    return { error: `"${name}": options applies to a select field only` };
  }

  if (type === "number") {
    for (const bound of ["min", "max"]) {
      if (!map.has(bound)) continue;
      const value = Number(map.get(bound));
      if (!Number.isFinite(value)) return { error: `"${name}": ${bound} must be a number` };
      field[bound] = value;
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
      return { error: `"${name}": min is greater than max` };
    }
  } else if (map.has("min")) {
    return { error: `"${name}": min applies to a number field only` };
  }

  return field;
}

function parseBool(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

/* ---------------------------- submitted values --------------------------- */

/**
 * Check one submission against the form, and normalize it to strings.
 *
 * Everything stored in the response file is a string, because the file is the
 * record and a number that came back as `1.0` where `1` went in is a diff
 * nobody asked for. Coercion happens once, here, and the rendered value is
 * what a later read gets back verbatim.
 */
export function validateSubmission(config, values) {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    return { error: "values must be an object of field names to answers" };
  }
  const known = new Set(config.fields.map((field) => field.name));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) return { error: `there is no field called "${key}" on this form` };
  }

  const out = {};
  for (const field of config.fields) {
    const supplied = values[field.name];
    const missing = supplied === undefined || supplied === null || supplied === "";
    if (missing) {
      if (field.required) return { error: `"${field.name}" is required` };
      out[field.name] = "";
      continue;
    }
    const checked = normalizeValue(field, supplied);
    if (checked.error) return checked;
    out[field.name] = checked.value;
  }
  return { values: out };
}

function normalizeValue(field, supplied) {
  switch (field.type) {
    case "checkbox": {
      const parsed = parseBool(typeof supplied === "string" ? supplied.toLowerCase() : supplied);
      if (parsed === null) return { error: `"${field.name}" must be true or false` };
      return { value: parsed ? "yes" : "no" };
    }
    case "number": {
      const value = typeof supplied === "number" ? supplied : Number(String(supplied).trim());
      if (!Number.isFinite(value)) return { error: `"${field.name}" must be a number` };
      if (field.min !== undefined && value < field.min) {
        return { error: `"${field.name}" must be at least ${field.min}` };
      }
      if (field.max !== undefined && value > field.max) {
        return { error: `"${field.name}" must be at most ${field.max}` };
      }
      return { value: String(value) };
    }
    case "date": {
      const value = String(supplied).trim();
      if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        return { error: `"${field.name}" must be a date like 2026-09-12` };
      }
      return { value };
    }
    case "select": {
      const value = String(supplied).trim();
      if (!field.options.includes(value)) {
        return { error: `"${field.name}" must be one of: ${field.options.join(", ")}` };
      }
      return { value };
    }
    case "line": {
      if (typeof supplied !== "string") return { error: `"${field.name}" must be text` };
      const value = supplied.trim();
      if (/[\r\n]/.test(value)) return { error: `"${field.name}" must be a single line` };
      if (hasControlCharacters(value)) return { error: `"${field.name}" contains a control character` };
      if ([...value].length > field.max) {
        return { error: `"${field.name}" is longer than ${field.max} characters` };
      }
      return { value };
    }
    case "text": {
      if (typeof supplied !== "string") return { error: `"${field.name}" must be text` };
      const value = supplied.replace(/\r\n?/g, "\n").trim();
      if (hasControlCharacters(value.replace(/\n/g, ""))) {
        return { error: `"${field.name}" contains a control character` };
      }
      if ([...value].length > field.max) {
        return { error: `"${field.name}" is longer than ${field.max} characters` };
      }
      return { value };
    }
    default:
      return { error: `"${field.name}" has an unknown type` };
  }
}

function hasControlCharacters(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/* ------------------------------- rendering ------------------------------- */

/** The marker that says a note is this form's response file, and nothing else. */
export function responsesMarker(config) {
  return `<!-- context:form responses id=${config.id} layout=${config.layout} -->`;
}

const MARKER_RE = /^<!--\s*context:form responses id=([a-z0-9-]+) layout=(table|sections)\s*-->$/;

/** A brand-new, empty response file for this form. */
export function emptyResponsesFile(config) {
  return `${responsesMarker(config)}\n\n${renderBody(config, [])}`;
}

/** A response id: short, readable, and impossible to confuse with a username. */
export function newResponseId() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `r-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** The timestamp stamped on a response. Minute precision: a file is read by people. */
export function responseStamp(date = new Date()) {
  return `${date.toISOString().slice(0, 16)}Z`;
}

/**
 * Render the whole response file.
 *
 * The whole file, never an append, because the layouts are not append-only
 * shapes: a table has a header that a first row has to arrive under, and an
 * edit or a vote rewrites a response in place. One renderer for create, edit,
 * delete and vote means there is one shape to round-trip rather than four.
 */
export function renderResponsesFile(config, responses) {
  return `${responsesMarker(config)}\n\n${renderBody(config, responses)}`;
}

function renderBody(config, responses) {
  return config.layout === "table"
    ? renderTable(config, responses)
    : renderSections(config, responses);
}

function columnsFor(config) {
  const columns = ["Id", "By", "At", ...config.fields.map((field) => field.name)];
  if (config.votes === "named") columns.push("Votes");
  return columns;
}

function renderTable(config, responses) {
  const columns = columnsFor(config);
  const rows = responses.map((response) => {
    const cells = [response.id, response.by, response.at];
    for (const field of config.fields) cells.push(escapeCell(response.values[field.name] ?? ""));
    if (config.votes === "named") cells.push(escapeCell(renderVotes(response.votes)));
    return cells;
  });

  const widths = columns.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index].length), 3)
  );
  const line = (cells) => `| ${cells.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
  const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
  return [line(columns), divider, ...rows.map(line)].join("\n") + "\n";
}

function renderSections(config, responses) {
  if (!responses.length) return "";
  const blocks = responses.map((response) => {
    const parts = [`## ${response.id} · ${response.by} · ${response.at}`, ""];
    const paragraphs = [];
    const bullets = [];
    for (const field of config.fields) {
      const value = response.values[field.name] ?? "";
      if (field.type === "text") {
        if (value) paragraphs.push(`**${field.name}:**`, "", escapeBlock(value), "");
        continue;
      }
      bullets.push(`- **${field.name}:** ${value === "" ? "—" : value}`);
    }
    if (bullets.length) parts.push(...bullets, "");
    parts.push(...paragraphs);
    if (config.votes === "named") parts.push(`**Votes:** ${renderVotes(response.votes)}`, "");
    return parts.join("\n");
  });
  return blocks.join("\n");
}

function renderVotes(votes) {
  return votes && votes.length ? votes.join(", ") : "—";
}

/**
 * A value on its way into a table cell.
 *
 * A raw newline does not merely look wrong in a cell — it ends the row, and
 * everything after it falls out of the table as loose text. So newlines become
 * `<br>`, which Obsidian renders as the line break it was. The HTML-ish escapes
 * run first so that a submission containing a literal `<br>` comes back as
 * itself rather than as a break, and the backslash escape runs before the pipe
 * so `\|` typed by a person survives too.
 */
export function escapeCell(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
}

const CELL_TOKEN_RE = /\\\\|\\\||<br>|&lt;|&gt;|&amp;/g;
const CELL_TOKENS = new Map([
  ["\\\\", "\\"],
  ["\\|", "|"],
  ["<br>", "\n"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&amp;", "&"],
]);

/**
 * The inverse, as one left-to-right scan rather than six replaces.
 *
 * Sequential replaces get this wrong in a way that only shows up on submitted
 * text: un-escaping `\|` before `\\` turns the two characters a person typed as
 * `\|` into one, so the round-trip silently loses a character.
 */
export function unescapeCell(value) {
  return value.replace(CELL_TOKEN_RE, (token) => CELL_TOKENS.get(token));
}

/**
 * A paragraph on its way into a section.
 *
 * Newlines are kept — that is the point of this layout — so the only ambiguity
 * is a submitted line that looks like the structure around it. Such a line gets
 * a Markdown backslash escape, which renders as the text itself and parses back
 * exactly. Lines that already begin with backslashes get one more, so the
 * escape is reversible rather than idempotent.
 */
const BLOCK_BOUNDARY_RE = /^\\*(?:#{1,6}\s|\*\*|-\s+\*\*)/;

export function escapeBlock(value) {
  return value
    .split("\n")
    .map((line) => (BLOCK_BOUNDARY_RE.test(line) ? `\\${line}` : line))
    .join("\n");
}

export function unescapeBlock(value) {
  return value
    .split("\n")
    .map((line) => (/^\\+(?:#{1,6}\s|\*\*|-\s+\*\*)/.test(line) ? line.slice(1) : line))
    .join("\n");
}

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
    if (/^##\s+(\S+)\s+·\s+(\S+)\s+·\s+(\S+)\s*$/.test(line)) break;
    if (line.trim() !== "") return { error: STRAY_SECTION_CONTENT };
  }

  for (const line of lines) {
    const header = /^##\s+(\S+)\s+·\s+(\S+)\s+·\s+(\S+)\s*$/.exec(line);
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
