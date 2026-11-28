/**
 * The sync status a data source shows (`src/data/sync/object.js`: `syncLine`, the last good sync kept beside the last
 * run; `route.js`: the status answer; `aboutStatus.js`: the `sync:` line on a read of the source's about.md), over real
 * workspace objects in memory (`dataSyncWorld.mjs`) with the outside answered by host.
 *
 * Sabotage record (temporary local edit, reverted; the named cases failed each time):
 * 1. `alarm()` no longer setting `synced` on an ok run: "an hourly run that comes back ok is the last good sync, even
 *    when the arming run failed" fails. (Before that case was added, this sabotage passed every test: each alarm run
 *    followed an ok arm, so the carried-over `synced` hid it.)
 * 2. `withSyncLine` answering for any note, not only a source's about.md: "a read that is not a data source's about.md
 *    is returned unchanged" fails.
 * 3. `toolReadNotes` joining its reads without withSyncLine: "a batch read carries each data source's sync line, and an
 *    ordinary note gets none" fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SYNC_EVERY_MS, syncLine } from "../src/data/sync/object.js";
import { SYNC_LINE_WAIT_MS, dataSyncStubFor, withSyncLine } from "../src/data/sync/aboutStatus.js";
import { workspaceClient } from "../src/workspaceStore/api.js";
import { toolReadNotes } from "../src/tools/notes/read.js";
import { PrivacyOverrides } from "../src/privacy/engine.js";
import { skip, ABOUT, GOOD_URL, NOW, arm, dataObject, noteId, send, status, world } from "./dataSyncWorld.mjs";

const HOUR = SYNC_EVERY_MS;
const AT = "2026-11-25 12:30 UTC";
const LATER = "2026-11-25 13:30 UTC";

/* ----- syncLine as a pure function ----- */

test("syncLine: a source nobody has started says so, and who starts it", () => {
  assert.equal(syncLine(null, NOW), "Not syncing: this source hasn't been started. An owner or editor starts it from the Data page.");
  assert.equal(syncLine(undefined, NOW), syncLine(null, NOW));
});

test("syncLine: armed but never run says when it was started, and that the first sync is within the hour", () => {
  assert.equal(syncLine({ armedAt: NOW, last: null }, NOW), `Not synced yet: started ${AT}; the first sync runs within the hour`);
});

test("syncLine: an ok run says when it last synced and how many rows it holds, with the comma and the singular", () => {
  assert.equal(syncLine({ last: { at: NOW, outcome: "ok", rows: 1234 }, synced: { at: NOW, rows: 1234 } }, NOW), `Last synced: ${AT} · 1,234 rows`);
  assert.equal(syncLine({ last: { at: NOW, outcome: "ok", rows: 1 } }, NOW), `Last synced: ${AT} · 1 row`);
  // Rows unknown: the sentence stops at the time.
  assert.equal(syncLine({ last: { at: NOW, outcome: "ok" } }, NOW), `Last synced: ${AT}`);
  // Rows not on the run, but on the last good sync: that count is the one to say.
  assert.equal(syncLine({ last: { at: NOW, outcome: "ok" }, synced: { at: NOW, rows: 7 } }, NOW), `Last synced: ${AT} · 7 rows`);
});

test("syncLine: a failed run says why and when, then the last good sync and its rows", () => {
  const failed = { last: { at: NOW + HOUR, outcome: "failed", said: "Nothing was written: status.example.com redirects; give the address it ends at." }, synced: { at: NOW, rows: 2 } };
  assert.equal(
    syncLine(failed, NOW + HOUR),
    `Failed: Nothing was written: status.example.com redirects; give the address it ends at (${LATER}) · last synced ${AT} · 2 rows`,
  );
  // No good sync yet: the failure alone.
  assert.equal(syncLine({ last: { at: NOW, outcome: "failed", said: "Nothing was written: x." } }, NOW), `Failed: Nothing was written: x (${AT})`);
});

test("syncLine: a stopped app says it needs reconnecting, with its reason and last good sync", () => {
  const stopped = {
    kind: "app",
    stopped: true,
    last: { at: NOW, outcome: "stopped", said: "Stopped: Cloudflare was disconnected. An owner can connect it again here." },
    synced: { at: NOW - HOUR, rows: 3 },
  };
  assert.equal(
    syncLine(stopped, NOW),
    `Stopped: Cloudflare was disconnected. An owner can connect it again here (needs reconnecting) · last synced 2026-11-25 11:30 UTC · 3 rows`,
  );
});

