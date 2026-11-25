/**
 * Cloudflare, connected by an owner with a read-only token (`src/data/connect/`, `src/data/sync/runApp.js`, the
 * `connect` and `disconnect` ops of `POST /files/data-sync`), end to end through the worker over real workspace
 * objects in memory, with Cloudflare's API answered by host.
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. `mayConnect` letting editors connect: "an editor, a member and an AI client cannot connect, and no object hears" fails.
 * 2. `runAppSource` skipping the `source:` check: "an about.md edited to name something else stops the source, and
 *    the token goes nowhere" fails.
 * 3. The seal's additional data without the app: "a sealed key opens only for its own workspace and app" fails.
 * 4. `checkCloudflareToken` skipping its shape check: "a key that isn't a token is refused before Cloudflare is
 *    asked, and nothing is kept" fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSheet } from "../src/sheets/csv.js";
import { SYNC_EVERY_MS } from "../src/data/sync/object.js";
import { ConnectionSealRefused, openConnection, sealConnection } from "../src/data/connect/seal.js";
import { cloudflareRow } from "../src/data/connect/cloudflare.js";
import { skip, noteId, NOW, SECRET, world, send, dataObject, roleOf } from "./dataSyncWorld.mjs";

const TOKEN = "cf".repeat(20);
const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "b".repeat(32);
const ABOUT_APP = (app) => `---\nsource: ${app}\nname: "${app}"\n---\n\nConnected by an owner.\n`;
const ABOUT = "data/cloudflare/about.md";

/** A cloudflare/ source folder with its about.md and its empty dataset sheet. */
async function withApp(w, who) {
  const ids = { about: noteId(32, who.pwid), spend: noteId(33, who.pwid) };
  who.object.store.rows.put([
    { id: `d-cf-${who.pwid}`, path: "data/cloudflare", kind: "folder", at: 10 },
    { id: `f-cf-${who.pwid}`, path: ABOUT, kind: "file", at: 13, storageKey: `notes/${ids.about}.md`, noteId: ids.about, etag: "e-c" },
    { id: `f-spend-${who.pwid}`, path: "data/cloudflare/ai-spend.csv", kind: "file", at: 14, storageKey: `files/${ids.spend}.csv`, noteId: ids.spend, etag: "e-p" },
  ]);
  await who.object.store.objects.put(`notes/${ids.about}.md`, ABOUT_APP("cloudflare"));
  await who.bucket.put(`files/${ids.spend}.csv`, "");
  return ids;
}

const group = (date, cost, count) => ({ count, sum: { cost, tokensIn: count * 10, tokensOut: count * 5 }, dimensions: { date, gateway: "context", provider: "anthropic", model: "claude-haiku-5-5" } });

/** Cloudflare as it answers, recording every call's address and the token it carried. */
function cloudflare(w, { accounts = [ACCOUNT_A], status = 200, groups } = {}) {
  const seen = [];
  const keyOf = (init) => String(new Headers(init?.headers ?? {}).get("authorization") ?? "");
  const answer = groups ?? [group("2026-11-24", 0.25, 2), group("2026-11-25", 1.5, 10)];
  w.net.answers.set("api.cloudflare.com", (url, init) => {
    seen.push({ url, key: keyOf(init) });
    if (keyOf(init) !== `Bearer ${TOKEN}` || status !== 200) return Response.json({ success: false }, { status: status === 200 ? 403 : status });
    const path = new URL(url).pathname;
    if (path.endsWith("/user/tokens/verify")) return Response.json({ result: { status: "active" } });
    if (path.endsWith("/accounts")) return Response.json({ result: accounts.map((id) => ({ id })) });
    if (path.endsWith("/graphql")) {
      const { variables } = JSON.parse(init.body);
      if (variables.account !== ACCOUNT_A) return Response.json({ data: null, errors: [{ message: "not authorized" }] });
      return Response.json({ data: { viewer: { accounts: [{ aiGatewayRequestsAdaptiveGroups: answer }] } } });
    }
    return new Response("nope", { status: 404 });
  });
  return seen;
}

const connect = (w, who, key = TOKEN, extra = {}, options) => send(w, who, { workspaceId: who.pwid, op: "connect", about: ABOUT, key, ...extra }, options);
const sheet = async (who, id) => parseSheet((await (await who.bucket.get(`files/${id}.csv`))?.text()) ?? "");
const sourceOf = (w, ids) => dataObject(w, "pAlice").storage.map.get("sources")[ids.about];

/** Every console line while `work` runs, so a test can say the token never reached a log. */
async function logsOf(work) {
  const lines = [];
  const was = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...parts) => lines.push(parts.join(" "));
  try {
    return { result: await work(), lines };
  } finally {
    Object.assign(console, was);
  }
}

