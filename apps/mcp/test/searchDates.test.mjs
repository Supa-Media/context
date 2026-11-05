// `search_notes` with `from` and `to` (src/tools/searchDates.js): what the notes say is on each day of a range,
// across every workspace, so "the last week of October" finds "Slides due October 28" (core benchmark q17, 2026-11-05).
import test from "node:test";
import assert from "node:assert/strict";

import { daysNamed, toolSearchDated, MAX_RANGE_DAYS } from "../src/tools/searchDates.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { withServedTree } from "./servedTree.mjs";

function scannedStore(notes, extra = {}) {
  const files = new Map(Object.entries(notes));
  const store = {
    async list({ prefix } = {}) {
      const objects = [...files.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort().map((key) => ({ key, size: files.get(key).length, uploaded: new Date(0), etag: `e-${key}` }));
      return { objects, truncated: false };
    },
    async get(key) {
      if (!files.has(key)) return null;
      const body = files.get(key);
      return { etag: `e-${key}`, text: async () => body, size: body.length };
    },
    async head(key) {
      return files.has(key) ? { etag: `e-${key}`, size: files.get(key).length } : null;
    },
    ...extra,
  };
  return withServedTree(store);
}

const rowsOf = (store) => withPrivacyAuthority(store, { rules: { etag: "rows-v1", accessVersion: 1, folders: [], notes: [] } });

function world() {
  const others = {
    "@day-job": scannedStore({ "travel/conference-2026.md": "# Conference\n\n- Flights booked.\n- Slides due October 28.\n", "status/weekly.md": "# Weekly\n\nSign-off date not yet confirmed.\n" }),
    "@book-club": scannedStore({ "meetings/2026-10.md": "# October meeting\n\n- Thu Oct 29 at Mina's flat, 7 to 9 pm.\n- Finish the book by 25 October.\n" }),
    "@context-lc": scannedStore({ "ai/production/texting-assistant.md": "# Setup\n\nOctober 28 is a made-up day here.\n" }),
  };
  return scannedStore(
    { "todo.md": "# To do\n\n- [ ] Renew the lease before November 30\n- [ ] Transfer October savings\n" },
    {
      contexts: [{ name: "@day-job", role: "member" }, { name: "@book-club", role: "member" }, { name: "@context-lc", role: "member" }],
      async openContext(name) {
        return { session: { scope: "private" }, store: rowsOf(others[name]) };
      },
    },
  );
}

test("a line names a day the ways notes write one, and nothing else is read as a day", () => {
  const days = (line) => daysNamed(line, 2026).map((day) => new Date(day * 86_400_000).toISOString().slice(0, 10));
  assert.deepEqual(days("- Slides due October 28."), ["2026-10-28"]);
  assert.deepEqual(days("Thu Oct 29th: book club"), ["2026-10-29"]);
  assert.deepEqual(days("Finish by 25 October 2027"), ["2027-10-25"]);
  assert.deepEqual(days("dates: 2026-10-14 to 2026-10-18"), ["2026-10-14", "2026-10-18"]);
  assert.deepEqual(days("Page 12 of 30, then 7 to 9 pm"), []);
});

test("the last week of October, across workspaces: each dated line under its day, an undated one left out", async () => {
  const out = (await toolSearchDated(world(), "private", [], new Map(), { from: "2026-10-25", to: "2026-10-31" })).content[0].text;
  assert.match(out, /Wed, Oct 28 \(2026-10-28\)\n {2}@day-job\/travel\/conference-2026\.md\n {4}- Slides due October 28\./);
  assert.match(out, /Thu, Oct 29 \(2026-10-29\)\n {2}@book-club\/meetings\/2026-10\.md\n {4}- Thu Oct 29 at Mina's flat/);
  assert.ok(out.indexOf("Oct 28") < out.indexOf("Oct 29"), "day by day");
  assert.doesNotMatch(out, /Sign-off|Transfer October savings|November 30/, "a line naming no day in the range is left out");
  assert.doesNotMatch(out, /context-lc/, "Context.LC's own workspace is not the person's notes");
});

test("a range is days written YYYY-MM-DD, in order, and bounded", async () => {
  const refused = async (args) => (await toolSearchDated(world(), "private", [], new Map(), args)).isError === true;
  assert.equal(await refused({ from: "October 25", to: "2026-10-31" }), true);
  assert.equal(await refused({ from: "2026-10-31", to: "2026-10-25" }), true);
  assert.equal(await refused({ from: "2026-10-01", to: `2026-10-${String(MAX_RANGE_DAYS + 1).padStart(2, "0")}` }), true);
  const none = (await toolSearchDated(world(), "private", [], new Map(), { from: "2026-12-01", to: "2026-12-02" })).content[0].text;
  assert.match(none, /^No note names a day/);
});
