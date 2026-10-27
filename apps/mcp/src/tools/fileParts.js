/**
 * A FILE'S WORDS IN PARTS, AND A TABLE'S FACTS WORKED OUT BY THE GATEWAY
 * (the owner's review of a chat, 2026-10-24).
 *
 * Tex read a bank export of 8,530 rows for a spending breakdown. It saw the
 * first 100,000 characters ("the file was too long for me to read every
 * row"), and it reported rent going out twice a month ($7,700) because the
 * export held every Bank of America row from Aug 1 to Sep 18 twice; it found
 * that only when the person asked "probably duplicate rows? please check your
 * work".
 *
 * So every reader of a file (`read_file`, an email's attachment with
 * `read_email`, a file Tex kept, `agent/keptFiles.js`) hands back:
 *
 *   - a part of the words, `MAX_FILE_CHARS` at most, ending at a line break,
 *     with where the next part starts (`from`), so a long file is read whole;
 *   - for a CSV or TSV, facts counted over the WHOLE file on every part: its
 *     rows, the rows that repeat another row exactly (with the first few, by
 *     line), and each column of amounts totalled with and without those
 *     repeats, so a total can be checked against the gateway's own sum.
 *
 * A table's bytes are read as text here rather than through Workers AI's
 * `toMarkdown`: a CSV is already words, and the facts need its real rows.
 */

/** Most characters handed back in one part. */
export const PART_CHARS = 100_000;
/** Duplicate rows named, at most, by line. */
const MAX_EXAMPLES = 3;
/** Columns totalled, at most. */
const MAX_TOTALS = 6;

const TABLE_TYPES = new Set(["text/csv", "text/tab-separated-values"]);
const TABLE_NAME = /\.(?:csv|tsv)$/i;

/** Whether a file is a table whose facts are worked out here. */
export function isTable(name, type) {
  return TABLE_TYPES.has(String(type ?? "").split(";")[0].trim().toLowerCase()) || TABLE_NAME.test(String(name ?? ""));
}

/** One CSV (or TSV) line's cells, quotes honoured. A quoted cell spanning lines is rare in an export and is read as two rows. */
export function cells(line, delimiter = ",") {
  const out = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out.map((value) => value.trim());
}

/** An amount as a number: "-1,234.50", "$82.10", "(45.00)"; null for anything else. */
function amount(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const negative = /^\(.*\)$/.test(raw) || /^-/.test(raw.replace(/^\$/, ""));
  const digits = raw.replace(/[()$£€,\s]/g, "").replace(/^-/, "");
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return null;
  const n = Number(digits);
  return negative ? -n : n;
}

const money = (n) => (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The facts of a whole table: `{ rows, header, duplicates, examples, totals }`.
 * A duplicate is a row identical to an earlier one in every cell.
 */
export function tableFacts(text, name = "") {
  const delimiter = /\.tsv$/i.test(name) || (!/,/.test(text.slice(0, 2000)) && /\t/.test(text.slice(0, 2000))) ? "\t" : ",";
  const lines = text.split(/\r?\n/);
  const header = cells(lines[0] ?? "", delimiter);
  const seen = new Map();
  const examples = [];
  // The same payment twice, from two accounts or a reconnected bank: same day, amount and payee, something else different.
  const find = (pattern) => header.findIndex((title) => pattern.test(title));
  const dateAt = find(/^(?:transaction )?date$|^date\b/i);
  const amountAt = find(/amount/i);
  const payeeAt = find(/^(?:name|description|payee|merchant|memo)$/i);
  const likeKeys = dateAt >= 0 && amountAt >= 0 && payeeAt >= 0 ? new Set() : null;
  let alike = 0;
  const all = header.map(() => ({ sum: 0, numbers: 0, filled: 0 }));
  const once = header.map(() => 0);
  let rows = 0;
  let duplicates = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    rows += 1;
    const values = cells(line, delimiter);
    const key = values.join("\u0000");
    const first = seen.get(key);
    const repeat = first !== undefined;
    if (repeat) {
      duplicates += 1;
      if (examples.length < MAX_EXAMPLES) examples.push({ line: i + 1, sameAs: first });
    } else seen.set(key, i + 1);
    if (likeKeys !== null && !repeat) {
      const like = [values[dateAt], values[amountAt], (values[payeeAt] ?? "").toLowerCase()].join("\u0000");
      if (likeKeys.has(like)) alike += 1;
      else likeKeys.add(like);
    }
    header.forEach((_, column) => {
      const value = values[column];
      if (value === undefined || value === "") return;
      all[column].filled += 1;
      const n = amount(value);
      if (n === null) return;
      all[column].numbers += 1;
      all[column].sum += n;
      if (!repeat) once[column] += n;
    });
  }
  // A column of amounts: nearly every filled cell a number, and money-shaped (not a year, an id or a count).
  const totals = header
    .map((title, column) => ({ title: title || `column ${column + 1}`, column, ...all[column], once: once[column] }))
    .filter((entry) => entry.filled > 0 && entry.numbers / entry.filled >= 0.95 && /amount|total|debit|credit|price|cost|balance|value|paid|spent/i.test(entry.title))
    .slice(0, MAX_TOTALS);
  return { rows, header, duplicates, examples, totals, alike, alikeBy: likeKeys === null ? null : [header[dateAt], header[amountAt], header[payeeAt]] };
}

