/**
 * The Context usage source (`src/data/sync/runUsage.js`, `src/usage/`): Context-wide activity written, by person
 * ids nobody can reverse, into the one workspace this deployment names, in sheets only its owners can open.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `armUsage` skipping the slug check: "only the workspace the deployment names can turn it on" fails.
 * 2. `ownersOnly` checking the member rendering alone: "a sheet anyone but owners can open stops the source" fails
 *    on the guest-listed sheet.
 * 3. `usageRows` writing the account id instead of its MAC: "no account id reaches a sheet" fails.
 * 4. `markCaller` counting the app's own calls: "the app and Tex are not callers" fails.
 * 5. `mergeSynced` ignoring `handColumns`: "a bug's status is the team's" fails.
 * 6. `usageRows` taking any channel: "a bug row is a reference, a time, a person id and a channel" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { arm, dataNamespace, dataObject, guestRules, NOW, noteId, RULES, roleOf, skip, world } from "./dataSyncWorld.mjs";
import { R2Store } from "../src/store/r2.js";
import { parseSheet } from "../src/sheets/csv.js";
import { usageRows, usageWorkspaceOf, USAGE_SHEETS } from "../src/data/sync/runUsage.js";
import { usagePersonId } from "../src/usage/person.js";
import { deriveSearchQualityKey, searchMac } from "../src/search/quality.js";
import { forgetSentMarks, markPersonActive } from "../src/usage/mark.js";
import { markCaller } from "../src/mcp/usage.js";
import { workspaceClient } from "../src/workspaceStore/api.js";

const KEY = await deriveSearchQualityKey("r".repeat(64), "context-usage-person-v1");
const DAY = 86_400_000;
const USAGE_RULES = { ...RULES, etag: "m.u", folders: [...RULES.folders, { prefix: "data/usage", visibility: "private" }] };

const EXPORT = {
  activity: [
    { day: "2026-11-24", person: "aaaaaaaaaaaaaaaa", wrote: true, called: false },
    { day: "2026-11-25", person: "aaaaaaaaaaaaaaaa", wrote: false, called: true },
  ],
  texts: [
    { at: NOW - 60_000, userId: "uBea", outcome: "answered" },
    { at: NOW - 30_000, userId: "uBea", outcome: "failed" },
  ],
  signups: [{ at: NOW - 2 * 3_600_000, userId: "uBea" }],
  calls: [{ at: NOW - 5000, tool: "orient", ms: 540, ok: true, client: "Claude", weight: 2 }],
  replies: [{ at: NOW - 59_000, kind: "one", seconds: 4.2 }],
  bugs: [
    { at: NOW - 90_000, userId: "uBea", channel: "tex", reference: "a".repeat(32) },
    { at: NOW - 80_000, userId: "uBea", channel: "app", reference: "b".repeat(32) },
  ],
  cut: false,
  timingsError: null,
};

/** Alice's workspace with a usage source, its five sheets owners only, and a sync object that reads `exported`. */
async function usageWorld({ rules = USAGE_RULES, named = "alice", exported = EXPORT } = {}) {
  const w = await world();
  w.env.USAGE_WORKSPACE = named;
  w.reads = [];
  w.bugReads = [];
  w.env.DATA_SYNC = w.data = dataNamespace({ env: w.env }, {
    now: () => w.clock.now,
    personKey: KEY,
    usageExport: async (since, bugsSince) => {
      w.reads.push(since);
      w.bugReads.push(bugsSince);
      return structuredClone(exported);
    },
    openStore: (answer) => new R2Store(w.buckets.get(answer.binding.workspaceId)),
  });
  const who = w.alice;
  const ids = { about: noteId(20), activity: noteId(21), signups: noteId(22), replies: noteId(23), calls: noteId(24), bugs: noteId(25) };
  const files = { activity: "activity.csv", signups: "sign-ups.csv", replies: "tex-replies.csv", calls: "calls.csv", bugs: "bug-reports.csv" };
  who.object.store.rows.put([
    { id: "d-usage", path: "data/usage", kind: "folder", at: 1 },
    { id: "f-uabout", path: "data/usage/about.md", kind: "file", at: 2, storageKey: `notes/${ids.about}.md`, noteId: ids.about, etag: "e-ua" },
    ...Object.entries(files).map(([name, file], i) => ({ id: `f-u${name}`, path: `data/usage/${file}`, kind: "file", at: 3 + i, storageKey: `files/${ids[name]}.csv`, noteId: ids[name], etag: `e-u${name}` })),
  ]);
  await who.object.store.objects.put(`notes/${ids.about}.md`, "---\nsource: usage\nname: Context usage\n---\n\nContext-wide activity.\n");
  for (const name of Object.keys(files)) await who.bucket.put(`files/${ids[name]}.csv`, "");
  const client = workspaceClient(w.env, who.pwid);
  await client.rules.put(rules, "member");
  await client.rules.put(guestRules(rules), "guest");
  who.object.store.rows.putRules(rules);
  w.usage = { ids, sheet: async (name) => parseSheet((await (await who.bucket.get(`files/${ids[name]}.csv`))?.text()) ?? "") };
  return w;
}

