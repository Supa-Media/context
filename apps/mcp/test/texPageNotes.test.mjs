/**
 * The Tex page's notes (`src/http/texPage/notes.js`): what the page reads and
 * changes for a person's routines, check-ins and about lines, through the one
 * `call(name, args)` door the page's route binds to `callToolForSession`.
 *
 * The unit checks use a fake `call` over a Map that answers `read_note`,
 * `write_note` and `archive_note` the way the gateway does (an etag per
 * write, a conflict for a stale one, "not found" for a missing note). The last
 * check goes through the worker's own `/mcp` route with a real workspace.
 *
 * ## Sabotage record
 *
 * Applied, run, the named check seen failing, reverted:
 *  1. `parseId` accepting any path (the routine-root check removed) → "an id
 *     outside the routine folders is refused before anything is read" fails.
 *  2. `writeNote` sending no `expected_etag` → "toggle passes the etag it read"
 *     fails.
 *  3. `editAboutLine` keeping the stale check removed → "a stale about line id
 *     is refused and nothing is written" fails.
 *
 * Fake names, ids and text only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aboutFix,
  aboutRemove,
  checkinAdd,
  checkinCancel,
  checkinEdit,
  parseId,
  readAbout,
  readCheckinSettings,
  readRoutines,
  routineRemove,
  routineToggle,
  readSwitches,
  switchSet,
  slugOf,
} from "../src/http/texPage/notes.js";
import { call as mcpCall, createEgressWorld, TOKEN_MCP, textOf } from "./agentEgressFixtures.mjs";

const NOW = Date.UTC(2026, 10, 2, 12, 0); // 2026-11-02 12:00 UTC
const ZONE = "UTC";

/**
 * A fake workspace: notes keyed by `context|path` (context "" for the caller's
 * own). Every call is recorded, with its arguments, so a test can say what the
 * page sent and in what order.
 */
function fakeWorkspace(seed = {}) {
  const notes = new Map();
  const calls = [];
  let seq = 0;
  const fresh = () => `etag-${++seq}`;
  for (const [key, text] of Object.entries(seed)) notes.set(key, { text, etag: fresh() });
  const keyOf = (args) => `${args.context ?? ""}|${args.path}`;
  const ok = (text) => ({ content: [{ type: "text", text }] });
  const refused = (text) => ({ isError: true, content: [{ type: "text", text }] });

  const call = async (name, args = {}) => {
    calls.push({ name, args: structuredClone(args) });
    const key = keyOf(args);
    if (name === "read_note") {
      const note = notes.get(key);
      if (!note) return refused(`not found: ${args.path}`);
      return ok(`etag: ${note.etag}\npath: ${args.path}\nvisibility: private\n\n${note.text}`);
    }
    if (name === "write_note") {
      const note = notes.get(key);
      if (note && args.expected_etag !== note.etag) return refused("conflict: the note changed since you read it");
      if (!note && args.expected_etag !== undefined) return refused("not found");
      notes.set(key, { text: args.content, etag: fresh() });
      return ok(`written: ${args.path}`);
    }
    if (name === "archive_note") {
      const note = notes.get(key);
      if (!note) return refused("not found");
      if (args.expected_etag !== note.etag) return refused("conflict: the note changed since you read it");
      notes.delete(key);
      return ok(`archived: ${args.path}`);
    }
    return refused(`unknown tool: ${name}`);
  };
  return {
    call,
    calls,
    has: (key) => notes.has(key),
    text: (key) => notes.get(key)?.text,
    etag: (key) => notes.get(key)?.etag,
    toolNames: () => calls.map((entry) => entry.name),
  };
}

const DAILY = "tex/routines/daily/morning-brief.md";
const ONCE = "tex/routines/once/call-sam.md";
const ABOUT = "tex/about.md";

const DAILY_NOTE = "---\nat: 7:30 am\n---\n# Morning brief\n\nSend the weather and the first calendar event.\n";
const ONCE_NOTE = "---\nat: 2026-11-07 21:30\n---\nCall Sam about the bank.\n";
const ABOUT_NOTE = [
  "# About you",
  "",
  "- Prefers short texts (You said so, 2026-11-02)",
  "- Works Tuesdays and Thursdays (Tex noticed)",
  "- Owns the household budget (Sam said so, 2026-11-01)",
  "- Likes the blue mug.",
  "",
].join("\n");