/** The facts as lines above a part. */
export function factLines(facts) {
  const lines = [`rows: ${facts.rows} (not counting the header)`, `header: ${facts.header.join(", ").slice(0, 500)}`];
  if (facts.duplicates > 0) {
    const which = facts.examples.map((example) => `line ${example.line} repeats line ${example.sameAs}`).join("; ");
    lines.push(
      `duplicate rows: ${facts.duplicates} rows repeat an earlier row in every column (${which}${facts.duplicates > facts.examples.length ? "; …" : ""}). ` +
        "An export that repeats rows counts them once: leave the repeats out of every total, and say you did.",
    );
  } else {
    lines.push("duplicate rows: none repeat another row exactly");
  }
  if (facts.alike > 0) {
    lines.push(
      `near-duplicate rows: ${facts.alike} more rows match an earlier row on ${facts.alikeBy.join(", ")} but differ in another column: ` +
        "the same payment seen twice (two accounts, a reconnected bank) or two real payments. Check them before you count them, and say which you decided.",
    );
  }
  for (const total of facts.totals) {
    lines.push(
      facts.duplicates > 0
        ? `total of ${total.title}: ${money(total.once)} with the repeated rows left out (${money(total.sum)} with them)`
        : `total of ${total.title}: ${money(total.sum)}`,
    );
  }
  lines.push(
    `For any total, average or breakdown (by month, by category, one payee), call this again with summary: { by: ["month", "<a column>"], where: [{ column, contains }], dates: { from, to } }: ` +
      "Context adds up every row, repeats left out. Never total rows yourself from a part.",
  );
  return lines;
}

/**
 * One part of `text` from `from`: at most `PART_CHARS`, ending at a line break
 * when there is one, so no row is cut in two. `{ part, from, to, total }`, or
 * null when `from` is past the end.
 */
export function partOf(text, from = 0) {
  const total = text.length;
  const start = Number.isInteger(from) && from > 0 ? from : 0;
  if (start > 0 && start >= total) return null;
  let to = Math.min(total, start + PART_CHARS);
  if (to < total) {
    const lineEnd = text.lastIndexOf("\n", to);
    if (lineEnd > start) to = lineEnd + 1;
  }
  return { part: text.slice(start, to), from: start, to, total };
}

/** The lines that say which part this is and how to read the next one. */
export function partLines(part, next) {
  const lines = [`characters: ${part.from} to ${part.to} of ${part.total}`];
  if (part.to < part.total) lines.push(`more: ${next(part.to)} reads the next part; read every part before you total anything`);
  return lines;
}

