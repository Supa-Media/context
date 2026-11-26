/**
 * Sheets: the `.csv` format every surface reads (`src/sheets/csv.js`).
 *
 * The file is the whole truth: types live in the header after a colon, and
 * nothing a reader does drops a cell. Writes are all or nothing.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `parseHeaderCell` splitting on the first colon: "a header colon that is
 *    not a type stays in the name" fails (on "ends 10:30:date").
 * 2. `changeRows` allowing an empty `match`: "an update with no match is
 *    refused" and "a delete with no match is refused" fail.
 * 3. `setColumnType` coercing values: "changing a type keeps every value" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addColumn, cellProblem, changeRows, dateMs, deleteColumn, isSheetPath, latestByGroup, MAX_SHEET_ROWS,
  moveColumn, newSheetText, parseCsvRecords, parseHeaderCell, parseSheet, querySheet, queryProblems,
  joinOptions, renameColumn, selectOptions, setColumnLayout, serializeSheet, setColumnType, splitOptions, typedValue,
} from "../src/sheets/csv.js";

const METRICS = [
  "date:date,metric:select,value:number,source,by:person",
  "2026-11-09,Monthly cost,501,routine,Tex",
  "2026-11-09,Subscriptions,14,routine,Tex",
  "2026-11-16,Monthly cost,507,routine,Tex",
  "2026-11-23,Monthly cost,512,routine,Tex",
  "",
].join("\n");

test("a .csv path is a sheet, any case; a note is not", () => {
  assert.equal(isSheetPath("areas/finance/metrics.csv"), true);
  assert.equal(isSheetPath("A.CSV"), true);
  assert.equal(isSheetPath("notes/a.md"), false);
  assert.equal(isSheetPath("a.csv.md"), false);
});

test("the header carries each column's type after a colon", () => {
  const sheet = parseSheet(METRICS);
  assert.deepEqual(sheet.columns, [
    { name: "date", type: "date" }, { name: "metric", type: "select" }, { name: "value", type: "number" },
    { name: "source", type: "text" }, { name: "by", type: "person" },
  ]);
  assert.equal(sheet.rows.length, 4);
  assert.equal(sheet.rows[2].value, "507");
  assert.deepEqual(sheet.errors, []);
});

test("a header colon that is not a type stays in the name", () => {
  assert.deepEqual(parseHeaderCell("starts: 10:30"), { name: "starts: 10:30", type: "text" });
  assert.deepEqual(parseHeaderCell("ratio:Number"), { name: "ratio", type: "number" });
  assert.deepEqual(parseHeaderCell(":date"), { name: ":date", type: "text" });
  assert.deepEqual(parseHeaderCell("ends 10:30:date"), { name: "ends 10:30", type: "date" });
});

test("a column's wrap and width ride after its type, and round-trip", () => {
  assert.deepEqual(parseHeaderCell("Try saying:text:wrap:w320"), { name: "Try saying", type: "text", wrap: true, width: 320 });
  assert.deepEqual(parseHeaderCell("tags:multiselect:w5000"), { name: "tags", type: "multiselect", width: 2000 });
  assert.deepEqual(parseHeaderCell("ends 10:30:date:wrap"), { name: "ends 10:30", type: "date", wrap: true });
  // Layout with no known type before it is part of the name.
  assert.deepEqual(parseHeaderCell("notes:wrap"), { name: "notes:wrap", type: "text" });
  assert.deepEqual(parseHeaderCell("plan:w2"), { name: "plan:w2", type: "text" });
  const sheet = parseSheet("Area,Try saying\nNotes,hi\n");
  const wide = setColumnLayout(sheet, "try saying", { wrap: true, width: 319.6 });
  assert.equal(serializeSheet(wide), "Area,Try saying:text:wrap:w320\nNotes,hi\n");
  assert.deepEqual(parseSheet(serializeSheet(wide)).columns, wide.columns);
  const plain = setColumnLayout(wide, "Try saying", { wrap: false, width: null });
  assert.equal(serializeSheet(plain).split("\n")[0], "Area,Try saying");
  // Renaming and retyping keep the layout.
  const renamed = setColumnType(renameColumn(wide, "Try saying", "Say"), "Say", "multiselect").sheet;
  assert.equal(serializeSheet(renamed).split("\n")[0], "Area,Say:multiselect:wrap:w320");
});

test("quoted cells keep commas, quotes and newlines, and round-trip", () => {
  const text = 'name,notes\n"Smith, Ada","said ""hi""\nthen left"\n';
  const sheet = parseSheet(text);
  assert.equal(sheet.rows[0].name, "Smith, Ada");
  assert.equal(sheet.rows[0].notes, 'said "hi"\nthen left');
  assert.equal(serializeSheet(sheet), text);
  assert.equal(serializeSheet(parseSheet(METRICS)), METRICS);
});

test("CRLF files and a byte-order mark read the same as LF", () => {
  const sheet = parseSheet("\uFEFFa,b:number\r\nx,1\r\n");
  assert.deepEqual(sheet.columns.map((c) => c.name), ["a", "b"]);
  assert.equal(sheet.rows[0].b, "1");
});

test("a ragged row is kept and reported, never dropped", () => {
  const sheet = parseSheet("a,b\n1\n2,3,4\n");
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[0].b, "");
  assert.equal(sheet.errors.length, 2);
  assert.equal(sheet.errors[0].line, 2);
  // Padding a short row loses nothing; a long row's extra cell would be dropped by any rewrite.
  assert.equal(sheet.errors[0].lossy, undefined);
  assert.equal(sheet.errors[1].lossy, true);
});

test("duplicate column names and an unclosed quote are errors", () => {
  assert.match(parseSheet("a,A\n1,2\n").errors[0].message, /two columns/);
  assert.equal(parseSheet("a,A\n1,2\n").errors[0].lossy, true);
  assert.ok(parseCsvRecords('a\n"open').unterminated);
  assert.match(parseSheet('a\n"open').errors[0].message, /never closed/);
});

test("a sheet over the row limit is held back, not cut", () => {
  const text = `a\n${"x\n".repeat(MAX_SHEET_ROWS + 1)}`;
  const sheet = parseSheet(text);
  assert.equal(sheet.tooLarge, true);
  assert.equal(sheet.rows.length, 0);
});

test("each type says when a value does not fit", () => {
  assert.equal(cellProblem("number", "12.5"), "");
  assert.equal(cellProblem("usd", "$1,200"), "");
  assert.match(cellProblem("number", "twelve"), /number/);
  assert.equal(cellProblem("date", "2026-11-23"), "");
  assert.match(cellProblem("date", "Nov 23"), /date/);
  assert.match(cellProblem("checkbox", "yes"), /true or false/);
  assert.match(cellProblem("link", "example.com"), /link/);
  assert.equal(cellProblem("date", ""), "");
  assert.equal(typedValue("usd", "$1,200"), 1200);
  assert.equal(typedValue("checkbox", "true"), true);
});

test("select options are the values already in the column", () => {
  assert.deepEqual(selectOptions(parseSheet(METRICS), "metric"), ["Monthly cost", "Subscriptions"]);
});

const TASKS = [
  "task,tags:multiselect,stage:select",
  'Rent,"home, money",Doing',
  "Gym,health,Done",
  'Taxes,"money,urgent ,money",Doing',
  "Nap,,Done",
  "",
].join("\n");

test("a multiselect column keeps its options comma-joined in one cell, and its header names the type", () => {
  const sheet = parseSheet(TASKS);
  assert.deepEqual(sheet.columns[1], { name: "tags", type: "multiselect" });
  assert.deepEqual(splitOptions(sheet.rows[2].tags), ["money", "urgent"]);
  assert.equal(joinOptions(["a", " b ", "a", ""]), "a, b");
  assert.deepEqual(selectOptions(sheet, "tags"), ["home", "money", "health", "urgent"]);
  // A single select's option is the whole cell, commas and all.
  assert.deepEqual(selectOptions(parseSheet('x:select\n"a, b"\n'), "x"), ["a, b"]);
  assert.equal(serializeSheet(sheet).split("\n")[1], 'Rent,"home, money",Doing');
});

test("has and has no match one option of a multiselect cell, never part of one", () => {
  const sheet = parseSheet(TASKS);
  const has = (value) => querySheet(sheet, { where: [{ column: "tags", op: "has", value }] }).rows.map((r) => r.task);
  assert.deepEqual(has("money"), ["Rent", "Taxes"]);
  assert.deepEqual(has("Urgent"), ["Taxes"]);
  assert.deepEqual(has("mon"), []);
  assert.deepEqual(querySheet(sheet, { where: [{ column: "tags", op: "has no", value: "money" }] }).rows.map((r) => r.task), ["Gym", "Nap"]);
  // On any other column, has is the whole value.
  assert.deepEqual(querySheet(sheet, { where: [{ column: "stage", op: "has", value: "done" }] }).rows.map((r) => r.task), ["Gym", "Nap"]);
  assert.equal(queryProblems(sheet, { where: [{ column: "tags", op: "has no", value: "x" }] }).length, 0);
});

test("a multiselect value written by an agent is stored tidy", () => {
  const sheet = parseSheet(TASKS);
  const added = changeRows(sheet, { append: [{ task: "Call", tags: " phone ,urgent,phone" }] });
  assert.equal(added.sheet.rows.at(-1).tags, "phone, urgent");
  const set = changeRows(sheet, { update: { match: { task: "Gym" }, set: { tags: "health,,morning" } } });
  assert.equal(set.sheet.rows[1].tags, "health, morning");
});

test("querying filters, sorts and keeps the last rows, with line numbers", () => {
  const sheet = parseSheet(METRICS);
  const out = querySheet(sheet, { where: [{ column: "metric", op: "is", value: "monthly cost" }], last: 1 });
  assert.equal(out.total, 3);
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].value, "512");
  assert.equal(out.rows[0].line, 5);
  const big = querySheet(sheet, { where: [{ column: "value", op: ">", value: "100" }], sort: { column: "value", direction: "desc" }, limit: 2 });
  assert.deepEqual(big.rows.map((r) => r.value), ["512", "507"]);
  const narrow = querySheet(sheet, { columns: ["value"], limit: 1 });
  assert.deepEqual(Object.keys(narrow.rows[0]), ["line", "value"]);
});

test("a query naming a missing column or operator is refused", () => {
  const sheet = parseSheet(METRICS);
  assert.equal(queryProblems(sheet, { where: [{ column: "nope", op: "is", value: 1 }] }).length, 1);
  assert.equal(queryProblems(sheet, { where: [{ column: "value", op: "~", value: 1 }] }).length, 1);
  assert.equal(queryProblems(sheet, { sort: { column: "nope" } }).length, 1);
  assert.equal(queryProblems(sheet, { where: [{ column: "Value", op: ">=", value: 1 }] }).length, 0);
});

test("a date is a day or a UTC instant, and a day that does not exist is refused", () => {
  for (const ok of ["2026-11-23", "2026-11-23T09:30Z", "2026-11-23T09:30:05Z", "2026-11-23T09:30:05.1Z", "2026-11-23T09:30:05.123Z", "2028-02-29"]) {
    assert.equal(cellProblem("date", ok), "", ok);
  }
  for (const no of ["2026-02-30", "2026-13-01", "2026-11-23T24:00Z", "2026-11-23T09:60Z", "2026-11-23T09:30", "2026-11-23T09:30+01:00", "2026-11-23 09:30Z", "2026-11-23T9:30Z", "2026-11-23T09:30:05.1234Z"]) {
    assert.match(cellProblem("date", no), /not a date/, no);
  }
  assert.equal(dateMs("2026-11-23"), Date.UTC(2026, 10, 23));
  assert.equal(dateMs("2026-11-23T09:30:05.5Z"), Date.UTC(2026, 10, 23, 9, 30, 5, 500));
  assert.ok(Number.isNaN(dateMs("soon")));
  assert.equal(typedValue("date", "2026-11-23T09:30Z"), "2026-11-23T09:30Z");
});

test("dates of mixed precision sort, filter and pick the latest by their moment, not their text", () => {
  const sheet = parseSheet([
    "at:date,n:number",
    "2026-11-23T09:00Z,1",
    "2026-11-23T09:00:30Z,2",
    "2026-11-23T09:00:00.500Z,3",
    "2026-11-23,4",
    "2026-11-22T23:59Z,5",
    "",
  ].join("\n"));
  assert.deepEqual(querySheet(sheet, { sort: { column: "at" } }).rows.map((r) => r.n), ["5", "4", "1", "3", "2"]);
  assert.deepEqual(querySheet(sheet, { where: [{ column: "at", op: "after", value: "2026-11-23T09:00Z" }] }).rows.map((r) => r.n), ["2", "3"]);
  assert.deepEqual(querySheet(sheet, { where: [{ column: "at", op: "before", value: "2026-11-23" }] }).rows.map((r) => r.n), ["5"]);
  const latest = latestByGroup(parseSheet("k,at:date\na,2026-11-23T09:00:30Z\na,2026-11-23T09:00Z\n"), { groupBy: "k", dateColumn: "at" });
  assert.equal(latest.get("a").at, "2026-11-23T09:00:30Z");
  // An instant written back keeps its text.
  assert.match(serializeSheet(sheet), /2026-11-23T09:00:00\.500Z,3/);
  assert.equal(changeRows(sheet, { append: [{ at: "2026-11-24T10:00Z", n: 6 }] }).ok, true);
});

test("latest row per metric goes by date", () => {
  const latest = latestByGroup(parseSheet(METRICS), { groupBy: "metric", dateColumn: "date" });
  assert.equal(latest.get("Monthly cost").value, "512");
  assert.equal(latest.get("Subscriptions").value, "14");
});

test("appending checks every value's type, all or nothing", () => {
  const sheet = parseSheet(METRICS);
  const ok = changeRows(sheet, { append: [{ date: "2026-11-30", metric: "Monthly cost", value: "$530", by: "Tex" }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.sheet.rows.at(-1).value, "530");
  assert.equal(ok.sheet.rows.at(-1).source, "");
  const bad = changeRows(sheet, { append: [{ date: "2026-11-30", value: "1" }, { date: "soon", value: "x" }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 2);
  assert.equal(bad.sheet, sheet);
  assert.equal(changeRows(sheet, { append: [{ colour: "red" }] }).ok, false);
});

test("an update or delete changes only matching rows", () => {
  const sheet = parseSheet(METRICS);
  const up = changeRows(sheet, { update: { match: { date: "2026-11-23", metric: "Monthly cost" }, set: { value: 515 } } });
  assert.equal(up.updated, 1);
  assert.equal(up.sheet.rows[3].value, "515");
  assert.equal(sheet.rows[3].value, "512");
  const del = changeRows(sheet, { delete: { match: { metric: "Subscriptions" } } });
  assert.equal(del.deleted, 1);
  assert.equal(del.sheet.rows.length, 3);
});

test("an update with no match is refused", () => {
  assert.equal(changeRows(parseSheet(METRICS), { update: { set: { value: 1 } } }).ok, false);
  assert.equal(changeRows(parseSheet(METRICS), { update: { match: {}, set: { value: 1 } } }).ok, false);
});

test("a delete with no match is refused", () => {
  assert.equal(changeRows(parseSheet(METRICS), { delete: {} }).ok, false);
  assert.equal(changeRows(parseSheet(METRICS), { delete: { match: {} } }).ok, false);
});

test("columns can be added, renamed, moved and deleted, and the header follows", () => {
  let sheet = parseSheet(METRICS);
  const added = addColumn(sheet, { name: "note", type: "text", at: 1 });
  assert.equal(added.column.name, "note");
  sheet = renameColumn(added, "note", "comment");
  sheet = moveColumn(sheet, "comment", 0);
  sheet = deleteColumn(sheet, "source");
  assert.equal(serializeSheet(sheet).split("\n")[0], "comment,date:date,metric:select,value:number,by:person");
  assert.equal(addColumn(sheet, { name: "date" }).column.name, "date 2");
  assert.equal(renameColumn(sheet, "comment", "date"), sheet);
  assert.equal(addColumn(sheet, { name: "a:b,c" }).column.name, "a b c");
});

test("changing a type keeps every value and counts the misfits", () => {
  const sheet = parseSheet(METRICS);
  const { sheet: next, misfits } = setColumnType(sheet, "source", "number");
  assert.equal(misfits, 4);
  assert.equal(next.rows[0].source, "routine");
  assert.equal(serializeSheet(next).split("\n")[0], "date:date,metric:select,value:number,source:number,by:person");
});

test("a new sheet is a header and nothing else", () => {
  assert.equal(newSheetText(), "name,notes\n");
  assert.deepEqual(parseSheet(newSheetText()).rows, []);
});
