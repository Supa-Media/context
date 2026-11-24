/**
 * `read_sheet`: a `.csv` sheet's rows as a typed table, through `fetch`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are the checks that failed.
 *
 * 1. **`canSee` dropped from `toolReadSheet`** — 2: the hidden-sheet row (a team
 *    caller reads a private sheet's rows) and the shared "not found" row.
 * 2. **The bytes fetched before `canSee`** — the hidden-sheet row fails on the
 *    store's get log.
 * 3. **The `.csv` branch in `translateFetch` removed** — the routing row fails:
 *    a sheet path reads as words through read_file.
 * 4. **`read_sheet` removed from `UNTRUSTED_READS`** — the untrusted row fails.
 * 5. **The `|` escape in a cell removed** — the escaping row fails.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toolReadSheet } from "../src/tools/readSheet.js";
import { callTool } from "../src/tools/dispatch.js";
import { translateFetch } from "../src/tools/v2/searchFetch.js";
import { newLedger, recordRead, UNTRUSTED_READS } from "../src/privacy/egress.js";
import { READ_TOOLS } from "../src/labSandbox/policy.js";
import { isParallelRead } from "../../../packages/tex/gateway/agent/parallelReads.js";
import { loadPrivacyState } from "../src/privacy/state.js";
import { parsePrivacyManifest, PRE_PARSED_RULES, PRIVACY_KEY } from "../src/privacy/engine.js";
import { MAX_SHEET_BYTES } from "../src/sheets/csv.js";

const SHEET = "areas/finance/bills.csv";
const HIDDEN = "1-projects/vault/budget.csv";
const SHEET_TEXT = [
  "name,amount:usd,renews:date,kind",
  "Gym,40,2026-12-01,fitness",
  "Phone,25,2026-11-05,fitness",
  "Rent,3850,2026-12-01,housing",
  "Insurance,120,2027-01-03,housing",
].join("\n");

const RULES = `# Privacy

<!-- BEGIN BRAIN PRIVACY RULES -->

\`\`\`yaml
default_visibility: private

folder_defaults:
  areas/finance/: team
  1-projects/vault/: private

note_overrides:
  # none
\`\`\`

<!-- END BRAIN PRIVACY RULES -->
`;

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.gets = [];
  }
  seed(key, value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    this.objects.set(key, { bytes, etag: `e${this.objects.size + 1}` });
  }
  async get(key) {
    this.gets.push(key);
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      key,
      etag: item.etag,
      size: item.bytes.byteLength,
      // The access rules arrive parsed, as the store serves them (`store/privacyAuthority.js`).
      ...(key === PRIVACY_KEY ? { [PRE_PARSED_RULES]: parsePrivacyManifest(new TextDecoder().decode(item.bytes)) } : {}),
      text: async () => new TextDecoder().decode(item.bytes),
      arrayBuffer: async () => item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength),
    };
  }
  async head(key) {
    const item = this.objects.get(key);
    return item ? { key, etag: item.etag, size: item.bytes.byteLength } : null;
  }
  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, item]) => ({ key, etag: item.etag, size: item.bytes.byteLength }));
    return { objects, truncated: false };
  }
}

async function world(sheets = { [SHEET]: SHEET_TEXT, [HIDDEN]: "name,amount:usd\nSecret,9\n" }) {
  const store = new MemoryStore();
  store.seed(PRIVACY_KEY, RULES);
  for (const [path, text] of Object.entries(sheets)) store.seed(path, text);
  const { rules, overrides } = await loadPrivacyState(store);
  return { store, rules, overrides };
}

const text = (result) => result.content.map((part) => part.text).join("\n");

/** The line numbers of the table's data rows, in the order shown. */
const lineNumbers = (out) => [...out.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));

test("a fetch of a .csv goes to read_sheet, with its query args copied", () => {
  const args = {
    where: [{ column: "kind", op: "is", value: "housing" }],
    sort: { column: "amount", direction: "desc" },
    last: 3,
    limit: 10,
    columns: ["name"],
  };
  assert.deepEqual(translateFetch({ id: SHEET, args }, { client: "claude-code" }), {
    name: "read_sheet",
    arguments: { path: SHEET, ...args },
    action: "sheet",
  });
  assert.equal(translateFetch({ id: "1-projects/a.md" }, { client: "claude-code" }).name, "read_note");
});