const ROWS = [
  { slug: null, path: DAILY, paused: false, unit: "day", every: 1, nextRunAt: Date.UTC(2026, 10, 3, 7, 30) },
  { slug: null, path: ONCE, paused: false, unit: "once", every: 1, nextRunAt: Date.UTC(2026, 10, 7, 21, 30) },
];

test("a daily routine and a once check-in are read into the page's items", async () => {
  const ws = fakeWorkspace({ [`|${DAILY}`]: DAILY_NOTE, [`|${ONCE}`]: ONCE_NOTE });
  const { routines, checkins } = await readRoutines(ws.call, ROWS, { now: NOW, timeZone: ZONE });

  assert.equal(routines.length, 1);
  assert.deepEqual(routines[0], {
    id: `:${DAILY}`,
    title: "Morning brief",
    when: "Every day at 7:30 am",
    on: true,
    what: "Send the weather and the first calendar event.",
  });

  assert.equal(checkins.length, 1);
  assert.equal(checkins[0].id, `:${ONCE}`);
  assert.equal(checkins[0].what, "Call Sam about the bank.");
  assert.equal(checkins[0].done, false);
  assert.equal(checkins[0].at, Date.UTC(2026, 10, 7, 21, 30));
  assert.match(checkins[0].when, /at 9:30 pm$/);
});

test("a row that is paused, or whose note cannot be read, keeps its place", async () => {
  const ws = fakeWorkspace({ [`|${DAILY}`]: DAILY_NOTE });
  const rows = [
    { ...ROWS[0], paused: true },
    { slug: null, path: "tex/routines/daily/gone.md", paused: false, unit: "day", every: 1, nextRunAt: null },
  ];
  const { routines } = await readRoutines(ws.call, rows, { now: NOW, timeZone: ZONE });
  assert.equal(routines.length, 2);
  assert.equal(routines[0].on, false);
  assert.equal(routines[1].title, "Gone");
  assert.equal(routines[1].when, "Not scheduled");
});

test("a group chat's routine is read in its workspace, with context set to the slug", async () => {
  const path = "tex/routines/weekly/groceries.md";
  const ws = fakeWorkspace({ [`@context-lc|${path}`]: "---\nat: 9:00 am\n---\n# Groceries\n\nOrder the usual.\n" });
  const rows = [{ slug: "context-lc", path, paused: false, unit: "week", every: 1, nextRunAt: null }];
  const { routines } = await readRoutines(ws.call, rows, { now: NOW, timeZone: ZONE });
  assert.equal(routines[0].id, `context-lc:${path}`);
  assert.equal(routines[0].what, "Order the usual.");
  assert.equal(ws.calls[0].args.context, "@context-lc");
});