test("the deployment names its usage workspace by slug, with or without @", () => {
  assert.equal(usageWorkspaceOf({ USAGE_WORKSPACE: "@Supa" }), "supa");
  assert.equal(usageWorkspaceOf({ USAGE_WORKSPACE: " supa " }), "supa");
  for (const bad of [undefined, "", "a b", "@", "x/y", 7]) assert.equal(usageWorkspaceOf({ USAGE_WORKSPACE: bad }), null);
});

test("an owner of the named workspace arms it, and its five sheets fill, by person id only", { skip }, async () => {
  const w = await usageWorld();
  const armed = await arm(w, w.alice, "data/usage/about.md");
  assert.equal(armed.status, 200, JSON.stringify(armed.body));
  assert.equal(armed.body.armed, true);
  assert.equal(armed.body.last.outcome, "ok");
  // The first run reads back 30 days.
  assert.equal(w.reads[0], NOW - 30 * DAY);

  const bea = await usagePersonId(KEY, "uBea");
  const activity = await w.usage.sheet("activity");
  const byId = new Map(activity.rows.map((row) => [row.id, row]));
  assert.deepEqual({ ...byId.get(`2026-11-25:${bea}`) }, { id: `2026-11-25:${bea}`, day: "2026-11-25", person: bea, texted: "1", wrote: "0", called: "0", active: "1", returning: "0" });
  assert.deepEqual({ ...byId.get("2026-11-25:aaaaaaaaaaaaaaaa") }, { id: "2026-11-25:aaaaaaaaaaaaaaaa", day: "2026-11-25", person: "aaaaaaaaaaaaaaaa", texted: "0", wrote: "0", called: "1", active: "0", returning: "1" });
  const signups = await w.usage.sheet("signups");
  assert.deepEqual(signups.rows.map((row) => ({ ...row })), [{ person: bea, day: "2026-11-25", channel: "", day1_active: "1" }]);
  const replies = await w.usage.sheet("replies");
  assert.deepEqual(replies.rows.map((row) => [row.kind, row.seconds, row.answered]).sort(), [["one", "", "0"], ["one", "4.2", "1"]]);
  const calls = await w.usage.sheet("calls");
  assert.deepEqual(calls.rows.map((row) => [row.tool, row.ms, row.ok, row.client, row.weight]), [["orient", "540", "1", "Claude", "2"]]);
  const bugs = await w.usage.sheet("bugs");
  assert.deepEqual(bugs.columns.map((column) => column.name), ["reference", "filed", "person", "channel", "status"]);
  assert.deepEqual(bugs.rows.map((row) => ({ ...row })), [
    { reference: "a".repeat(32), filed: new Date(NOW - 90_000).toISOString().replace(/\.\d{3}Z$/, "Z"), person: bea, channel: "tex", status: "open" },
    { reference: "b".repeat(32), filed: new Date(NOW - 80_000).toISOString().replace(/\.\d{3}Z$/, "Z"), person: bea, channel: "app", status: "open" },
  ]);
  assert.equal(w.bugReads[0], NOW - 30 * DAY);

  // No account id reaches a sheet.
  for (const name of Object.keys(USAGE_SHEETS)) {
    const text = (await (await w.alice.bucket.get(`files/${w.usage.ids[name]}.csv`)).text());
    assert.equal(text.includes("uBea"), false, name);
  }
  // A later run reads back two days, and keeps the flags it already has.
  w.clock.now = NOW + 3_600_000;
  await dataObject(w, "pAlice").instance.alarm();
  assert.equal(w.reads.at(-1), NOW + 3_600_000 - 2 * DAY);
  const again = await w.usage.sheet("activity");
  assert.equal(again.rows.length, activity.rows.length);
  // The bug sheet has rows now, so it reads back two days too.
  assert.equal(w.bugReads.at(-1), NOW + 3_600_000 - 2 * DAY);
});