test("a sheet comes back as a typed table with each row's line in the file", async () => {
  const { store, rules, overrides } = await world();
  const out = text(await toolReadSheet(store, "private", rules, overrides, { path: SHEET }));
  assert.match(out, /^path: areas\/finance\/bills\.csv$/m);
  assert.match(out, /^kind: sheet$/m);
  assert.match(out, /^etag: e\d+$/m);
  assert.match(out, /^rows: 4 of 4 matching \(4 in the sheet\)$/m);
  assert.match(out, /^columns: name:text, amount:usd, renews:date, kind:text$/m);
  assert.match(out, /^trust: untrusted$/m);
  assert.match(out, /^\| line \| name:text \| amount:usd \| renews:date \| kind:text \|$/m);
  assert.match(out, /^\| 2 \| Gym \| 40 \| 2026-12-01 \| fitness \|$/m);
  assert.match(out, /To add rows, write with action rows, args \{ path, append: \[\{\.\.\.\}\] \}\./);
  assert.deepEqual(lineNumbers(out), [2, 3, 4, 5]);
});

test("where, sort, last and limit shape the rows, and say how many matched", async () => {
  const { store, rules, overrides } = await world();
  const call = (args) => toolReadSheet(store, "private", rules, overrides, { path: SHEET, ...args });

  const housing = text(await call({ where: [{ column: "kind", value: "housing" }] }));
  assert.match(housing, /^rows: 2 of 2 matching \(4 in the sheet\)$/m);
  assert.deepEqual(lineNumbers(housing), [4, 5]);

  const after = text(await call({ where: [{ column: "renews", op: ">", value: "2026-11-30" }] }));
  assert.match(after, /^rows: 3 of 3 matching/m);
  assert.deepEqual(lineNumbers(after), [2, 4, 5]);

  const biggest = text(await call({ sort: { column: "amount", direction: "desc" } }));
  assert.deepEqual(lineNumbers(biggest), [4, 5, 2, 3], "amounts sort as numbers: 3850, 120, 40, 25");

  const newest = text(await call({ last: 2 }));
  assert.match(newest, /^rows: 2 of 4 matching \(4 in the sheet\)$/m);
  assert.deepEqual(lineNumbers(newest), [4, 5]);

  const first = text(await call({ limit: 1 }));
  assert.match(first, /^rows: 1 of 4 matching/m);
  assert.deepEqual(lineNumbers(first), [2]);

  assert.equal((await call({ limit: 1001 })).isError, true, "limit is at most 1000");
  assert.equal((await call({ last: -1 })).isError, true);
  assert.equal((await call({ where: "kind" })).isError, true);
});

test("columns narrows the table but the header still names every column", async () => {
  const { store, rules, overrides } = await world();
  const out = text(await toolReadSheet(store, "private", rules, overrides, { path: SHEET, columns: ["name"] }));
  assert.match(out, /^\| line \| name:text \|$/m);
  assert.doesNotMatch(out, /\| kind:text/, "the table has no kind column");
  assert.match(out, /^columns: name:text, amount:usd, renews:date, kind:text$/m);
});

test("a bad column or operator is refused, naming it and the columns there are", async () => {
  const { store, rules, overrides } = await world();
  const bad = await toolReadSheet(store, "private", rules, overrides, { path: SHEET, where: [{ column: "Nope", value: "x" }] });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /no column "Nope"/);
  assert.match(text(bad), /Call it again with these columns: name:text, amount:usd, renews:date, kind:text/);

  const sorted = await toolReadSheet(store, "private", rules, overrides, { path: SHEET, sort: { column: "Missing" } });
  assert.match(text(sorted), /no column "Missing" to sort by/);

  const op = await toolReadSheet(store, "private", rules, overrides, { path: SHEET, where: [{ column: "kind", op: "like", value: "x" }] });
  assert.match(text(op), /unknown operator "like"/);
});