/** A date cell as `YYYY-MM-DD`: "2026-08-03", "08/03/2026", "8/3/26"; null for anything else. */
export function isoDate(value) {
  const raw = String(value ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/.exec(raw);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

/** Most groups listed in one summary. */
const MAX_GROUPS = 300;

/**
 * Totals over a whole table, worked out here rather than by a model reading
 * every row (8,530 rows do not fit in one turn): rows matching `where` (each
 * `{ column, contains }`: that column's cell contains the text, any case) and dated between `dates.from`
 * and `dates.to`, grouped by `by` (column names; "month" is the date's
 * YYYY-MM), each group's row count and total of the amount column, with the
 * rows that repeat another exactly left out.
 *
 * @returns {{ lines: string[] } | { error: string }}
 */
export function tableSummary(text, name, { by = [], where = {}, dates = {} } = {}) {
  const delimiter = /\.tsv$/i.test(name) ? "\t" : ",";
  const lines = text.split(/\r?\n/);
  const header = cells(lines[0] ?? "", delimiter);
  const at = (title) => header.findIndex((cell) => cell.toLowerCase() === String(title).trim().toLowerCase());
  const dateAt = header.findIndex((title) => /^(?:transaction )?date$|^date\b/i.test(title));
  const amountAt = header.findIndex((title) => /amount/i.test(title));
  if (amountAt < 0) return { error: `no amount column to total; the columns are ${header.join(", ")}` };
  const groups = (Array.isArray(by) ? by : [by]).filter((g) => typeof g === "string" && g.trim()).slice(0, 3);
  const groupAt = groups.map((g) => (g.trim().toLowerCase() === "month" ? "month" : at(g)));
  const missing = groups.filter((_, i) => groupAt[i] === -1 || (groupAt[i] === "month" && dateAt < 0));
  // `[{ column, contains }]`, as the tools take it; `{ column: text }` too.
  const pairs = Array.isArray(where)
    ? where.filter((entry) => entry && typeof entry.column === "string").map((entry) => [entry.column, entry.contains ?? ""])
    : Object.entries(where && typeof where === "object" ? where : {});
  const filters = pairs.slice(0, 5).map(([column, value]) => [at(column), String(value).toLowerCase(), column]);
  const unknown = filters.filter(([column]) => column < 0).map(([, , title]) => title);
  if (missing.length > 0 || unknown.length > 0) return { error: `no such column: ${[...missing, ...unknown].join(", ")}; the columns are ${header.join(", ")}` };
  const from = isoDate(dates?.from);
  const to = isoDate(dates?.to);
  if ((from || to) && dateAt < 0) return { error: "this table has no date column to filter by" };
  const seen = new Set();
  const totals = new Map();
  let matched = 0;
  let repeats = 0;
  let sum = 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    const values = cells(lines[i], delimiter);
    const day = dateAt >= 0 ? isoDate(values[dateAt]) : null;
    if ((from && (!day || day < from)) || (to && (!day || day > to))) continue;
    if (filters.some(([column, value]) => !String(values[column] ?? "").toLowerCase().includes(value))) continue;
    const key = values.join("\u0000");
    if (seen.has(key)) {
      repeats += 1;
      continue;
    }
    seen.add(key);
    const n = amount(values[amountAt]);
    if (n === null) continue;
    matched += 1;
    sum += n;
    const group = groupAt.map((column) => (column === "month" ? (day ?? "no date").slice(0, 7) : values[column] || "(blank)")).join(" · ") || "all";
    const entry = totals.get(group) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += n;
    totals.set(group, entry);
  }
  const sorted = [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    lines: [
      `summary of ${header[amountAt]}${groups.length ? ` by ${groups.join(", ")}` : ""}${filters.length ? `, where ${filters.map(([, v, t]) => `${t} contains "${v}"`).join(" and ")}` : ""}${from || to ? `, dated ${from ?? "start"} to ${to ?? "end"}` : ""}:`,
      `${matched} rows, total ${money(sum)}${repeats > 0 ? `; ${repeats} repeated rows left out` : ""}`,
      ...sorted.slice(0, MAX_GROUPS).map(([group, entry]) => `${group}: ${money(entry.total)} (${entry.count} rows)`),
      ...(sorted.length > MAX_GROUPS ? [`… ${sorted.length - MAX_GROUPS} more groups; narrow it with where or dates`] : []),
      "Counted by Context over every row of the file, not by reading it: quote these totals as they are.",
    ],
  };
}
