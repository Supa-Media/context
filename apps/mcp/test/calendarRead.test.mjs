/**
 * `read_calendar` (fetch id `calendar:`) reads a day of the person's calendar
 * out of the notes it is copied into, wherever they are filed, from every
 * account and workspace (owner's report, 2026-10-21: asked "do i have anything
 * planned for friday?", Tex said nothing was written and that it couldn't read
 * Google Calendar, with Friday's note filed under the account's folder).
 *
 * ## Sabotage record
 *
 *   `calendarDaysIn` asking only the flat `0-inbox/calendar/YYYY/MM/` shape
 *     → "a day filed under its account's folder is read" fails
 *   the type check dropped (any dated note in range counted)
 *     → "a dated note that is not a calendar day is left out" fails
 *   `canSee` dropped from the candidates
 *     → "a calendar the connection may not see is not read, nor hinted at" fails
 *   the other workspaces never opened
 *     → "another workspace's calendar day is read with its @name" fails
 *   "no calendar note" said the same with no calendar anywhere
 *     → "with no calendar at all, it says Google isn't connected" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolReadCalendar } from "../src/tools/calendarRead.js";
import { translateFetch } from "../src/tools/v2/searchFetch.js";
import { recordRead, newLedger } from "../src/privacy/egress.js";
import { renderCalendarDay } from "../../../packages/communications/src/calendar/render.js";

function fakeStore(notes, extra = {}) {
  const files = new Map(Object.entries(notes));
  return {
    async list({ prefix } = {}) {
      const objects = [...files.keys()]
        .filter((key) => !prefix || key.startsWith(prefix))
        .sort()
        .map((key) => ({ key, size: files.get(key).length, uploaded: new Date(0), etag: `e-${key}` }));
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
}

const day = (date, title, account = "person@example.invalid") =>
  renderCalendarDay({
    date,
    timezone: "America/New_York",
    nonce: "n0nce",
    now: "2026-10-21T12:00:00Z",
    events: [
      {
        id: `${date}-${title}`,
        account,
        calendar: "primary",
        title,
        start: `${date}T18:00:00-04:00`,
        end: `${date}T19:00:00-04:00`,
        allDay: false,
        status: "confirmed",
      },
    ],
  });

const text = (result) => result.content.map((part) => part.text).join("\n");

test("a day filed under its account's folder is read, with its events", async () => {
  const store = fakeStore({
    "0-inbox/calendar/person-at-example-invalid/2026/10/2026-10-22.md": day("2026-10-22", "Dentist"),
    "0-inbox/calendar/person-at-example-invalid/2026/10/2026-10-23.md": day("2026-10-23", "Dinner with Ada"),
  });
  const result = await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23" });
  assert.notEqual(result.isError, true);
  const out = text(result);
  assert.match(out, /## Friday 2026-10-23/);
  assert.ok(out.includes("Dinner with Ada"), "a day filed under its account's folder is read");
  assert.ok(!out.includes("Dentist"), "only the days asked for");
  assert.ok(!out.includes("trust:"), "front matter left off");
});

test("both accounts' notes for a day are read, and a run of days reads each", async () => {
  const store = fakeStore({
    "0-inbox/calendar/2026/10/2026-10-23.md": day("2026-10-23", "Old flat shape"),
    "0-inbox/calendar/work-at-example-invalid/2026/10/2026-10-23.md": day("2026-10-23", "Standup", "work@example.invalid"),
    "0-inbox/calendar/work-at-example-invalid/2026/10/2026-10-24.md": day("2026-10-24", "Brunch", "work@example.invalid"),
  });
  const out = text(await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23", days: 3 }));
  assert.ok(out.includes("Old flat shape") && out.includes("Standup") && out.includes("Brunch"));
  assert.ok(out.indexOf("Friday 2026-10-23") < out.indexOf("Saturday 2026-10-24"));
  assert.match(out, /## Sunday 2026-10-25\n\nNo calendar note for this day/, "a day not written yet is said, not skipped");
});

test("a calendar day moved out of the Inbox is still found by its front matter", async () => {
  const store = fakeStore({ "Mail and calendar/Work/2026/10/2026-10-23.md": day("2026-10-23", "Moved along") });
  const out = text(await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23" }));
  assert.ok(out.includes("Moved along"));
});

test("a dated note that is not a calendar day is left out", async () => {
  const store = fakeStore({
    "0-inbox/calendar/a/2026/10/2026-10-22.md": day("2026-10-22", "Something"),
    "3-resources/journal/2026-10-23.md": "# A day\n\nWrote a poem.\n",
  });
  const out = text(await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23" }));
  assert.ok(!out.includes("Wrote a poem"));
  assert.match(out, /No calendar note for this day/);
});

test("with no calendar at all, it says Google isn't connected, never that it can't read it", async () => {
  const store = fakeStore({ "3-resources/journal/2026-10-23.md": "# A day\n" });
  const out = text(await toolReadCalendar(store, "private", [], new Map(), { date: "2026-10-23" }));
  assert.match(out, /Google Calendar isn't connected/);
  assert.doesNotMatch(out, /can't read/i);
});

test("a calendar the connection may not see is not read, nor hinted at", async () => {
  const store = fakeStore({
    "private/calendar/2026/10/2026-10-23.md": day("2026-10-23", "Secret"),
    "team/notes.md": "# Team\n",
  });
  const rules = [{ prefix: "team", vis: "team" }];
  const out = text(await toolReadCalendar(store, "team", rules, new Map(), { date: "2026-10-23" }));
  assert.ok(!out.includes("Secret") && !out.includes("private/"));
  assert.match(out, /isn't connected/, "answered as if there were none, not 'not written yet'");
});

test("another workspace's calendar day is read with its @name", async () => {
  const band = fakeStore({ "0-inbox/calendar/band-at-example-invalid/2026/10/2026-10-23.md": day("2026-10-23", "Gig") });
  const home = fakeStore(
    {},
    {
      contexts: [{ name: "@maya", current: true }, { name: "@band" }],
      async openContext(name) {
        assert.equal(name, "@band");
        return { session: { scope: "private" }, store: band };
      },
    },
  );
  const out = text(await toolReadCalendar(home, "private", [], new Map(), { date: "2026-10-23" }));
  assert.ok(out.includes("@band/0-inbox/calendar/band-at-example-invalid/2026/10/2026-10-23.md"));
  assert.ok(out.includes("Gig"));
});

test("a bad date or day count is refused", async () => {
  const store = fakeStore({});
  for (const args of [{}, { date: "friday" }, { date: "2026-02-30" }, { date: "2026-10-23", days: 0 }, { date: "2026-10-23", days: 15 }]) {
    assert.equal((await toolReadCalendar(store, "private", [], new Map(), args)).isError, true, JSON.stringify(args));
  }
});

test('fetch "calendar:" is read_calendar with its date and days', () => {
  assert.deepEqual(translateFetch({ id: "calendar:", args: { date: "2026-10-23", days: 2 } }), {
    name: "read_calendar",
    arguments: { date: "2026-10-23", days: 2 },
    action: "calendar",
  });
  assert.ok(translateFetch({ id: "calendar:", args: { limit: 3 } }).error);
});

test("an invite's words mark the turn as having read something from outside", () => {
  const ledger = newLedger();
  recordRead(ledger, { name: "read_calendar", args: { date: "2026-10-23" }, result: { content: [{ type: "text", text: "## Friday" }] } });
  assert.equal(ledger.untrusted, true);
});