test("a bug's status is the team's: a run adds it as open and never writes over it", { skip }, async () => {
  const w = await usageWorld();
  await arm(w, w.alice, "data/usage/about.md");
  const key = `files/${w.usage.ids.bugs}.csv`;
  const text = await (await w.alice.bucket.get(key)).text();
  await w.alice.bucket.put(key, text.replace(`${"a".repeat(32)},`, `${"a".repeat(32)},`).replace(/open(\r?\n|$)/, "fixed in #1$1"));
  w.clock.now = NOW + 3_600_000;
  await dataObject(w, "pAlice").instance.alarm();
  const bugs = await w.usage.sheet("bugs");
  assert.deepEqual(bugs.rows.map((row) => [row.reference.slice(0, 1), row.status]), [["a", "fixed in #1"], ["b", "open"]]);
});

test("a bug row is a reference, a time, a person id and a channel: nothing else gets in", async () => {
  const rows = await usageRows(
    {
      bugs: [
        { at: NOW, userId: "uBea", channel: "tex-group", reference: "c".repeat(32) },
        { at: NOW, userId: "uBea", channel: "content", reference: "d".repeat(32) },
        { at: NOW, userId: "uBea", channel: "agent", reference: "the printer is on fire" },
        { at: NOW, userId: "bad id with spaces", channel: "app", reference: "e".repeat(32) },
        { at: "yesterday", userId: "uBea", channel: "app", reference: "f".repeat(32) },
        { at: NOW, userId: "uBea", channel: "agent", reference: "0".repeat(32), message: "secret words" },
      ],
    },
    { key: KEY, held: { activity: new Map(), signups: new Map() }, now: NOW },
  );
  assert.deepEqual(rows.bugs.map((row) => [row.reference.slice(0, 1), row.channel]), [["c", "tex-group"], ["0", "agent"]]);
  assert.equal(JSON.stringify(rows.bugs).includes("secret"), false);
  assert.equal(JSON.stringify(rows.bugs).includes("uBea"), false);
});

test("only the workspace the deployment names can turn it on, and only its owners", { skip }, async () => {
  const elsewhere = await usageWorld({ named: "supa" });
  const refused = await arm(elsewhere, elsewhere.alice, "data/usage/about.md");
  assert.equal(refused.status, 400);
  assert.equal(elsewhere.reads.length, 0);
  assert.equal(JSON.stringify(refused.body).includes("supa"), false);

  const unnamed = await usageWorld({ named: "" });
  assert.equal((await arm(unnamed, unnamed.alice, "data/usage/about.md")).status, 400);

  const editor = await usageWorld();
  await roleOf(editor, editor.alice, "editor");
  // An editor can't read an owners-only folder at all, so to them the source is not there.
  const asEditor = await arm(editor, editor.alice, "data/usage/about.md");
  assert.equal(asEditor.status, 404);
  assert.equal(editor.reads.length, 0);
});