test("a private sheet is not found for a team caller, with the same words as a missing one", async () => {
  const { store, rules, overrides } = await world();
  const hidden = await toolReadSheet(store, "team", rules, overrides, { path: HIDDEN });
  const missing = await toolReadSheet(store, "team", rules, overrides, { path: "1-projects/vault/nothing.csv" });
  assert.equal(hidden.isError, true);
  assert.equal(missing.isError, true);
  assert.equal(text(hidden), "not found: check the path with search, then try again.");
  assert.equal(text(hidden), text(missing));
  assert.equal(store.gets.includes(HIDDEN), false, "a hidden sheet's bytes are never fetched");

  const shared = await toolReadSheet(store, "team", rules, overrides, { path: SHEET });
  assert.match(text(shared), /^visibility: team$/m, "a team caller reads a sheet the team can see");

  const owner = await toolReadSheet(store, "private", rules, overrides, { path: HIDDEN });
  assert.match(text(owner), /^visibility: private$/m);
  assert.match(text(owner), /Secret/);
});

test("a ragged row is kept and reported as a problem with its line", async () => {
  const { store, rules, overrides } = await world({ [SHEET]: `${SHEET_TEXT}\nRagged,1,2026-12-01\n` });
  const out = text(await toolReadSheet(store, "private", rules, overrides, { path: SHEET }));
  assert.match(out, /^problem: line 6: has 3 cells, the header has 4$/m);
  assert.deepEqual(lineNumbers(out), [2, 3, 4, 5, 6]);
});

test("a cell's | and line breaks are escaped so the table stays a table", async () => {
  const { store, rules, overrides } = await world({ "areas/notes.csv": 'name,notes\n"Gym","a|b\nc"\n' });
  const out = text(await toolReadSheet(store, "private", rules, overrides, { path: "areas/notes.csv" }));
  assert.match(out, /^\| 2 \| Gym \| a\\\|b<br>c \|$/m);
});

test("a CSV over the sheet ceiling is read as a file instead, in parts, never cut into a table", async () => {
  const big = `a,b\n${"x,1\n".repeat(Math.ceil(MAX_SHEET_BYTES / 4) + 10)}`;
  const { store, rules, overrides } = await world({ [SHEET]: big });
  const result = await toolReadSheet(store, "private", rules, overrides, { path: SHEET });
  assert.doesNotMatch(text(result), /^kind: sheet$/m);
  assert.doesNotMatch(text(result), /^\| line \|/m);
});

test("fetch with from or summary keeps read_file's paging and totals for a long CSV", () => {
  const app = { client: "claude-code" };
  assert.equal(translateFetch({ id: "inbox/a.csv", args: { summary: { by: ["month"] } } }, app).name, "read_file");
  assert.equal(translateFetch({ id: "inbox/a.csv", args: { from: 3 } }, app).name, "read_file");
  assert.equal(translateFetch({ id: "inbox/a.csv" }, app).name, "read_sheet");
});

test("a CSV with a column named line is read as a file, never shown with the wrong numbers", async () => {
  const { store, rules, overrides } = await world({ "areas/lines.csv": "line,amount\n7,40\n" });
  const result = await toolReadSheet(store, "private", rules, overrides, { path: "areas/lines.csv" });
  assert.doesNotMatch(text(result), /^kind: sheet$/m);
});

test("only a .csv is a sheet; another path is refused by name", async () => {
  const { store, rules, overrides } = await world();
  const result = await toolReadSheet(store, "private", rules, overrides, { path: "1-projects/a.md" });
  assert.equal(result.isError, true);
  assert.match(text(result), /opens a .csv sheet/);
});

test("the gateway's dispatch runs read_sheet, and a fetch of a sheet reaches its rows", async () => {
  const { store } = await world();
  const routed = translateFetch({ id: SHEET, args: { where: [{ column: "kind", value: "housing" }] } }, { client: "claude-code" });
  const out = text(await callTool(routed.name, routed.arguments, store, "private"));
  assert.match(out, /^kind: sheet$/m);
  assert.deepEqual(lineNumbers(out), [4, 5]);
});

test("reading a sheet marks the turn as having taken in outside words, and it is a read everywhere", () => {
  assert.equal(UNTRUSTED_READS.has("read_sheet"), true);
  assert.equal(READ_TOOLS.has("read_sheet"), true);
  assert.equal(isParallelRead("read_sheet"), true);
  const ledger = newLedger();
  recordRead(ledger, { name: "read_sheet", args: { path: SHEET }, result: { content: [{ type: "text", text: "kind: sheet" }] } });
  assert.equal(ledger.untrusted, true);
});