test("toggle writes paused yes and then no, passing the etag it read", async () => {
  const ws = fakeWorkspace({ [`|${DAILY}`]: DAILY_NOTE });
  const etagRead = ws.etag(`|${DAILY}`);

  assert.deepEqual(await routineToggle(ws.call, `:${DAILY}`, false), { ok: true });
  const off = ws.calls.find((entry) => entry.name === "write_note");
  assert.equal(off.args.expected_etag, etagRead, "the write names the etag the read returned");
  assert.match(ws.text(`|${DAILY}`), /^---\nat: 7:30 am\npaused: yes\n---\n# Morning brief/);

  const pausedEtag = ws.etag(`|${DAILY}`);
  assert.deepEqual(await routineToggle(ws.call, `:${DAILY}`, true), { ok: true });
  assert.equal(ws.calls.filter((entry) => entry.name === "write_note").at(-1).args.expected_etag, pausedEtag);
  assert.match(ws.text(`|${DAILY}`), /^paused: no$/m);
  assert.doesNotMatch(ws.text(`|${DAILY}`), /paused: yes/);
});

// Dev2, 2026-11-08: an off switch for the daily tidy and the nightly rewrite, from a text and from the page.
test("Tex's own switches read as on until a note says paused, and flip by writing it, made when missing", async () => {
  const ws = fakeWorkspace({ "|tex/dreams.md": "---\npaused: yes\n---\nThey asked.\n" });
  assert.deepEqual(await readSwitches(ws.call), { housekeeping: true, dreams: false });

  assert.deepEqual(await switchSet(ws.call, "housekeeping", false), { ok: true });
  assert.equal(ws.text("|tex/housekeeping.md"), "---\npaused: yes\n---\n");
  const etag = ws.etag("|tex/dreams.md");
  assert.deepEqual(await switchSet(ws.call, "dreams", true), { ok: true });
  assert.equal(ws.calls.filter((entry) => entry.name === "write_note").at(-1).args.expected_etag, etag, "an existing note is written with the etag read");
  assert.equal(ws.text("|tex/dreams.md"), "---\npaused: no\n---\nThey asked.\n", "their words stay");
  assert.deepEqual(await readSwitches(ws.call), { housekeeping: false, dreams: true });

  const writes = ws.calls.filter((entry) => entry.name === "write_note").length;
  assert.deepEqual(await switchSet(ws.call, "heartbeat", false), { ok: false, error: "invalid" }, "only the two switches");
  assert.deepEqual(await switchSet(ws.call, "dreams", "off"), { ok: false, error: "invalid" });
  assert.equal(ws.calls.filter((entry) => entry.name === "write_note").length, writes, "and nothing else is written");
});

test("a routine note with no front matter gains paused: yes", async () => {
  const ws = fakeWorkspace({ [`|${DAILY}`]: "# Plain\n\nSay hi.\n" });
  assert.deepEqual(await routineToggle(ws.call, `:${DAILY}`, false), { ok: true });
  assert.equal(ws.text(`|${DAILY}`), "---\npaused: yes\n---\n# Plain\n\nSay hi.\n");
});

test("remove calls the archive tool, the gateway's removal, with the etag it read", async () => {
  const ws = fakeWorkspace({ [`|${DAILY}`]: DAILY_NOTE });
  const etagRead = ws.etag(`|${DAILY}`);
  assert.deepEqual(await routineRemove(ws.call, `:${DAILY}`), { ok: true });
  const archive = ws.calls.find((entry) => entry.name === "archive_note");
  assert.deepEqual(archive.args, { path: DAILY, expected_etag: etagRead });
  assert.equal(ws.has(`|${DAILY}`), false);
  assert.equal(ws.calls.some((entry) => entry.name === "write_note"), false);
});

test("an id outside the routine folders is refused before anything is read", async () => {
  const ws = fakeWorkspace({ [`|tex/about.md`]: ABOUT_NOTE, [`|notes/private.md`]: "secret\n" });
  const bad = [
    `:notes/private.md`,
    `:tex/about.md`,
    `:tex/routines/../about.md`,
    `:tex/routines/daily/../../about.md`,
    `:/tex/routines/daily/x.md`,
    `:TEX/routines/daily/x.md`,
    `:tex/routinesX/daily/x.md`,
    `bad slug!:tex/routines/daily/x.md`,
    `no-colon-here`,
  ];
  for (const id of bad) {
    assert.equal(parseId(id), null, id);
    assert.deepEqual(await routineToggle(ws.call, id, false), { ok: false, error: "not_found" }, id);
    assert.deepEqual(await routineRemove(ws.call, id), { ok: false, error: "not_found" }, id);
    assert.deepEqual(await checkinCancel(ws.call, id), { ok: false, error: "not_found" }, id);
  }
  assert.equal(ws.calls.length, 0, "no call reached the store");
  assert.deepEqual(parseId(`:${DAILY}`), { slug: null, path: DAILY });
  assert.deepEqual(parseId(`context-lc:tex/routines/daily/x.md`), { slug: "context-lc", path: "tex/routines/daily/x.md" });
});

test("a check-in edit rewrites its when and what, and an edit to a routine is refused", async () => {
  const ws = fakeWorkspace({ [`|${ONCE}`]: ONCE_NOTE, [`|${DAILY}`]: DAILY_NOTE });
  assert.deepEqual(await checkinEdit(ws.call, `:${ONCE}`, { when: "2026-11-10 18:05", what: "Call Sam back." }), { ok: true });
  assert.equal(ws.text(`|${ONCE}`), "---\nat: 2026-11-10 18:05\n---\nCall Sam back.\n");

  const refused = await checkinEdit(ws.call, `:${DAILY}`, { when: "2026-11-10 18:05" });
  assert.deepEqual(refused, { ok: false, error: "not_found" });
  assert.equal(ws.text(`|${DAILY}`), DAILY_NOTE);
  assert.deepEqual(await checkinEdit(ws.call, `:${ONCE}`, { when: "2026-13-40 18:05" }), { ok: false, error: "invalid" });
});

test("cancelling a check-in archives it", async () => {
  const ws = fakeWorkspace({ [`|${ONCE}`]: ONCE_NOTE });
  assert.deepEqual(await checkinCancel(ws.call, `:${ONCE}`), { ok: true });
  assert.equal(ws.has(`|${ONCE}`), false);
});

test("check-in add creates the note under tex/routines/once/ and never replaces one", async () => {
  const ws = fakeWorkspace({});
  const first = await checkinAdd(ws.call, { when: "2026-11-09 08:15", what: "Renew the car tax" });
  assert.equal(first.ok, true);
  assert.equal(first.id, ":tex/routines/once/renew-the-car-tax.md");
  assert.equal(ws.text("|tex/routines/once/renew-the-car-tax.md"), "---\nat: 2026-11-09 08:15\n---\nRenew the car tax\n");

  const second = await checkinAdd(ws.call, { when: "2026-11-10 09:00", what: "Renew the car tax" });
  assert.equal(second.id, ":tex/routines/once/renew-the-car-tax-2.md");
  assert.match(ws.text("|tex/routines/once/renew-the-car-tax.md"), /2026-11-09 08:15/, "the first is kept");

  assert.deepEqual(await checkinAdd(ws.call, { when: "tomorrow", what: "x" }), { ok: false, error: "invalid" });
  assert.equal(slugOf("Call Sam — about the bank!"), "call-sam-about-the-bank");
  assert.equal(slugOf("日本語"), "check-in");
});

test("about lines are read with a stable id, source and whether they are new", async () => {
  const ws = fakeWorkspace({ [`|${ABOUT}`]: ABOUT_NOTE });
  const { items, total } = await readAbout(ws.call, { path: ABOUT }, NOW);
  assert.equal(total, 4);
  assert.deepEqual(
    items.map((item) => item.source),
    ["You said so", "Tex noticed", "Sam said so", "Tex noticed"],
  );
  assert.equal(items[0].text, "Prefers short texts");
  assert.equal(items[0].isNew, true, "dated within the last 24 hours");
  assert.equal(items[2].isNew, false);
  assert.match(items[1].line, /^\d+:[0-9a-f]{8}$/);
  assert.equal(items[1].line.split(":")[0], "4", "the line's number in the note");
});

test("about fix changes only its line, and a stale line id is refused and writes nothing", async () => {
  const ws = fakeWorkspace({ [`|${ABOUT}`]: ABOUT_NOTE });
  const { items } = await readAbout(ws.call, { path: ABOUT }, NOW);
  const target = items[1].line;

  assert.deepEqual(await aboutFix(ws.call, { path: ABOUT }, target, "Works Tuesdays, Wednesdays and Thursdays"), { ok: true });
  assert.equal(
    ws.text(`|${ABOUT}`),
    ABOUT_NOTE.replace("Works Tuesdays and Thursdays (Tex noticed)", "Works Tuesdays, Wednesdays and Thursdays (Tex noticed)"),
    "only that line changed, and its marker stayed",
  );

  const written = ws.text(`|${ABOUT}`);
  assert.deepEqual(await aboutFix(ws.call, { path: ABOUT }, target, "Works Mondays"), { ok: false, error: "changed" });
  assert.equal(ws.text(`|${ABOUT}`), written, "a stale line id writes nothing");

  const after = await readAbout(ws.call, { path: ABOUT }, NOW);
  assert.equal(after.items[1].text, "Works Tuesdays, Wednesdays and Thursdays");
  assert.equal(after.items[0].line, items[0].line, "the other lines keep their ids");
});

test("a line with no source that the person fixes on their page becomes theirs; a group chat's line does not", async () => {
  const ws = fakeWorkspace({ [`|${ABOUT}`]: ABOUT_NOTE, [`|tex/groups/g_1/about.md`]: ABOUT_NOTE });
  const own = await readAbout(ws.call, { path: ABOUT }, NOW);
  assert.deepEqual(await aboutFix(ws.call, { path: ABOUT }, own.items[3].line, "Likes the green mug."), { ok: true });
  assert.match(ws.text(`|${ABOUT}`), /^- Likes the green mug\. \(you said so\)$/m, "the save then dates it (`stampAboutLines`)");

  const group = await readAbout(ws.call, { path: "tex/groups/g_1/about.md" }, NOW);
  assert.deepEqual(await aboutFix(ws.call, { path: "tex/groups/g_1/about.md" }, group.items[3].line, "Likes the green mug."), { ok: true });
  assert.match(ws.text(`|tex/groups/g_1/about.md`), /^- Likes the green mug\.$/m, "nobody in particular said a group's line");
});

test("about remove takes out one line and refuses a stale id", async () => {
  const ws = fakeWorkspace({ [`|${ABOUT}`]: ABOUT_NOTE });
  const { items } = await readAbout(ws.call, { path: ABOUT }, NOW);
  assert.deepEqual(await aboutRemove(ws.call, { path: ABOUT }, items[3].line), { ok: true });
  assert.doesNotMatch(ws.text(`|${ABOUT}`), /blue mug/);
  assert.match(ws.text(`|${ABOUT}`), /Owns the household budget/);
  assert.deepEqual(await aboutRemove(ws.call, { path: ABOUT }, items[3].line), { ok: false, error: "changed" });
});

test("about paths outside the person's and the chats' about notes are refused", async () => {
  const ws = fakeWorkspace({ [`|notes/about.md`]: ABOUT_NOTE });
  assert.deepEqual(await readAbout(ws.call, { path: "notes/about.md" }), { items: [], total: 0 });
  assert.deepEqual(await aboutFix(ws.call, { path: "tex/../notes/about.md" }, "1:00000000", "x"), { ok: false, error: "not_found" });
  assert.equal(ws.calls.length, 0);
});

test("check-in settings are read from tex/heartbeat.md, with defaults when it is missing", async () => {
  const set = fakeWorkspace({ ["|tex/heartbeat.md"]: "---\npaused: true\nlooks-at: calendar, mail\nquiet-hours: 10pm-7am\n---\nOnly deadlines.\n" });
  assert.deepEqual(await readCheckinSettings(set.call), { looksAt: ["calendar", "mail"], paused: true, quietHours: "10pm-7am" });
  assert.deepEqual(await readCheckinSettings(fakeWorkspace({}).call), { looksAt: [], paused: false });
});

test("through the worker's own /mcp route, a toggle reads back as paused", async () => {
  const world = await createEgressWorld();
  try {
    const via = (name, args) => mcpCall(world.env, TOKEN_MCP, name, args);
    const path = "tex/routines/daily/gateway-check.md";
    const saved = await via("write_note", { path, content: "---\nat: 7:30 am\n---\n# Gateway check\n\nSay good morning.\n" });
    assert.equal(saved.isError, undefined, textOf(saved));

    const rows = [{ slug: null, path, paused: false, unit: "day", every: 1, nextRunAt: null }];
    const before = await readRoutines(via, rows, { now: NOW, timeZone: ZONE });
    assert.equal(before.routines[0].on, true);
    assert.equal(before.routines[0].title, "Gateway check");

    assert.deepEqual(await routineToggle(via, `:${path}`, false), { ok: true });
    const read = await via("read_note", { path });
    assert.match(textOf(read), /^paused: yes$/m, "the gateway's own read says paused");

    const after = await readRoutines(via, rows.map((row) => ({ ...row, paused: true })), { now: NOW, timeZone: ZONE });
    assert.equal(after.routines[0].on, false);
  } finally {
    world.restore();
  }
});