test("a sheet anyone but owners can open stops the source before anything is read", { skip }, async () => {
  // The folder left at the Data folder's team setting.
  const team = await usageWorld({ rules: RULES });
  const armed = await arm(team, team.alice, "data/usage/about.md");
  assert.equal(armed.body.last.outcome, "stopped");
  assert.match(armed.body.last.said, /more than this workspace's owners/);
  assert.equal(team.reads.length, 0);

  // One sheet held for a named person: private to members, a token of its own to guests.
  const listed = await usageWorld({ rules: { ...USAGE_RULES, notes: [...USAGE_RULES.notes, { path: "data/usage/calls.csv", visibility: "private" }] } });
  const client = workspaceClient(listed.env, listed.alice.pwid);
  const guest = guestRules(USAGE_RULES);
  await client.rules.put({ ...guest, notes: [...guest.notes, { path: "data/usage/calls.csv", visibility: "people:0123" }] }, "guest");
  const stoppedListed = await arm(listed, listed.alice, "data/usage/about.md");
  assert.equal(stoppedListed.body.last.outcome, "stopped");
  assert.equal(listed.reads.length, 0);
});

test("an owner who stops being one stops the source at its next run", { skip }, async () => {
  const w = await usageWorld();
  await arm(w, w.alice, "data/usage/about.md");
  await roleOf(w, w.alice, "editor");
  w.clock.now = NOW + 3_600_000;
  await dataObject(w, "pAlice").instance.alarm();
  const kept = (await dataObject(w, "pAlice").storage.get("sources"))[w.usage.ids.about];
  assert.equal(kept.stopped, true);
  assert.equal(w.reads.length, 1);
});

test("returning means active on another day in the 7 before; a day-1 mark is never taken back", async () => {
  const held = {
    activity: new Map([["2026-11-17:bbbbbbbbbbbbbbbb", { id: "2026-11-17:bbbbbbbbbbbbbbbb", day: "2026-11-17", person: "bbbbbbbbbbbbbbbb", texted: "1", wrote: "0", called: "0" }]]),
    signups: new Map([["cccccccccccccccc", { person: "cccccccccccccccc", day: "2026-01-01", channel: "invite", day1_active: "1" }]]),
  };
  const rows = await usageRows(
    {
      activity: [{ day: "2026-11-25", person: "bbbbbbbbbbbbbbbb", wrote: true, called: false }, { day: "2026-11-24", person: "bbbbbbbbbbbbbbbb", wrote: true, called: false }, { day: "nope", person: "not-a-mac", wrote: true }],
      texts: [],
      signups: [],
      calls: [],
      replies: [],
    },
    { key: KEY, held, now: NOW },
  );
  const of = (day) => rows.activity.find((row) => row.day === day);
  assert.equal(of("2026-11-17").returning, "0");
  assert.equal(of("2026-11-24").returning, "1");
  assert.equal(of("2026-11-25").returning, "1");
  assert.equal(rows.activity.some((row) => row.person === "not-a-mac"), false);
  const old = await usageRows({ signups: [{ at: Date.parse("2026-01-01T10:00:00Z"), userId: "uOld" }] }, { key: KEY, held: { activity: new Map(), signups: new Map([[await usagePersonId(KEY, "uOld"), { day1_active: "1", channel: "invite" }]]) }, now: NOW });
  assert.deepEqual({ ...old.signups[0], person: "x" }, { person: "x", day: "2026-01-01", channel: "invite", day1_active: "1" });
});

test("a person id is a MAC under its own key, never the search log's, and never the account", async () => {
  const id = await usagePersonId(KEY, "uBea");
  assert.match(id, /^[0-9a-f]{16}$/);
  const searchKey = await deriveSearchQualityKey("r".repeat(64));
  assert.notEqual(id, await searchMac(searchKey, "usage-person:uBea"));
  assert.equal(await usagePersonId(KEY, "uBea"), id);
  assert.equal(await usagePersonId(null, "uBea"), null);
  assert.equal(await usagePersonId(KEY, "bad id with spaces"), null);
});

test("a person is marked once a day per kind, and the app and Tex are not callers", async () => {
  forgetSentMarks();
  const sent = [];
  const deferred = [];
  const store = { defer: (p) => deferred.push(p) };
  const controlPlane = { reportUsage: async (events, hourly, people) => sent.push(people) };
  const env = { SEARCH_QUALITY_KEY: { idFromName: () => ({}), get: () => ({ fetch: async () => Response.json({ root: "r".repeat(64) }) }) } };
  const session = { actorUserId: "uBea" };
  const now = Date.parse("2026-11-25T10:00:00Z");
  markPersonActive(store, session, env, controlPlane, "called", now);
  markPersonActive(store, session, env, controlPlane, "called", now + 1000);
  markPersonActive(store, session, env, controlPlane, "texted", now);
  markPersonActive(store, { actorUserId: "" }, env, controlPlane, "called", now);
  await Promise.all(deferred);
  assert.equal(deferred.length, 1);

  let marked = [];
  const probe = (clientId) => {
    marked = [];
    markCaller({ actor: { clientId }, markPersonActive: (kind) => marked.push(kind) });
    return marked;
  };
  assert.deepEqual(probe("claude"), ["called"]);
  assert.deepEqual(probe("context_console"), []);
  assert.deepEqual(probe("context_texts"), []);
  assert.deepEqual(probe(""), []);
});
