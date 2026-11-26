/**
 * Data sources, the pure parts of syncing (`src/data/sync/`, `src/data/fetch/`):
 * what a run may write into a dataset, and the locks on fetching from a URL an editor typed.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. Dropping the row cap in `mergeSynced`:
 *    "a run past 50,000 rows writes nothing and names the sheet" fails.
 * 2. `fetchDataset` following redirects (`redirect: "follow"` and no 3xx check):
 *    "a redirect is refused" fails.
 * 3. Dropping the fc00::/7 line in `isPrivateAddress`: "private answers refuse
 *    the name" fails.
 * 4. Leaving the `__proto__` column check out of `jsonSheet`: "reserved names
 *    are refused" fails.
 * 5. Keeping an old sheet's column types as they are (`kept` = the sheet's
 *    columns): "a synced column takes its source's type" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { KEEP_DAYS, mergeSynced } from "../src/data/sync/keep.js";
import { fetchDataset, isPrivateAddress, jsonSheet, publicHttps } from "../src/data/fetch/url.js";
import { MAX_SHEET_ROWS, parseSheet } from "../src/sheets/csv.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-25T12:00:00Z");
const COLUMNS = [{ name: "number", type: "number" }, { name: "opened", type: "date" }, { name: "title", type: "text" }];
const PATH = "data/github/pull-requests.csv";

test("a run adds new rows, changes seen rows in place, and never doubles one", () => {
  const sheet = parseSheet("number:number,opened:date,title\n1,2026-11-20,first\n2,2026-11-21,second\n");
  const r = mergeSynced({ path: PATH, sheet, columns: COLUMNS, key: "number", dateColumn: "opened", now: NOW, incoming: [
    { number: "2", opened: "2026-11-21", title: "second, renamed" },
    { number: "3", opened: "2026-11-22", title: "third" },
    { number: "3", opened: "2026-11-22", title: "third" },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
  assert.equal(r.changed, 1);
  const back = parseSheet(r.text);
  assert.deepEqual(back.rows.map((x) => x.title), ["first", "second, renamed", "third"]);
});

test("a synced column takes its source's type, so a sheet made by hand with plain columns is put right", () => {
  // The usage sheets were made before their first run, every column text: with no date column, every
  // metric over them read as a right-now count of all their rows, and drew no trend (2026-11-25).
  const sheet = parseSheet("number:text,opened:text,title:text,note:number\n1,2026-11-20,first,4\n");
  const r = mergeSynced({ path: PATH, sheet, columns: COLUMNS, key: "number", dateColumn: "opened", now: NOW, incoming: [] });
  assert.equal(r.ok, true);
  const back = parseSheet(r.text);
  assert.deepEqual(back.columns.map((c) => `${c.name}:${c.type}`), ["number:number", "opened:date", "title:text", "note:number"]);
  assert.equal(back.rows[0].note, "4");
});

test(`a dataset keeps a rolling ${KEEP_DAYS} days, sorted by date, and keeps rows it can't date`, () => {
  const old = new Date(NOW - (KEEP_DAYS + 1) * DAY).toISOString().slice(0, 10);
  const r = mergeSynced({ path: PATH, sheet: null, columns: COLUMNS, key: "number", dateColumn: "opened", now: NOW, incoming: [
    { number: "9", opened: "2026-11-24", title: "new" },
    { number: "8", opened: old, title: "too old" },
    { number: "7", opened: "", title: "undated" },
    { number: "6", opened: "2026-11-01", title: "older" },
  ] });
  assert.equal(r.ok, true);
  assert.equal(r.dropped, 1);
  assert.deepEqual(parseSheet(r.text).rows.map((x) => x.title), ["older", "new", "undated"]);
});

test("a run past 50,000 rows writes nothing and names the sheet", () => {
  const incoming = Array.from({ length: MAX_SHEET_ROWS + 1 }, (_, i) => ({ number: String(i), opened: "2026-11-24", title: "x" }));
  const r = mergeSynced({ path: PATH, sheet: null, columns: COLUMNS, key: "number", dateColumn: "opened", now: NOW, incoming });
  assert.equal(r.ok, false);
  assert.match(r.refused, /data\/github\/pull-requests\.csv would pass 50,000 rows/);
  assert.equal(r.text, undefined);
});

test("a run past 5 MB writes nothing and names the sheet", () => {
  const big = "y".repeat(2000);
  const incoming = Array.from({ length: 3000 }, (_, i) => ({ number: String(i), opened: "2026-11-24", title: big }));
  const r = mergeSynced({ path: PATH, sheet: null, columns: COLUMNS, key: "number", dateColumn: "opened", now: NOW, incoming });
  assert.equal(r.ok, false);
  assert.match(r.refused, /pull-requests\.csv would pass 5 MB/);
});

test("a sheet whose columns were changed by hand is left alone", () => {
  const sheet = parseSheet("number:number,when:date\n1,2026-11-20\n");
  const r = mergeSynced({ path: PATH, sheet, columns: COLUMNS, key: "number", dateColumn: "opened", now: NOW, incoming: [] });
  assert.equal(r.ok, false);
  assert.match(r.refused, /missing the column opened, title/);
});

test("a column the source added later is appended to an old sheet, empty on its rows, and filled by the run", () => {
  // GitHub's merge_commit and sha (2026-11-26): every connected workspace's sheets were made before them.
  const sheet = parseSheet("number:number,opened:date\n1,2026-11-20\n2,2026-11-21\n");
  const r = mergeSynced({ path: PATH, sheet, columns: COLUMNS, addedColumns: ["title"], key: "number", dateColumn: "opened", now: NOW, incoming: [{ number: "2", opened: "2026-11-21", title: "second" }] });
  assert.equal(r.ok, true, r.refused);
  const back = parseSheet(r.text);
  assert.deepEqual(back.columns.map((c) => c.name), ["number", "opened", "title"]);
  assert.deepEqual(back.rows.map((row) => [row.number, row.title]), [["1", ""], ["2", "second"]]);
  assert.equal(r.changed, 1);
  // Only the named column is appended: a sheet missing another is still left alone.
  const other = mergeSynced({ path: PATH, sheet: parseSheet("number:number,title\n1,x\n"), columns: COLUMNS, addedColumns: ["title"], key: "number", dateColumn: "opened", now: NOW, incoming: [] });
  assert.equal(other.ok, false);
  assert.match(other.refused, /missing the column opened/);
});

test("reserved names are refused as a synced column", () => {
  for (const name of ["__proto__", "constructor", "prototype"]) {
    const r = mergeSynced({ path: PATH, sheet: null, columns: [...COLUMNS, { name, type: "text" }], key: "number", dateColumn: "opened", now: NOW, incoming: [] });
    assert.equal(r.ok, false, name);
  }
  assert.equal(jsonSheet(JSON.parse('[{"__proto__": 1}]')).ok, false);
  assert.equal(jsonSheet(JSON.parse('[{"constructor": 1}]')).ok, false);
});

// --- fetch from a URL -------------------------------------------------------

test("only https on a public name is fetched", () => {
  for (const bad of ["http://example.com/a.csv", "https://user:pw@example.com/", "https://example.com:8443/", "https://10.0.0.1/", "https://[::1]/",
    "https://localhost/", "https://printer.local/", "https://intranet/", "https://0x7f000001/", "https://metadata.internal/", "file:///etc/passwd", "javascript:alert(1)"]) {
    assert.equal(publicHttps(bad), null, bad);
  }
  assert.ok(publicHttps("https://api.example.com/v1/data.csv"));
});

test("private answers refuse the name", () => {
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:a00:1::", "ff02::1", "nonsense"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(ip), false, ip);
});

const answer = (body, init = {}) => async () => new Response(body, { status: 200, ...init });
const publicDns = async () => ["93.184.216.34"];

test("a name that resolves to any private address is never fetched", async () => {
  let fetched = false;
  const r = await fetchDataset("https://rebind.example.com/a.csv", { resolve: async () => ["93.184.216.34", "10.0.0.5"], fetcher: async () => { fetched = true; return new Response(""); } });
  assert.equal(r.ok, false);
  assert.match(r.refused, /private address/);
  assert.equal(fetched, false);
  const none = await fetchDataset("https://nowhere.example.com/a.csv", { resolve: async () => [], fetcher: async () => new Response("") });
  assert.match(none.refused, /could not be looked up/);
});

test("a redirect is refused, and the fetch sends no credential", async () => {
  let seen;
  const r = await fetchDataset("https://api.example.com/a.csv", { resolve: publicDns, fetcher: async (url, init) => { seen = init; return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }); } });
  assert.equal(r.ok, false);
  assert.match(r.refused, /redirects/);
  assert.equal(seen.redirect, "manual");
  assert.equal(seen.method, "GET");
  assert.deepEqual(Object.keys(seen.headers).sort(), ["accept", "user-agent"]);
});

test("an answer over the byte cap is refused whole", async () => {
  const r = await fetchDataset("https://api.example.com/a.csv", { resolve: publicDns, maxBytes: 10, fetcher: answer("a,b\n1,2\n3,4\n5,6\n") });
  assert.equal(r.ok, false);
  assert.match(r.refused, /answered over/);
});

test("a slow answer is cut off at the timeout", async () => {
  const r = await fetchDataset("https://slow.example.com/a.csv", { resolve: publicDns, timeoutMs: 20, fetcher: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) });
  assert.equal(r.ok, false);
  assert.match(r.refused, /took over/);
});

test("CSV and JSON answers become sheets; anything else is refused", async () => {
  const csv = await fetchDataset("https://api.example.com/a.csv", { resolve: publicDns, fetcher: answer("day:date,signups:number\n2026-11-24,4\n") });
  assert.equal(csv.ok, true);
  assert.deepEqual(csv.sheet.columns, [{ name: "day", type: "date" }, { name: "signups", type: "number" }]);
  const json = await fetchDataset("https://api.example.com/a", { resolve: publicDns, fetcher: answer('[{"day":"2026-11-24","n":4,"meta":{"a":1}},{"day":"2026-11-25","n":5.5}]', { headers: { "content-type": "application/json" } }) });
  assert.equal(json.ok, true);
  assert.deepEqual(json.sheet.columns, [{ name: "day", type: "date" }, { name: "n", type: "number" }, { name: "meta", type: "text" }]);
  assert.equal(json.sheet.rows[0].meta, '{"a":1}');
  assert.equal(Object.getPrototypeOf(json.sheet.rows[0]), null);
  const notRows = await fetchDataset("https://api.example.com/a", { resolve: publicDns, fetcher: answer('{"data":[]}') });
  assert.match(notRows.refused, /not a list of rows/);
  const status = await fetchDataset("https://api.example.com/a", { resolve: publicDns, fetcher: answer("nope", { status: 500 }) });
  assert.match(status.refused, /answered 500/);
});
