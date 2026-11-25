/**
 * A "Fetch from a URL" source's settings, read from its folder's `about.md`,
 * and how one fetched answer becomes rows for its dataset sheet
 * (`docs/decisions/data-and-metrics.md`, "The sync object"). Pure.
 *
 * `about.md` is a note anyone who may edit the source folder can change, Tex
 * and an AI client included, so nothing here trusts it: the address goes
 * through `fetchDataset`'s lock on every run, the dataset's name is reduced to
 * a plain file name inside the source's own folder, and the `key:` and
 * `date:` columns only choose among the columns the answer has.
 *
 * The front matter it reads:
 *
 *     source: url
 *     url: https://example.com/numbers.json
 *     dataset: open-incidents
 *     key: id          (optional: the column that tells rows apart)
 *     date: opened     (optional: the column a row is dated by)
 */

import { frontMatterBlock } from "../../notes/format.js";

/** The words a source's `source:` may say for this kind; `fetch` is what stage B's app reads it as. */
const URL_KINDS = new Set(["url", "fetch"]);
const MAX_VALUE = 2048;
/** The column added when the answer has no date of its own: when the run fetched it, to the hour. */
export const FETCHED_COLUMN = "fetched";

/** One `key: value` line's value: a JSON-quoted string read as JSON, plain text trimmed, quotes of one kind dropped. */
function valueOf(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  return text;
}

/** The top-level `key: value` fields of a note's front matter, lower-cased keys, first one wins. */
export function frontMatterFields(text) {
  const block = frontMatterBlock(text);
  const fields = Object.create(null);
  if (block === "") return fields;
  for (const line of block.split(/\r?\n/).slice(1, -1)) {
    const match = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key in fields) continue;
    const value = valueOf(match[2]);
    if (value !== null && value.length <= MAX_VALUE) fields[key] = value;
  }
  return fields;
}

/** "Open incidents" → `open-incidents`, as the app names a dataset's sheet (`dataWrites.ts` `slugOf`); "" when nothing is left. */
export function datasetSlug(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * A url source's settings from its `about.md` text: `{ok: true, url, dataset, key, date}`, or
 * `{ok: false, kind, said}` where `kind` is `"not_url"` (another kind of source: never run) or `"bad"`.
 */
export function urlSourceOf(text) {
  const fields = frontMatterFields(text);
  const kind = (fields.source ?? "").trim().toLowerCase();
  if (!URL_KINDS.has(kind)) return { ok: false, kind: "not_url", said: "its about.md no longer says source: url" };
  const url = (fields.url ?? "").trim();
  if (url === "") return { ok: false, kind: "bad", said: "its about.md names no url" };
  const dataset = datasetSlug(fields.dataset ?? "");
  if (dataset === "") return { ok: false, kind: "bad", said: "its about.md names no dataset" };
  const column = (name) => {
    const value = (fields[name] ?? "").trim();
    return value === "" ? null : value;
  };
  return { ok: true, url, dataset, key: column("key"), date: column("date") };
}

/** The dataset sheet a source keeps: `<source folder>/<dataset>.csv`, always inside the source's own folder. */
export function datasetPathOf(sourceFolder, dataset) {
  return `${sourceFolder}/${dataset}.csv`;
}

/** The hour a run counts as, `2026-11-25T12:00Z`: a second run in one hour replaces its rows, never adds them. */
export function runHour(now) {
  return `${new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString().slice(0, 13)}:00Z`;
}

const named = (columns, name) => columns.find((column) => column.name.toLowerCase() === String(name).toLowerCase()) ?? null;

/**
 * One fetched answer (`{columns, rows}`) shaped for `mergeSynced` against the sheet as it is now:
 * `{ok: true, columns, incoming, key, dateColumn, sheet}` or `{ok: false, refused}`.
 *
 * - **Date**: `date:` names one of the answer's columns, else a column called `date`, else the run adds
 *   `fetched`, the hour it ran, so a value with no date of its own still makes one row an hour.
 * - **Key**: `key:` names one of the answer's columns. With none named, an answer of one row is keyed by its
 *   date (one row per hour, or per day for a daily date); an answer of several rows is refused, because the sync
 *   never guesses which old row a new one replaces.
 * - **New columns** the answer brings are added to the sheet, empty in its older rows, never dropped.
 */
export function shapeFetched({ fetched, settings, sheet, now }) {
  const columns = fetched.columns.map((column) => ({ name: column.name, type: column.type }));
  const rows = fetched.rows;
  let dateColumn;
  if (settings.date !== null) {
    const found = named(columns, settings.date);
    if (found === null) return { ok: false, refused: `the answer has no ${settings.date} column, which its about.md names as the date` };
    dateColumn = found.name;
  } else {
    dateColumn = named(columns, "date")?.name ?? null;
  }
  let incoming = rows;
  if (dateColumn === null) {
    if (named(columns, FETCHED_COLUMN) !== null) return { ok: false, refused: `the answer has its own ${FETCHED_COLUMN} column; name a date column as date: in its about.md` };
    const hour = runHour(now);
    columns.push({ name: FETCHED_COLUMN, type: "date" });
    incoming = rows.map((row) => {
      const copy = Object.create(null);
      for (const name of Object.keys(row)) copy[name] = row[name];
      copy[FETCHED_COLUMN] = hour;
      return copy;
    });
    dateColumn = FETCHED_COLUMN;
  }
  let key;
  if (settings.key !== null) {
    const found = named(columns, settings.key);
    if (found === null) return { ok: false, refused: `the answer has no ${settings.key} column, which its about.md names as the key` };
    key = found.name;
  } else if (incoming.length <= 1) {
    key = dateColumn;
  } else {
    return { ok: false, refused: `the answer has ${incoming.length} rows and its about.md names no key; add key: with the column that tells them apart` };
  }
  // The sheet as the merge sees it: its own columns, then any the answer brings that it lacks.
  let current = sheet;
  if (sheet && Array.isArray(sheet.columns) && sheet.columns.length > 0) {
    const added = columns.filter((column) => named(sheet.columns, column.name) === null);
    // A column whose case differs is the same column: the answer's rows are read under the sheet's spelling.
    const spelled = new Map(sheet.columns.map((column) => [column.name.toLowerCase(), column.name]));
    incoming = incoming.map((row) => {
      const copy = Object.create(null);
      for (const name of Object.keys(row)) copy[spelled.get(name.toLowerCase()) ?? name] = row[name];
      return copy;
    });
    key = spelled.get(key.toLowerCase()) ?? key;
    dateColumn = spelled.get(dateColumn.toLowerCase()) ?? dateColumn;
    current = { columns: [...sheet.columns, ...added], rows: sheet.rows };
    return { ok: true, columns: current.columns, incoming, key, dateColumn, sheet: current };
  }
  return { ok: true, columns, incoming, key, dateColumn, sheet: null };
}