test("an analytics group becomes a row keyed by its day, gateway, provider and model", () => {
  assert.deepEqual(cloudflareRow(group("2026-11-25", 1.5, 10)), {
    id: "2026-11-25 context anthropic claude-haiku-5-5",
    date: "2026-11-25",
    gateway: "context",
    provider: "anthropic",
    model: "claude-haiku-5-5",
    requests: "10",
    tokens_in: "100",
    tokens_out: "50",
    usd: "1.5",
  });
  assert.equal(cloudflareRow({ dimensions: { date: "nope" } }), null);
});

test("a sealed key opens only for its own workspace and app", async () => {
  const sealed = await sealConnection({ key: TOKEN }, { secret: SECRET, workspaceId: "pAlice", app: "cloudflare" });
  assert.equal(sealed.includes(TOKEN), false);
  assert.deepEqual(await openConnection(sealed, { secret: SECRET, workspaceId: "pAlice", app: "cloudflare" }), { key: TOKEN });
  await assert.rejects(openConnection(sealed, { secret: SECRET, workspaceId: "pAlice", app: "github" }), ConnectionSealRefused);
  await assert.rejects(openConnection(sealed, { secret: SECRET, workspaceId: "pBob", app: "cloudflare" }), ConnectionSealRefused);
  await assert.rejects(openConnection(sealed, { secret: `${SECRET}-rotated`, workspaceId: "pAlice", app: "cloudflare" }), ConnectionSealRefused);
});

test("an owner connects Cloudflare: the token is checked, kept sealed, never answered or logged, and AI spend lands in its sheet", { skip }, async () => {
  const w = await world();
  const ids = await withApp(w, w.alice);
  const seen = cloudflare(w);
  const { result: done, lines } = await logsOf(() => connect(w, w.alice));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.armed, true);
  assert.equal(done.body.last.outcome, "ok");
  assert.equal(JSON.stringify(done.body).includes(TOKEN), false);
  assert.equal(lines.some((line) => line.includes(TOKEN)), false, "the token reached a log");
  const rows = (await sheet(w.alice, ids.spend)).rows;
  assert.deepEqual(rows.map((row) => [row.date, row.model, row.usd, row.requests]), [["2026-11-24", "claude-haiku-5-5", "0.25", "2"], ["2026-11-25", "claude-haiku-5-5", "1.5", "10"]]);
  // Kept sealed in the sync object, with the account it reads, and nowhere in the bucket.
  const object = dataObject(w, "pAlice");
  assert.equal(typeof object.storage.map.get("connections").cloudflare.sealed, "string");
  assert.equal(JSON.stringify([...object.storage.map.values()]).includes(TOKEN), false);
  for (const [key, value] of w.alice.bucket.objects) assert.equal(String(value.body ?? "").includes(TOKEN), false, key);
  assert.equal(object.storage.alarm, NOW + SYNC_EVERY_MS);
  // Every call went to Cloudflare's own API, carrying the token.
  assert.ok(seen.every((call) => call.key === `Bearer ${TOKEN}`));
  assert.ok(w.net.calls.every((url) => new URL(url).hostname === "api.cloudflare.com"));
});

