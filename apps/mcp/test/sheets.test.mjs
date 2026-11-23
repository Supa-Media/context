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
  addColumn, cellProblem, changeRows, deleteColumn, isSheetPath, latestByGroup, MAX_SHEET_ROWS,
  moveColumn, newSheetText, parseCsvRecords, parseHeaderCell, parseSheet, querySheet, queryProblems,
  renameColumn, selectOptions, serializeSheet, setColumnType, typedValue,
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
});

test("duplicate column names and an unclosed quote are errors", () => {
  assert.match(parseSheet("a,A\n1,2\n").errors[0].message, /two columns/);
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