test("syncLine: a stopped url source says it needs starting again, and falls back to a plain reason when it has none", () => {
  const named = { stopped: true, last: { at: NOW, outcome: "stopped", said: "Stopped: its about.md is no longer in a source folder of the Data folder." } };
  assert.equal(syncLine(named, NOW), "Stopped: its about.md is no longer in a source folder of the Data folder (needs starting again)");
  assert.equal(syncLine({ stopped: true, last: null }, NOW), "Stopped: it was stopped (needs starting again)");
});

test("syncLine: a large row count reads with a comma, and the sentence stays words, numbers and punctuation", () => {
  const line = syncLine({ last: { at: NOW, outcome: "ok", rows: 50000 } }, NOW);
  assert.equal(line, `Last synced: ${AT} · 50,000 rows`);
  assert.match(line, /^[A-Za-z0-9 ,:·.()-]+$/);
});

/* ----- the status answer ----- */

test("a url source's status says when it last synced, and a failed run keeps that", { skip }, async () => {
  const w = await world();
  assert.equal((await arm(w, w.alice)).status, 200);
  const [ok] = (await status(w, w.alice)).body.sources;
  assert.deepEqual(ok.synced, { at: NOW, rows: 2 });
  assert.equal(ok.line, `Last synced: ${AT} · 2 rows`);
  // The address now redirects: the next hour's run fails, and the last good sync stays.
  w.net.answers.set("status.example.com", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } }));
  w.clock.now = NOW + HOUR;
  await dataObject(w, "pAlice").instance.alarm();
  const [failed] = (await status(w, w.alice)).body.sources;
  assert.equal(failed.last.outcome, "failed");
  assert.deepEqual(failed.synced, { at: NOW, rows: 2 }, "a failed run keeps the earlier good sync");
  assert.match(failed.line, /^Failed: /);
  assert.ok(failed.line.includes(`last synced ${AT} · 2 rows`), failed.line);
});

