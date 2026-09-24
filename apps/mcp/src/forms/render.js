/* ------------------------------- rendering ------------------------------- */

/** The marker that says a note is this form's response file, and nothing else. */
export function responsesMarker(config) {
  return `<!-- context:form responses id=${config.id} layout=${config.layout} -->`;
}

export const MARKER_RE = /^<!--\s*context:form responses id=([a-z0-9-]+) layout=(table|sections)\s*-->$/;

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

export function columnsFor(config) {
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

