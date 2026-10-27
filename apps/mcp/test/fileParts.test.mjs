/**
 * A FILE'S WORDS IN PARTS, AND A TABLE'S FACTS COUNTED BY THE GATEWAY
 * (`src/tools/fileParts.js`; the owner's review of a chat, 2026-10-24).
 *
 * Tex read the first 100,000 characters of an 8,530-row bank export, reported
 * rent twice a month because the export repeated rows, and only checked when
 * asked to. Now each part ends on a row and says where the next starts, and a
 * table carries its row count, its repeated rows and its amount totals
 * (repeats left out) on every part, with `summary` for totals by month,
 * column or filter worked out over every row.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *   `tableFacts` counting a repeated row as new → "repeated rows are counted
 *     and left out of the totals" fails.
 *   `partOf` cutting at exactly `PART_CHARS` → "a part ends on a row" fails.
 *   `fileWords` sending a CSV to `toMarkdown` → "a stored CSV is read as its
 *     rows, never converted" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { PART_CHARS, factLines, isoDate, partOf, tableFacts, tableSummary } from "../src/tools/fileParts.js";

const EXPORT = [
  "Date,Account Name,Name,Amount,Category",
  "2026-08-03,BofA Checking,Rent,3850.00,Housing",
  "2026-08-03,BofA Checking,Rent,3850.00,Housing",
  "2026-08-03,BofA Joint,Rent,3850.00,Housing",
  '2026-08-05,Chase,"Blue Bottle, Inc",6.50,Dining',
  "2026-09-02,BofA Checking,Rent,3850.00,Housing",
  "09/14/2026,Chase,Groceries,82.10,Food",
].join("\n");

test("repeated rows are counted and left out of the totals; near-repeats are named for a check", () => {
  const facts = tableFacts(EXPORT, "transactions.csv");
  assert.equal(facts.rows, 6);
  assert.equal(facts.duplicates, 1);
  assert.deepEqual(facts.examples, [{ line: 3, sameAs: 2 }]);
  assert.equal(facts.alike, 1, "the joint account's rent matches on date, amount and name");
  const lines = factLines(facts).join("\n");
  assert.match(lines, /duplicate rows: 1 rows repeat an earlier row in every column \(line 3 repeats line 2\)/);
  assert.match(lines, /near-duplicate rows: 1 more rows match an earlier row on Date, Amount, Name/);
  assert.match(lines, /total of Amount: 11,638\.60 with the repeated rows left out \(15,488\.60 with them\)/);
  assert.match(lines, /summary: \{ by: \["month"/);
});

test("summary totals every row by month and column, repeats left out", () => {
  const byMonth = tableSummary(EXPORT, "transactions.csv", { by: ["month", "Category"] }).lines.join("\n");
  assert.match(byMonth, /5 rows, total 11,638\.60; 1 repeated rows left out/);
  assert.match(byMonth, /2026-08 · Housing: 7,700\.00 \(2 rows\)/);
  assert.match(byMonth, /2026-09 · Food: 82\.10 \(1 rows\)/, "a US-style date is read as its month");
  const rent = tableSummary(EXPORT, "transactions.csv", { where: { name: "RENT", "account name": "checking" }, dates: { from: "2026-08-01", to: "2026-08-31" } }).lines.join("\n");
  assert.match(rent, /1 rows, total 3,850\.00; 1 repeated rows left out/);
  assert.match(tableSummary(EXPORT, "transactions.csv", { by: ["Payee"] }).error, /no such column: Payee; the columns are Date, Account Name, Name, Amount, Category/);
  assert.equal(isoDate("8/3/26"), "2026-08-03");
  assert.equal(isoDate("Rent"), null);
});

test("a part ends on a row, and the last part ends at the file's end", () => {
  const text = `${"x".repeat(37)}\n`.repeat(5_000);
  const first = partOf(text);
  assert.ok(first.to <= PART_CHARS && first.to > PART_CHARS - 40);
  assert.equal(text[first.to - 1], "\n");
  const last = partOf(text, first.to);
  assert.equal(last.to, text.length);
  assert.equal(partOf(text, text.length), null);
});