test("an hourly run that comes back ok is the last good sync, even when the arming run failed", { skip }, async () => {
  const w = await world();
  // Armed while the address redirects: the arming run fails, so nothing has synced yet.
  w.net.answers.set("status.example.com", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example.com/" } }));
  const refused = await arm(w, w.alice);
  assert.equal(refused.body.last.outcome, "failed");
  const [before] = (await status(w, w.alice)).body.sources;
  assert.equal(before.synced, null);
  assert.ok(before.line.startsWith("Failed: "), before.line);
  // The address answers again: the next hour's run is the first good sync, and the status says so.
  w.net.answers.set("status.example.com", () => Response.json([{ id: "INC-1", opened: "2026-11-25" }]));
  w.clock.now = NOW + HOUR;
  await dataObject(w, "pAlice").instance.alarm();
  const [after] = (await status(w, w.alice)).body.sources;
  assert.equal(after.last.outcome, "ok");
  assert.deepEqual(after.synced, { at: NOW + HOUR, rows: 1 });
  assert.equal(after.line, "Last synced: 2026-11-25 13:30 UTC · 1 row");
});

test("a stopped url source says so and needs starting again; arming it again says when it last synced", { skip }, async () => {
  const w = await world();
  assert.equal((await arm(w, w.alice)).status, 200);
  // The person who armed it can no longer edit: the next run stops the source.
  w.alice.object.store.members.remove("members", ["uAlice"], 50);
  w.clock.now = NOW + HOUR;
  await dataObject(w, "pAlice").instance.alarm();
  // Asked of the object directly: the person has lost their place to read the source, so the route has nothing to answer.
  const stopped = (await dataObject(w, "pAlice").instance.status({ workspaceId: "pAlice", noteIds: [w.alice.ids.about] })).sources[0];
  assert.equal(stopped.armed, false);
  assert.ok(stopped.line.startsWith("Stopped: "), stopped.line);
  assert.ok(stopped.line.includes("(needs starting again)"), stopped.line);
  assert.deepEqual(stopped.synced, { at: NOW, rows: 2 });
  // An editor arms it again: the status says it synced.
  w.alice.object.store.members.put("members", [{ userId: "uAlice", personalWorkspaceId: "pAlice", role: "editor", groups: [], at: 60 }]);
  await workspaceClient(w.env, "pAlice").access.reach.put([{ workspaceId: "pAlice", slug: "alice", kind: "shared", role: "editor", groups: [], at: 60 }]);
  const again = await arm(w, w.alice);
  assert.equal(again.body.armed, true);
  const [restored] = (await status(w, w.alice)).body.sources;
  assert.ok(restored.line.startsWith("Last synced: "), restored.line);
});

test("an app source says it needs reconnecting when disconnected, and no longer reads as stopped once connected again", { skip }, async () => {
  const w = await world();
  const ids = { about: noteId(32, "pAlice"), spend: noteId(33, "pAlice") };
  w.alice.object.store.rows.put([
    { id: "d-cf-pAlice", path: "data/cloudflare", kind: "folder", at: 10 },
    { id: "f-cf-pAlice", path: "data/cloudflare/about.md", kind: "file", at: 13, storageKey: `notes/${ids.about}.md`, noteId: ids.about, etag: "e-c" },
    { id: "f-spend-pAlice", path: "data/cloudflare/ai-spend.csv", kind: "file", at: 14, storageKey: `files/${ids.spend}.csv`, noteId: ids.spend, etag: "e-p" },
  ]);
  await w.alice.object.store.objects.put(`notes/${ids.about}.md`, "---\nsource: cloudflare\nname: \"cloudflare\"\n---\n\nConnected by an owner.\n");
  await w.alice.bucket.put(`files/${ids.spend}.csv`, "");
  const token = "cf".repeat(20);
  const account = "a".repeat(32);
  const groups = [{ count: 2, sum: { cost: 0.25, tokensIn: 20, tokensOut: 10 }, dimensions: { date: "2026-11-25", gateway: "context", provider: "anthropic", model: "claude-haiku-5-5" } }];
  w.net.answers.set("api.cloudflare.com", (url, init) => {
    if (String(new Headers(init?.headers ?? {}).get("authorization") ?? "") !== `Bearer ${token}`) return Response.json({ success: false }, { status: 403 });
    const path = new URL(url).pathname;
    if (path.endsWith("/user/tokens/verify")) return Response.json({ result: { status: "active" } });
    if (path.endsWith("/accounts")) return Response.json({ result: [{ id: account }] });
    if (path.endsWith("/graphql")) return Response.json({ data: { viewer: { accounts: [{ aiGatewayRequestsAdaptiveGroups: groups }] } } });
    return new Response("nope", { status: 404 });
  });
  const about = "data/cloudflare/about.md";
  const connected = await send(w, w.alice, { workspaceId: "pAlice", op: "connect", about, key: token });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  const [first] = (await status(w, w.alice, [about])).body.sources;
  assert.ok(first.line.startsWith("Last synced: "), first.line);
  assert.deepEqual(first.synced, { at: NOW, rows: 1 });

  const gone = await send(w, w.alice, { workspaceId: "pAlice", op: "disconnect", app: "cloudflare" });
  assert.equal(gone.status, 200);
  const [stopped] = (await status(w, w.alice, [about])).body.sources;
  assert.ok(stopped.line.startsWith("Stopped: "), stopped.line);
  assert.ok(stopped.line.includes("(needs reconnecting)"), stopped.line);
  assert.deepEqual(stopped.synced, { at: NOW, rows: 1 });

  const again = await send(w, w.alice, { workspaceId: "pAlice", op: "connect", about, key: token });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const [back] = (await status(w, w.alice, [about])).body.sources;
  assert.equal(back.line.startsWith("Stopped"), false, back.line);
  assert.ok(back.line.startsWith("Last synced: "), back.line);
});

test("a metric's status says when its reading was last kept", { skip }, async () => {
  const w = await world();
  const ids = { note: noteId(20, "pAlice"), kept: noteId(21, "pAlice"), incidents: noteId(22, "pAlice") };
  const notePath = "data/metrics/open-incidents.md";
  w.alice.object.store.rows.put([
    { id: "d-metrics-pAlice", path: "data/metrics", kind: "folder", at: 10 },
    { id: "f-metric-pAlice", path: notePath, kind: "file", at: 11, storageKey: `notes/${ids.note}.md`, noteId: ids.note, etag: "e-metric" },
    { id: "f-kept-pAlice", path: "data/metrics/open-incidents.csv", kind: "file", at: 12, storageKey: `files/${ids.kept}.csv`, noteId: ids.kept, etag: "e-kept" },
    { id: "d-ops-pAlice", path: "data/ops", kind: "folder", at: 10 },
    { id: "f-inc-pAlice", path: "data/ops/incidents.csv", kind: "file", at: 13, storageKey: `files/${ids.incidents}.csv`, noteId: ids.incidents, etag: "e-inc" },
  ]);
  await w.alice.object.store.objects.put(`notes/${ids.note}.md`, "---\nmetric: Open incidents\nformula: \"count(ops/incidents.id where open = true)\"\nevery: day\n---\n\nIncidents open right now.\n");
  await w.alice.bucket.put(`files/${ids.kept}.csv`, "");
  await w.alice.bucket.put(`files/${ids.incidents}.csv`, "id,severity,open:checkbox\nINC-1,high,true\nINC-2,low,true\nINC-3,high,false\n");
  const armed = await send(w, w.alice, { workspaceId: "pAlice", op: "arm", metric: notePath });
  assert.equal(armed.status, 200, JSON.stringify(armed.body));
  assert.equal(armed.body.last.outcome, "ok", JSON.stringify(armed.body.last));
  const asked = await send(w, w.alice, { workspaceId: "pAlice", op: "status", metric: [notePath] });
  assert.equal(asked.status, 200);
  const [metric] = asked.body.sources;
  assert.equal(metric.metric, notePath);
  assert.ok(metric.line.startsWith("Last synced: "), metric.line);
  assert.equal(metric.synced.at, NOW);
});

/* ----- the sync line on a read of the about.md ----- */

const SOURCE_PATH = "data/status/about.md";
/** A `toolReadNote` result for `path`: its header and text, and the `opened` the read carries (non-enumerable). */
function readOf(path, text, opened = {}) {
  const result = { content: [{ type: "text", text: `etag: e\npath: ${path}\nvisibility: team\n\n${text}` }] };
  return Object.defineProperty(result, "opened", { value: { path, text, encrypted: false, noteId: noteId(1, "pAlice"), ...opened }, enumerable: false });
}

test("a read of a url source's about.md carries its sync line in the header; nothing else in the read changes", { skip }, async () => {
  const w = await world();
  assert.equal((await arm(w, w.alice)).status, 200);
  const store = { dataSyncStub: dataSyncStubFor(w.env), actor: { workspaceId: "pAlice" } };
  const read = readOf(SOURCE_PATH, ABOUT(GOOD_URL));
  const shown = await withSyncLine(read, store);
  assert.equal(
    shown.content[0].text,
    `etag: e\npath: ${SOURCE_PATH}\nvisibility: team\nsync: Last synced: ${AT} · 2 rows\n\n${ABOUT(GOOD_URL)}`,
  );
  assert.equal(shown.content.length, 1);
  assert.equal(shown.opened, read.opened, "the opened note travels with the read");
  assert.equal(Object.keys(shown).includes("opened"), false, "and stays out of what the client sees");
  // The about.md is never written: the status is on the read only, and the sync object was asked for it alone.
  assert.equal(w.data.objects.size, 1);
});

test("a batch read carries each data source's sync line, and an ordinary note gets none", { skip }, async () => {
  const w = await world();
  assert.equal((await arm(w, w.alice)).status, 200);
  const notes = { "data/status/about.md": ABOUT(GOOD_URL), "data/other/about.md": ABOUT("https://other.example.com/x.json"), "notes/plain.md": "Just a note.\n" };
  const ids = { "data/status/about.md": noteId(1, "pAlice"), "data/other/about.md": noteId(2, "pAlice"), "notes/plain.md": noteId(3, "pAlice") };
  const store = {
    async get(key) { const t = notes[key]; return t === undefined ? null : { key, etag: "e1", size: t.length, text: async () => t, httpMetadata: {} }; },
    async head(key) { const t = notes[key]; return t === undefined ? null : { key, etag: "e1", size: t.length }; },
    async noteIdAt(path) { return ids[path] ?? null; },
    dataSyncStub: dataSyncStubFor(w.env),
    actor: { workspaceId: "pAlice" },
  };
  const out = await toolReadNotes(store, "private", [], new PrivacyOverrides(), Object.keys(notes));
  assert.equal(out.content.length, 3);
  assert.notEqual(out.isError, true);
  const [armed, other, plain] = out.content.map((part) => part.text);
  assert.ok(armed.includes(`\nsync: Last synced: ${AT} · 2 rows\n`), armed);
  assert.match(other, /\nsync: Not syncing: /);
  assert.equal(plain, "etag: e1\npath: notes/plain.md\nvisibility: private\n\nJust a note.\n");
});

test("a read that is not a data source's about.md is returned unchanged", { skip }, async () => {
  const w = await world();
  assert.equal((await arm(w, w.alice)).status, 200);
  const store = { dataSyncStub: dataSyncStubFor(w.env), actor: { workspaceId: "pAlice" } };
  const ask = async (path, text, opened) => {
    const read = readOf(path, text, opened);
    return { read, out: await withSyncLine(read, store) };
  };
  // Another file name, a source's sheet, a note in the same folder that says source: url: none of them is the about.md.
  const elsewhere = await ask("data/status/incidents.md", ABOUT(GOOD_URL));
  assert.strictEqual(elsewhere.out, elsewhere.read);
  // A source whose about.md says it is a push (not one the sync keeps).
  const push = await ask(SOURCE_PATH, "---\nsource: push\n---\n");
  assert.strictEqual(push.out, push.read);
  // No note id, or one that is not a note id.
  const bad = await ask(SOURCE_PATH, ABOUT(GOOD_URL), { noteId: "not-an-id" });
  assert.strictEqual(bad.out, bad.read);
  // Encrypted: its text is not what the reader sees, and the sync object is not asked.
  const sealed = await ask(SOURCE_PATH, ABOUT(GOOD_URL), { encrypted: true });
  assert.strictEqual(sealed.out, sealed.read);
  // A failed read.
  const failed = readOf(SOURCE_PATH, ABOUT(GOOD_URL));
  Object.assign(failed, { isError: true });
  assert.strictEqual(await withSyncLine(failed, store), failed);
  assert.equal(w.data.objects.size, 1, "only Alice's sync object was ever asked, and only for her reads");
});

test("a read addressed to another workspace is answered by that workspace's sync object, never by this one's", { skip }, async () => {
  const w = await world();
  assert.equal((await arm(w, w.alice)).status, 200);
  // The read is of Alice's about.md, but its context's store names Bob's workspace: Bob's object knows nothing of it.
  const store = { dataSyncStub: dataSyncStubFor(w.env), actor: { workspaceId: "pBob" } };
  const shown = await withSyncLine(readOf(SOURCE_PATH, ABOUT(GOOD_URL)), store);
  assert.match(shown.content[0].text, /\nsync: Not syncing: /);
  assert.equal(shown.content[0].text.includes("Last synced"), false);
  assert.ok(dataObject(w, "pBob"), "Bob's own object answered");
});

test("with no sync binding, or no workspace, the read is returned unchanged", { skip }, async () => {
  const read = readOf(SOURCE_PATH, ABOUT(GOOD_URL));
  // A self-host deployment without the DATA_SYNC binding.
  const bare = { dataSyncStub: dataSyncStubFor({}), actor: { workspaceId: "pAlice" } };
  assert.strictEqual(await withSyncLine(read, bare), read);
  // A store that never had the sync stub laid on it at all.
  assert.strictEqual(await withSyncLine(read, { actor: { workspaceId: "pAlice" } }), read);
  // A workspace id that is not one a workspace has: refused before any object is named.
  const w = await world();
  const badId = { dataSyncStub: dataSyncStubFor(w.env), actor: { workspaceId: "a/b" } };
  assert.strictEqual(await withSyncLine(read, badId), read);
  assert.equal(w.data.objects.size, 0);
});

test("a sync object that never answers leaves the read unchanged, after the wait, and the wait is 2 seconds", { skip }, async () => {
  assert.equal(SYNC_LINE_WAIT_MS, 2000);
  const w = await world();
  assert.equal((await arm(w, w.alice)).status, 200);
  // A stub whose status call never resolves (the object is hung): the read must not wait on it.
  const hung = { fetch: () => new Promise(() => {}) };
  const store = { dataSyncStub: () => hung, actor: { workspaceId: "pAlice" } };
  const read = readOf(SOURCE_PATH, ABOUT(GOOD_URL));
  const started = Date.now();
  const shown = await withSyncLine(read, store, { waitMs: 20 });
  assert.strictEqual(shown, read, "the read is returned as it was");
  assert.ok(Date.now() - started < 1000, "it did not wait on the object");
});
