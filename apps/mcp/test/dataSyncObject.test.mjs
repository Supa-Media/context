/**
 * The data sync object and "Fetch from a URL" end to end (`src/data/sync/object.js`, `run.js`, `route.js`, `about.js`):
 * the app's `POST /files/data-sync` through the worker, the object's arm, status and hourly alarm, and one run's read
 * of the source's about.md, fetch, merge and write, over real workspace objects in memory and an in-memory bucket.
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. The role check dropped from `handleDataSync` (any member arms):
 *    "a member without edit, a read-only connection and an AI client cannot arm" fails.
 * 2. `pin` in the object answering true for any workspace:
 *    "one workspace's sync object never reads or writes another's" fails.
 * 3. `runUrlSource` reading the address from the about.md text kept at arming instead of re-reading it each run
 *    (the about.md read skipped after the first run): "an address edited to a private one after arming is refused
 *    at run time, and nothing is written" fails.
 * 4. The alarm re-armed unconditionally at the end of `alarm()`:
 *    "a deleted source stops the alarm" fails.
 * 5. `ensureAlarm` setting a new alarm whenever one is armed (no `getAlarm` check):
 *    "arming many times never stacks an alarm or fetches the address again" fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceClient } from "../src/workspaceStore/api.js";
import { splitWorkspacePath } from "../src/workspacePath.js";
import { R2Store } from "../src/store/r2.js";
import { MAX_SHEET_ROWS, parseSheet } from "../src/sheets/csv.js";
import { DATA_SYNC_PATH } from "../src/data/sync/route.js";
import { MAX_SOURCES, SYNC_EVERY_MS, dataObjectName } from "../src/data/sync/object.js";
import { DATA_SYNC_ACTION, DATA_SYNC_CLIENT_ID } from "../src/data/sync/run.js";
import { FETCHED_COLUMN, shapeFetched, urlSourceOf } from "../src/data/sync/about.js";
import { toolReadSheet } from "../src/tools/readSheet.js";
import { parsePrivacyManifest } from "../src/privacy/engine.js";
import { memoryBucket } from "./store/fixtures.mjs";
import { skip, RULES, noteId, ABOUT, GOOD_URL, workspace, outside, NOW, world, send, arm, status, sheetOf, dataObject, audits, roleOf } from "./dataSyncWorld.mjs";

test("the route's address is never read as a workspace name, and the object's name is the workspace's own", () => {
  assert.deepEqual(splitWorkspacePath(DATA_SYNC_PATH), { slug: null, path: DATA_SYNC_PATH });
  assert.equal(dataObjectName("pAlice"), "data:pAlice");
  assert.throws(() => dataObjectName("a/b"));
  assert.throws(() => dataObjectName(""));
});

test("an owner arms a url source: it runs at once, writes the sheet, records the run, and audits the data sync", { skip }, async () => {
  const w = await world();
  const armed = await arm(w, w.alice);
  assert.equal(armed.status, 200, JSON.stringify(armed.body));
  assert.equal(armed.body.armed, true);
  assert.equal(armed.body.last.outcome, "ok");
  assert.equal(armed.body.last.rows, 2);
  assert.equal(armed.body.last.at, NOW);
  const sheet = parseSheet(await sheetOf(w.alice));
  assert.deepEqual(sheet.rows.map((row) => row.id), ["INC-1", "INC-2"]);
  // Placed in eastern North America, as every object here is.
  assert.ok(w.data.hints.every((hint) => hint === "enam"), w.data.hints.join(","));
  // The sheet's row has its new version, recorded in the workspace object.
  const row = w.alice.object.store.rows.byPath("data/status/incidents.csv");
  assert.equal(row.etag, (await w.alice.bucket.get(`files/${w.alice.ids.sheet}.csv`)).etag);
  // The audit says it was the data sync, on whose standing.
  const [entry] = audits(w.alice);
  assert.equal(entry.action, DATA_SYNC_ACTION);
  assert.equal(entry.actor_client_id, DATA_SYNC_CLIENT_ID);
  assert.equal(entry.actor_user_id, "uAlice");
  assert.deepEqual(entry.paths, ["data/status/incidents.csv"]);
  // The status reads the same run back, and the alarm is set an hour on.
  const asked = await status(w, w.alice);
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.body.sources, [{ about: "data/status/about.md", armed: true, last: { at: NOW, outcome: "ok", rows: 2 } }]);
  assert.equal(dataObject(w, "pAlice").storage.alarm, NOW + SYNC_EVERY_MS);
});

test("a member without edit, a read-only connection and an AI client cannot arm", { skip }, async () => {
  const w = await world();
  await roleOf(w, w.alice, "member");
  const member = await arm(w, w.alice);
  assert.equal(member.status, 403, JSON.stringify(member.body));
  // An AI client, even one that may write, writes the about.md and never arms it.
  await roleOf(w, w.alice, "owner");
  const ai = await arm(w, w.alice, undefined, { token: w.alice.aiToken });
  assert.equal(ai.status, 403);
  assert.equal(w.data.objects.size, 0, "no sync object was asked");
  assert.equal(w.net.calls.length, 0, "nothing was fetched");
});

test("a non-member cannot arm, read status or learn a source exists", { skip }, async () => {
  const w = await world();
  const bob = await workspace(w, { pwid: "pBob", user: "uBob", slug: "bob" });
  // Bob's token addressed at Alice's workspace: refused before the route runs.
  const asAlice = await arm(w, bob, undefined, { slug: "alice" });
  assert.equal(asAlice.status, 403, JSON.stringify(asAlice.body));
  const peek = await status(w, bob, undefined, { slug: "alice" });
  assert.equal(peek.status, 403);
  // Bob's token, his own address, naming Alice's workspace in the body: refused before anything is read.
  const named = await send(w, bob, { workspaceId: "pAlice", op: "arm", about: "data/status/about.md" });
  assert.equal(named.status, 409);
  assert.equal(named.body.error, "wrong_workspace");
  assert.equal(dataObject(w, "pAlice"), undefined);
  assert.equal(await sheetOf(w.alice), "");
});

test("one workspace's sync object never reads or writes another's", { skip }, async () => {
  const w = await world();
  const bob = await workspace(w, { pwid: "pBob", user: "uBob", slug: "bob" });
  assert.equal((await arm(w, w.alice)).status, 200);
  assert.equal((await arm(w, bob)).status, 200);
  assert.notEqual(dataObject(w, "pAlice"), dataObject(w, "pBob"));
  // Every run opened its own workspace's bucket.
  assert.deepEqual(w.opened.map((o) => o.named), ["pAlice", "pBob"]);
  // Alice's object, asked about Bob's workspace or Bob's source, refuses: it is pinned to Alice's.
  const alicesObject = dataObject(w, "pAlice");
  const crossed = await alicesObject.fetch("https://data-sync.internal/", { method: "POST", body: JSON.stringify({ op: "arm", workspaceId: "pBob", noteId: bob.ids.about, armedBy: "uBob" }) });
  assert.equal(crossed.status, 403);
  const peek = await alicesObject.fetch("https://data-sync.internal/", { method: "POST", body: JSON.stringify({ op: "status", workspaceId: "pBob", noteIds: [bob.ids.about] }) });
  assert.equal(peek.status, 403);
  // Bob's note id armed in Alice's object (by someone who got hold of the id) is never found in Alice's workspace.
  const smuggled = await alicesObject.instance.arm({ workspaceId: "pAlice", noteId: bob.ids.about, armedBy: "uAlice" });
  assert.equal(smuggled.last.outcome, "stopped");
  assert.equal(w.opened.length, 2, "no bucket was opened for it");
});

test("a source held back from the person, or not in the Data folder, or not a url source, is not armed", { skip }, async () => {
  const w = await world();
  await roleOf(w, w.alice, "editor");
  // The private source's about.md is held back from an editor: it answers as a missing one.
  const held = await arm(w, w.alice, "data/private-feed/about.md");
  const missing = await arm(w, w.alice, "data/nothing/about.md");
  assert.deepEqual([held.status, held.body], [missing.status, missing.body]);
  assert.equal(held.status, 404);
  // A url about.md outside the Data folder.
  w.alice.object.store.rows.put([{ id: "f-loose", path: "areas/about.md", kind: "file", at: 9, storageKey: `notes/${noteId(9, "pAlice")}.md`, noteId: noteId(9, "pAlice"), etag: "e9" }]);
  await w.alice.object.store.objects.put(`notes/${noteId(9, "pAlice")}.md`, ABOUT(GOOD_URL));
  assert.equal((await arm(w, w.alice, "areas/about.md")).status, 404);
  // A push source, and an address that is not a public https one.
  await w.alice.object.store.objects.put(`notes/${w.alice.ids.about}.md`, "---\nsource: push\n---\n");
  assert.equal((await arm(w, w.alice)).status, 400);
  await w.alice.object.store.objects.put(`notes/${w.alice.ids.about}.md`, ABOUT("http://10.0.0.1/x"));
  const local = await arm(w, w.alice);
  assert.equal(local.status, 400);
  assert.match(local.body.message, /https on a public name/);
  assert.equal(w.net.calls.length, 0);
});

test("an address edited to a private one after arming is refused at run time, and nothing is written", { skip }, async () => {
  const w = await world();
  assert.equal((await arm(w, w.alice)).body.last.outcome, "ok");
  const before = await sheetOf(w.alice);
  // Someone (Tex, an AI client) edits the about.md to a name that resolves to a private address.
  await w.alice.object.store.objects.put(`notes/${w.alice.ids.about}.md`, ABOUT("https://rebind.example.com/x.json"));
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  const asked = await status(w, w.alice);
  assert.equal(asked.body.sources[0].last.outcome, "failed");
  assert.match(asked.body.sources[0].last.said, /^Nothing was written: rebind\.example\.com points at a private address\.$/);
  assert.equal(await sheetOf(w.alice), before, "the sheet is as it was");
  assert.ok(!w.net.calls.some((url) => url.includes("rebind")), "the private name was never fetched");
  // A failed run is tried again: the alarm is set for the next hour.
  assert.equal(dataObject(w, "pAlice").storage.alarm, NOW + 2 * SYNC_EVERY_MS);
});

test("a refused fetch writes nothing and says why in plain words", { skip }, async () => {
  const w = await world();
  w.net.answers.set("status.example.com", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } }));
  const armed = await arm(w, w.alice);
  assert.equal(armed.status, 200);
  assert.equal(armed.body.armed, true, "a failed run stays armed and is tried again");
  assert.deepEqual(armed.body.last, { at: NOW, outcome: "failed", said: "Nothing was written: status.example.com redirects; give the address it ends at." });
  assert.equal(await sheetOf(w.alice), "");
  assert.equal(audits(w.alice).length, 0);
});

test("an over-cap run writes nothing and names the sheet", { skip }, async () => {
  const w = await world();
  const many = Array.from({ length: MAX_SHEET_ROWS + 1 }, (_, i) => ({ id: `r${i}`, opened: "2026-11-25" }));
  // Past the cap, as the address answers it, or as the merge with what the sheet holds would make it.
  w.net.answers.set("status.example.com", () => Response.json(many.slice(0, MAX_SHEET_ROWS)));
  await w.alice.bucket.put(`files/${w.alice.ids.sheet}.csv`, "id,opened:date\nold-1,2026-11-24\n");
  const before = await sheetOf(w.alice);
  const armed = await arm(w, w.alice);
  assert.equal(armed.body.last.outcome, "failed");
  assert.match(armed.body.last.said, /data\/status\/incidents\.csv would pass 50,000 rows, so nothing was written/);
  assert.equal(await sheetOf(w.alice), before);
});

test("a deleted source stops the alarm, and is forgotten", { skip }, async () => {
  const w = await world();
  await arm(w, w.alice);
  const object = dataObject(w, "pAlice");
  assert.equal(object.storage.alarm, NOW + SYNC_EVERY_MS);
  // The about.md is deleted (its row removed).
  w.alice.object.store.rows.remove([`f-about-pAlice`], 99);
  w.clock.now = NOW + SYNC_EVERY_MS;
  const fetchesBefore = w.net.calls.length;
  await object.instance.alarm();
  assert.equal(object.storage.alarm, null, "the alarm is not set again: nothing is left to sync");
  assert.deepEqual(object.storage.map.get("sources"), {});
  assert.equal(w.net.calls.length, fetchesBefore, "nothing was fetched for it");
});

test("a person who can no longer edit, or a workspace gone, stops the source and the alarm", { skip }, async () => {
  const w = await world();
  await arm(w, w.alice);
  const object = dataObject(w, "pAlice");
  // The person who armed it is removed (as when a workspace is deleted and its members go).
  w.alice.object.store.members.remove("members", ["uAlice"], 50);
  w.clock.now = NOW + SYNC_EVERY_MS;
  await object.instance.alarm();
  assert.equal(object.storage.alarm, null);
  const kept = object.storage.map.get("sources")[w.alice.ids.about];
  assert.equal(kept.stopped, true);
  assert.match(kept.last.said, /can no longer edit this workspace/);
  // An editor arms it again: it runs on their standing.
  w.alice.object.store.members.put("members", [{ userId: "uAlice", personalWorkspaceId: "pAlice", role: "editor", groups: [], at: 60 }]);
  await workspaceClient(w.env, "pAlice").access.reach.put([{ workspaceId: "pAlice", slug: "alice", kind: "shared", role: "editor", groups: [], at: 60 }]);
  const again = await arm(w, w.alice);
  assert.equal(again.body.armed, true);
  assert.equal(again.body.last.outcome, "ok");
  assert.equal(object.storage.alarm, NOW + 2 * SYNC_EVERY_MS);
});

test("a source folder renamed or moved is followed by its about.md's note id; moved out of the Data folder, it stops", { skip }, async () => {
  const w = await world();
  await arm(w, w.alice);
  const object = dataObject(w, "pAlice");
  // Renamed: the folder and its two notes move together (rows keep their note ids).
  w.alice.object.store.rows.put([
    { id: "d-src-pAlice", path: "data/status-page", kind: "folder", at: 10 },
    { id: "f-about-pAlice", path: "data/status-page/about.md", kind: "file", at: 10, storageKey: `notes/${w.alice.ids.about}.md`, noteId: w.alice.ids.about, etag: "e-about" },
    { id: "f-sheet-pAlice", path: "data/status-page/incidents.csv", kind: "file", at: 10, storageKey: `files/${w.alice.ids.sheet}.csv`, noteId: w.alice.ids.sheet, etag: w.alice.object.store.rows.byPath("data/status/incidents.csv").etag },
  ]);
  w.net.answers.set("status.example.com", () => Response.json([{ id: "INC-3", opened: "2026-11-25" }]));
  w.clock.now = NOW + SYNC_EVERY_MS;
  await object.instance.alarm();
  const renamed = object.storage.map.get("sources")[w.alice.ids.about];
  assert.equal(renamed.last.outcome, "ok", renamed.last.said);
  assert.deepEqual(parseSheet(await sheetOf(w.alice)).rows.map((row) => row.id), ["INC-1", "INC-2", "INC-3"]);
  // Moved out of the Data folder: it stops, and the sheet is left as it is.
  w.alice.object.store.rows.put([
    { id: "d-src-pAlice", path: "areas/status-page", kind: "folder", at: 11 },
    { id: "f-about-pAlice", path: "areas/status-page/about.md", kind: "file", at: 11, storageKey: `notes/${w.alice.ids.about}.md`, noteId: w.alice.ids.about, etag: "e-about" },
    { id: "f-sheet-pAlice", path: "areas/status-page/incidents.csv", kind: "file", at: 11, storageKey: `files/${w.alice.ids.sheet}.csv`, noteId: w.alice.ids.sheet, etag: "x" },
  ]);
  const before = await sheetOf(w.alice);
  w.clock.now = NOW + 2 * SYNC_EVERY_MS;
  await object.instance.alarm();
  const moved = object.storage.map.get("sources")[w.alice.ids.about];
  assert.equal(moved.stopped, true);
  assert.match(moved.last.said, /no longer in a source folder of the Data folder/);
  assert.equal(await sheetOf(w.alice), before);
  assert.equal(object.storage.alarm, null);
});

test("arming many times never stacks an alarm or fetches the address again", { skip }, async () => {
  const w = await world();
  for (let i = 0; i < 5; i += 1) assert.equal((await arm(w, w.alice)).status, 200);
  const object = dataObject(w, "pAlice");
  assert.equal(object.storage.alarmsSet, 1);
  assert.equal(object.storage.alarm, NOW + SYNC_EVERY_MS);
  assert.equal(w.net.calls.length, 1, "armed five times in a minute, fetched once");
  // A minute on, arming again runs it again, still under the one alarm.
  w.clock.now = NOW + 2 * 60 * 1000;
  await arm(w, w.alice);
  assert.equal(w.net.calls.length, 2);
  assert.equal(object.storage.alarmsSet, 1);
});

test("a workspace syncs at most so many addresses", { skip }, async () => {
  const w = await world();
  const object = (await arm(w, w.alice), dataObject(w, "pAlice"));
  const sources = object.storage.map.get("sources");
  for (let i = 0; i < MAX_SOURCES; i += 1) sources[noteId(100 + i, "pAlice")] = { noteId: noteId(100 + i, "pAlice"), armedBy: "uAlice", armedAt: NOW, last: null };
  await object.storage.put("sources", sources);
  const refused = await object.instance.arm({ workspaceId: "pAlice", noteId: noteId(500, "pAlice"), armedBy: "uAlice" });
  assert.equal(refused.error, "too_many");
});

test("status leaves out a source the reader cannot read", { skip }, async () => {
  const w = await world();
  await arm(w, w.alice, "data/private-feed/about.md");
  await roleOf(w, w.alice, "editor");
  const asked = await status(w, w.alice, ["data/private-feed/about.md", "data/status/about.md"]);
  assert.equal(asked.status, 200);
  assert.deepEqual(asked.body.sources, [{ about: "data/status/about.md", armed: false, last: null }]);
});

test("a synced sheet's cells reach an agent as a quotation, never an instruction", { skip }, async () => {
  const w = await world();
  await arm(w, w.alice);
  const text = await sheetOf(w.alice);
  // The synced sheet as an agent's read reaches it, at its path.
  const store = new R2Store(memoryBucket());
  await store.put("data/status/incidents.csv", text);
  const { rules, overrides } = parsePrivacyManifest("<!-- BEGIN BRAIN PRIVACY RULES -->\n```yaml\ndefault_visibility: private\n\nfolder_defaults:\n  data/: team\n```\n<!-- END BRAIN PRIVACY RULES -->\n");
  const result = await toolReadSheet(store, "team", rules, overrides, { path: "data/status/incidents.csv" });
  const out = result.content.map((part) => part.text).join("");
  assert.match(out, /trust: untrusted/);
  assert.match(out, /Ignore previous instructions/);
  assert.ok(out.indexOf("trust: untrusted") < out.indexOf("Ignore previous instructions"));
});

test("a fetched answer becomes rows: a key and a date named, an hourly snapshot, and an unkeyed list refused", () => {
  const settings = urlSourceOf(ABOUT(GOOD_URL, "key: id\ndate: opened\n"));
  assert.deepEqual(settings, { ok: true, url: GOOD_URL, dataset: "incidents", key: "id", date: "opened" });
  // One value with no date: a row an hour, keyed by the hour it was fetched.
  const one = shapeFetched({ fetched: { columns: [{ name: "open", type: "number" }], rows: [{ open: "4" }] }, settings: { key: null, date: null }, sheet: null, now: NOW });
  assert.equal(one.ok, true);
  assert.equal(one.key, FETCHED_COLUMN);
  assert.equal(one.incoming[0][FETCHED_COLUMN], "2026-11-25T12:00Z");
  // Several rows, no key named: refused rather than guessed.
  const many = shapeFetched({ fetched: { columns: [{ name: "open", type: "number" }], rows: [{ open: "4" }, { open: "5" }] }, settings: { key: null, date: null }, sheet: null, now: NOW });
  assert.equal(many.ok, false);
  assert.match(many.refused, /names no key/);
  // A column the answer brings that the sheet lacks is added, never dropped.
  const grown = shapeFetched({ fetched: { columns: [{ name: "id", type: "text" }, { name: "sev", type: "number" }], rows: [{ id: "a", sev: "2" }] }, settings: { key: "id", date: null }, sheet: { columns: [{ name: "id", type: "text" }, { name: FETCHED_COLUMN, type: "date" }], rows: [] }, now: NOW });
  assert.deepEqual(grown.columns.map((c) => c.name), ["id", FETCHED_COLUMN, "sev"]);
  // A dataset's name never leaves the source's folder.
  assert.equal(urlSourceOf(ABOUT(GOOD_URL).replace("dataset: incidents", "dataset: ../../secrets")).dataset, "secrets");
  assert.equal(urlSourceOf("---\nsource: push\n---\n").kind, "not_url");
});

test("an hourly value with no date makes one row an hour, and a second run in the hour replaces it", { skip }, async () => {
  const w = await world();
  await w.alice.object.store.objects.put(`notes/${w.alice.ids.about}.md`, ABOUT(GOOD_URL, ""));
  w.net.answers.set("status.example.com", () => Response.json({ open: 4 }));
  // A JSON object, not a list, is refused; a list of one is the value.
  const refused = await arm(w, w.alice);
  assert.match(refused.body.last.said, /not a list of rows/);
  w.net.answers.set("status.example.com", () => Response.json([{ open: 4 }]));
  w.clock.now = NOW + 2 * 60 * 1000;
  assert.equal((await arm(w, w.alice)).body.last.outcome, "ok");
  w.net.answers.set("status.example.com", () => Response.json([{ open: 6 }]));
  w.clock.now = NOW + 4 * 60 * 1000;
  await arm(w, w.alice);
  assert.deepEqual(parseSheet(await sheetOf(w.alice)).rows.map((row) => [row.open, row[FETCHED_COLUMN]]), [["6", "2026-11-25T12:00Z"]]);
  w.net.answers.set("status.example.com", () => Response.json([{ open: 7 }]));
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  assert.deepEqual(parseSheet(await sheetOf(w.alice)).rows.map((row) => row.open), ["6", "7"]);
});

test("without the binding the route answers 501 and nothing is asked", { skip }, async () => {
  const w = await world();
  delete w.env.DATA_SYNC;
  const armed = await arm(w, w.alice);
  assert.equal(armed.status, 501);
  assert.equal(w.net.calls.length, 0);
});
