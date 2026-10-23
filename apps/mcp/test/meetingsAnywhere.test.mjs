/**
 * `list_meetings` finds a meeting wherever it was filed, in every workspace
 * the person reaches, newest first (owner's report, 2026-10-21: Tex answered
 * "my last meeting with <a colleague>" from an August note while yesterday's call sat
 * in a one-to-one folder of its own).
 *
 * ## Sabotage record
 *
 *   `meetingsIn` asking only `isMeetingNotePath` (the old default folder)
 *     → "a meeting filed in its own folder is listed" and "a dated note in a
 *       meetings folder is a meeting" fail
 *   the sort dropped
 *     → "newest first, by when it started" fails
 *   `canSee` dropped from the candidates
 *     → "a meeting the connection may not see is not listed" fails
 *   the other workspaces never opened
 *     → "a meeting in another workspace is listed with its @name" fails
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { toolListMeetings } from "../src/tools/meetings.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";

/**
 * Another workspace's access rows, as `openContext` serves them: 2-areas is team, everything else private. A
 * store `openContext` builds has rules like this, or it is left out as one whose privacy cannot be read.
 */
const rowsOf = (store) => withPrivacyAuthority(store, { rules: { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "2-areas", visibility: "team" }], notes: [] } });

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

const meeting = (started, title, attendees = "[]") =>
  `---\ntype: meeting\nstarted: ${started}\nduration: 30m\nattendees: ${attendees}\n---\n\n# ${title}\n\n## Summary\n\nTalked.\n`;

const text = (result) => result.content.map((part) => part.text).join("\n");

test("a meeting filed in its own folder is listed, newest first, by when it started", async () => {
  const store = fakeStore({
    "0-inbox/meetings/2026-08-21-finance-walkthrough-ab12cd34.md": meeting("2026-08-21T16:00:00Z", "Finance walkthrough", "[Ada]"),
    "2-areas/people/ada.md": "# Ada\n\nOct 14 call: talked receipts.\n",
    "2-areas/meetings/1:1s/ada:kofi/ada-kofi.md": meeting("2026-10-20T22:15:00Z", "Ada / Kofi"),
  });
  const out = text(await toolListMeetings(store, "private", [], new Map(), 10));
  const newer = out.indexOf("2-areas/meetings/1:1s/ada:kofi/ada-kofi.md");
  const older = out.indexOf("0-inbox/meetings/2026-08-21-finance-walkthrough-ab12cd34.md");
  assert.ok(newer !== -1, "a meeting filed in its own folder is listed");
  assert.ok(older !== -1, "the default folder's meeting is still listed");
  assert.ok(newer < older, "newest first, by when it started");
  assert.ok(out.includes("2026-10-20T22:15:00Z · Ada / Kofi"), "the row says when it started and what it was");
  assert.ok(!out.includes("2-areas/people/ada.md"), "an ordinary note is not a meeting");
});

test("a dated note in a meetings folder is a meeting even with its front matter gone; a dated note elsewhere is not", async () => {
  const store = fakeStore({
    "2-areas/meetings/1:1s/ada:kofi/untitled-2026-10-20.md": "# Ada / Kofi 10-20\n\n## Summary\n\nReceipts.\n\n## Transcript\n\nhello\n",
    "2-areas/meetings/director/untitled-2026-10-19.md": "# Directors Meeting 10-19\n\n## Summary\n\nPlans.\n",
    "3-resources/journal/2026-10-18.md": "# A day\n\nNothing to do with meetings.\n",
  });
  const out = text(await toolListMeetings(store, "private", [], new Map(), 10));
  assert.ok(out.includes("untitled-2026-10-20.md"), "a dated note in a meetings folder is a meeting");
  assert.ok(out.indexOf("untitled-2026-10-20.md") < out.indexOf("untitled-2026-10-19.md"), "newest first by the date in its name");
  assert.ok(!out.includes("3-resources/journal/2026-10-18.md"), "a dated note outside a meetings folder is not called a meeting");
});