test("a key that isn't a token is refused before Cloudflare is asked, and nothing is kept", { skip }, async () => {
  const w = await world();
  await withApp(w, w.alice);
  const seen = cloudflare(w);
  const done = await connect(w, w.alice, "not a token!");
  assert.equal(done.status, 400);
  assert.match(done.body.message, /isn't a Cloudflare API token/);
  assert.equal(seen.length, 0);
  assert.equal(dataObject(w, "pAlice").storage.map.get("connections"), undefined);
  assert.equal(dataObject(w, "pAlice").storage.map.get("sources"), undefined);
  // A token Cloudflare refuses is not kept either.
  const refused = await connect(w, w.alice, "x".repeat(40));
  assert.equal(refused.status, 400);
  assert.equal(dataObject(w, "pAlice").storage.map.get("connections"), undefined);
});

test("an editor, a member and an AI client cannot connect, and no object hears", { skip }, async () => {
  const w = await world();
  await withApp(w, w.alice);
  const seen = cloudflare(w);
  for (const role of ["editor", "member"]) {
    await roleOf(w, w.alice, role);
    assert.equal((await connect(w, w.alice)).status, 403, role);
  }
  await roleOf(w, w.alice, "owner");
  assert.equal((await connect(w, w.alice, TOKEN, {}, { token: w.alice.aiToken })).status, 403);
  assert.equal((await send(w, w.alice, { workspaceId: w.alice.pwid, op: "disconnect", app: "cloudflare" }, { token: w.alice.aiToken })).status, 403);
  assert.equal(w.data.objects.size, 0);
  assert.equal(seen.length, 0);
});

test("a body with anything else, or a source that isn't an app's, is refused", { skip }, async () => {
  const w = await world();
  await withApp(w, w.alice);
  cloudflare(w);
  assert.equal((await connect(w, w.alice, TOKEN, { url: "https://evil.example" })).status, 400);
  assert.equal((await send(w, w.alice, { workspaceId: w.alice.pwid, op: "disconnect", app: "github-ish" })).status, 400);
  const url = await send(w, w.alice, { workspaceId: w.alice.pwid, op: "connect", about: "data/status/about.md", key: TOKEN });
  assert.equal(url.status, 400);
  assert.equal(url.body.error, "not_an_app_source");
  assert.equal((await send(w, w.alice, { workspaceId: w.alice.pwid, op: "connect", about: "data/nowhere/about.md", key: TOKEN })).status, 404);
  // An app's source is never armed without its key.
  assert.equal((await send(w, w.alice, { workspaceId: w.alice.pwid, op: "arm", about: ABOUT })).status, 400);
});

test("an about.md edited to name something else stops the source, and the token goes nowhere", { skip }, async () => {
  const w = await world();
  const ids = await withApp(w, w.alice);
  cloudflare(w);
  assert.equal((await connect(w, w.alice)).body.armed, true);
  await w.alice.object.store.objects.put(`notes/${ids.about}.md`, `---\nsource: url\nurl: https://status.example.com/incidents.json\ndataset: ai-spend\n---\n`);
  const before = w.net.calls.length;
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  const source = sourceOf(w, ids);
  assert.equal(source.stopped, true);
  assert.match(source.last.said, /no longer says source: cloudflare/);
  assert.equal(w.net.calls.length, before, "nothing was asked of anyone");
});

test("an owner who is now an editor stops the source; a refused token stops it too", { skip }, async () => {
  const w = await world();
  const ids = await withApp(w, w.alice);
  cloudflare(w);
  assert.equal((await connect(w, w.alice)).body.armed, true);
  await roleOf(w, w.alice, "editor");
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  assert.match(sourceOf(w, ids).last.said, /no longer an owner/);

  const v = await world();
  const vids = await withApp(v, v.alice);
  cloudflare(v);
  assert.equal((await connect(v, v.alice)).body.armed, true);
  cloudflare(v, { status: 403 });
  v.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(v, "pAlice").instance.alarm();
  const source = sourceOf(v, vids);
  assert.equal(source.stopped, true);
  assert.match(source.last.said, /Cloudflare refused/);
});

test("disconnect forgets the token and stops the source; the next hour asks Cloudflare nothing", { skip }, async () => {
  const w = await world();
  const ids = await withApp(w, w.alice);
  const seen = cloudflare(w);
  await connect(w, w.alice);
  const done = await send(w, w.alice, { workspaceId: w.alice.pwid, op: "disconnect", app: "cloudflare" });
  assert.equal(done.status, 200);
  assert.equal(done.body.disconnected, true);
  const object = dataObject(w, "pAlice");
  assert.equal(object.storage.map.get("connections").cloudflare, undefined);
  assert.equal(sourceOf(w, ids).stopped, true);
  assert.equal(object.storage.alarm, null);
  const before = seen.length;
  w.clock.now = NOW + SYNC_EVERY_MS;
  await object.instance.alarm();
  assert.equal(seen.length, before);
});

test("a token reaching several accounts needs one named, and a day's spend updates in place", { skip }, async () => {
  const w = await world();
  const ids = await withApp(w, w.alice);
  cloudflare(w, { accounts: [ACCOUNT_A, ACCOUNT_B] });
  const unnamed = await connect(w, w.alice);
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.body.message, /2 accounts/);
  assert.equal((await connect(w, w.alice, TOKEN, { account: "c".repeat(32) })).status, 400);
  assert.equal((await connect(w, w.alice, TOKEN, { account: ACCOUNT_A })).status, 200);
  assert.equal((await sheet(w.alice, ids.spend)).rows.length, 2);
  // The day goes on: the same day's row is changed, never added twice.
  cloudflare(w, { accounts: [ACCOUNT_A, ACCOUNT_B], groups: [group("2026-11-24", 0.25, 2), group("2026-11-25", 2.75, 19)] });
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  const rows = (await sheet(w.alice, ids.spend)).rows;
  assert.deepEqual(rows.map((row) => [row.date, row.usd]), [["2026-11-24", "0.25"], ["2026-11-25", "2.75"]]);
});