test("a meeting the connection may not see is not listed", async () => {
  const store = fakeStore({
    "team/meetings/2026-10-01-standup-aaaa1111.md": meeting("2026-10-01T14:00:00Z", "Standup"),
    "private/meetings/2026-10-20-one-on-one-bbbb2222.md": meeting("2026-10-20T14:00:00Z", "One on one"),
  });
  const rules = [{ prefix: "team", vis: "team" }];
  const out = text(await toolListMeetings(store, "team", rules, new Map(), 10));
  assert.ok(out.includes("Standup"), "the team meeting is listed");
  assert.ok(!out.includes("One on one") && !out.includes("private/"), "the private one is absent, not counted or hinted");
});

test("a meeting in another workspace is listed with its @name, in date order with this one's", async () => {
  const band = fakeStore({
    "2-areas/meetings/2026-10-20-rehearsal-cccc3333.md": meeting("2026-10-20T23:00:00Z", "Rehearsal"),
  });
  const home = fakeStore(
    { "0-inbox/meetings/2026-10-02-dentist-call-dddd4444.md": meeting("2026-10-02T15:00:00Z", "Dentist call") },
    {
      contexts: [{ name: "@maya", current: true }, { name: "@band" }],
      async openContext(name) {
        assert.equal(name, "@band");
        return { session: { scope: "private" }, store: rowsOf(band) };
      },
    },
  );
  const out = text(await toolListMeetings(home, "private", [], new Map(), 10));
  assert.ok(out.includes("@band/2-areas/meetings/2026-10-20-rehearsal-cccc3333.md"), "a meeting in another workspace is listed with its @name");
  assert.ok(out.indexOf("Rehearsal") < out.indexOf("Dentist call"), "merged newest first");
  assert.ok(out.includes('context: "@name"'), "and says how to read it there");
});

/*
  `tree/served.js`, on the tools that list (`list_meetings` by name): "Privacy
  is decided twice, never once less. The control plane hands back only what
  this grant's clearance sees ... A key reaches an agent only if both agree."
  The dispatcher serves the caller's own store (`tools/dispatch.js`), but a
  store `openContext` builds is raw, so the second workspace has to be wrapped
  where it is opened — as orient's cross-workspace survey does
  (`orient/workspaces.js`). Unwrapped, this walks somebody else's bucket.
*/
test("another workspace's meetings come from its tree, and a tree that cannot answer leaves it out", async () => {
  const withheld = "2-areas/meetings/2026-10-21-board-private-eeee5555.md";
  const band = fakeStore(
    {
      "2-areas/meetings/2026-10-20-rehearsal-cccc3333.md": meeting("2026-10-20T23:00:00Z", "Rehearsal"),
      [withheld]: meeting("2026-10-21T09:00:00Z", "Board private"),
    },
    {
      // The clearance this grant has there: the bucket holds both, the tree one.
      async treeManifest() {
        return { served: true, cursor: null, entries: [{ path: "2-areas/meetings/2026-10-20-rehearsal-cccc3333.md" }] };
      },
    },
  );
  const loading = fakeStore(
    { "2-areas/meetings/2026-10-22-offsite-ffff6666.md": meeting("2026-10-22T09:00:00Z", "Offsite") },
    { async treeManifest() { return { served: false }; } },
  );
  const home = fakeStore(
    { "0-inbox/meetings/2026-10-02-dentist-call-dddd4444.md": meeting("2026-10-02T15:00:00Z", "Dentist call") },
    {
      contexts: [{ name: "@maya", current: true }, { name: "@band" }, { name: "@still-loading" }],
      async openContext(name) {
        return { session: { scope: "private" }, store: rowsOf(name === "@band" ? band : loading) };
      },
    },
  );
  const out = text(await toolListMeetings(home, "private", [], new Map(), 10));
  assert.ok(out.includes("@band/2-areas/meetings/2026-10-20-rehearsal-cccc3333.md"), "what that grant's clearance sees there is listed");
  assert.ok(!out.includes(withheld) && !out.includes("Board private"), "a key the tree withholds is not read off the bucket instead");
  assert.ok(!out.includes("Offsite"), "a workspace whose tree cannot answer is left out, never bucket-walked");
  assert.ok(out.includes("Dentist call"), "and this workspace is listed as before");
});
