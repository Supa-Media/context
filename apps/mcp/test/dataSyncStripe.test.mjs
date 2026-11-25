/**
 * Stripe, connected by an owner with a read-only restricted key (`src/data/connect/stripe.js`, through the same
 * `connect` and `disconnect` ops and hourly run as Cloudflare in `dataSyncApps.test.mjs`), end to end through the
 * worker over real workspace objects in memory, with Stripe's and Cloudflare's APIs answered by host. The word
 * passes the exit guard only in `src/data/connect/` (decided by the owner, 2026-11-25).
 *
 * Sabotage record (temporary local edits, reverted; the named case failed each time):
 * 1. `checkStripeKey` taking any key that starts `sk_` or `rk_`: "a secret key is refused before Stripe is asked,
 *    and nothing is kept" fails.
 * 2. `runAppSource` skipping the `source:` check: "an about.md edited to name another app stops the source, and the
 *    key never reaches that app" fails.
 * 3. `readStripe` reading only the recent window: "Stripe reads the new rows and then the missing history, each run
 *    carrying it further back" fails.
 * 4. `stripeRow` keeping the description: "a Stripe balance transaction becomes a revenue row…" fails.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSheet } from "../src/sheets/csv.js";
import { SYNC_EVERY_MS } from "../src/data/sync/object.js";
import { stripeRow } from "../src/data/connect/stripe.js";
import { skip, noteId, NOW, world, send, dataObject, roleOf } from "./dataSyncWorld.mjs";

const STRIPE_KEY = `rk_test_${"A1b2".repeat(6)}`;
const CF_TOKEN = "cf".repeat(20);
const ACCOUNT_A = "a".repeat(32);
const ABOUT_APP = (app) => `---\nsource: ${app}\nname: "${app}"\n---\n\nConnected by an owner.\n`;


/** A stripe/ and a cloudflare/ source folder, each with its about.md and its empty dataset sheet. */
async function withApps(w, who) {
  const ids = { stripe: noteId(30, who.pwid), revenue: noteId(31, who.pwid), cloudflare: noteId(32, who.pwid), spend: noteId(33, who.pwid) };
  who.object.store.rows.put([
    { id: `d-stripe-${who.pwid}`, path: "data/stripe", kind: "folder", at: 10 },
    { id: `f-stripe-${who.pwid}`, path: "data/stripe/about.md", kind: "file", at: 11, storageKey: `notes/${ids.stripe}.md`, noteId: ids.stripe, etag: "e-s" },
    { id: `f-revenue-${who.pwid}`, path: "data/stripe/revenue.csv", kind: "file", at: 12, storageKey: `files/${ids.revenue}.csv`, noteId: ids.revenue, etag: "e-r" },
    { id: `d-cf-${who.pwid}`, path: "data/cloudflare", kind: "folder", at: 10 },
    { id: `f-cf-${who.pwid}`, path: "data/cloudflare/about.md", kind: "file", at: 13, storageKey: `notes/${ids.cloudflare}.md`, noteId: ids.cloudflare, etag: "e-c" },
    { id: `f-spend-${who.pwid}`, path: "data/cloudflare/ai-spend.csv", kind: "file", at: 14, storageKey: `files/${ids.spend}.csv`, noteId: ids.spend, etag: "e-p" },
  ]);
  await who.object.store.objects.put(`notes/${ids.stripe}.md`, ABOUT_APP("stripe"));
  await who.object.store.objects.put(`notes/${ids.cloudflare}.md`, ABOUT_APP("cloudflare"));
  await who.bucket.put(`files/${ids.revenue}.csv`, "");
  await who.bucket.put(`files/${ids.spend}.csv`, "");
  return ids;
}

const txn = (id, at, category, amount, currency = "usd") => ({ id, created: Math.floor(Date.parse(at) / 1000), reporting_category: category, currency, amount, fee: Math.round(amount * 0.03), net: amount - Math.round(amount * 0.03), description: "Jane Doe's order" });

/** Stripe and Cloudflare as they answer, recording every call's address and the key it carried. */
function apps(w, { accounts = [ACCOUNT_A], stripeStatus = 200, stripeData } = {}) {
  const seen = [];
  const keyOf = (init) => String(new Headers(init?.headers ?? {}).get("authorization") ?? "");
  const data = stripeData ?? [txn("txn_3", "2026-11-25T10:00:00Z", "charge", 4900), txn("txn_2", "2026-11-24T10:00:00Z", "payout", -10000), txn("txn_1", "2026-11-20T10:00:00Z", "charge", 1200, "jpy")];
  w.net.answers.set("api.stripe.com", (url, init) => {
    seen.push({ host: "stripe", url, key: keyOf(init) });
    if (keyOf(init) !== `Bearer ${STRIPE_KEY}` || stripeStatus !== 200) return Response.json({ error: { message: "no" } }, { status: stripeStatus === 200 ? 401 : stripeStatus });
    return Response.json({ data, has_more: false });
  });
  w.net.answers.set("api.cloudflare.com", (url, init) => {
    seen.push({ host: "cloudflare", url, key: keyOf(init) });
    if (keyOf(init) !== `Bearer ${CF_TOKEN}`) return Response.json({ success: false }, { status: 403 });
    const path = new URL(url).pathname;
    if (path.endsWith("/user/tokens/verify")) return Response.json({ result: { status: "active" } });
    if (path.endsWith("/accounts")) return Response.json({ result: accounts.map((id) => ({ id })) });
    if (path.endsWith("/graphql")) {
      const { variables } = JSON.parse(init.body);
      if (variables.account !== ACCOUNT_A) return Response.json({ data: null, errors: [{ message: "not authorized" }] });
      return Response.json({ data: { viewer: { accounts: [{ aiGatewayRequestsAdaptiveGroups: [
        { count: 10, sum: { cost: 1.5, tokensIn: 100, tokensOut: 50 }, dimensions: { date: "2026-11-25", gateway: "context", provider: "anthropic", model: "claude-haiku-5-5" } },
        { count: 2, sum: { cost: 0.25, tokensIn: 10, tokensOut: 5 }, dimensions: { date: "2026-11-24", gateway: "context", provider: "anthropic", model: "claude-haiku-5-5" } },
      ] }] } } });
    }
    return new Response("nope", { status: 404 });
  });
  return seen;
}

const connect = (w, who, about, key, extra = {}, options) => send(w, who, { workspaceId: who.pwid, op: "connect", about, key, ...extra }, options);
const sheet = async (who, id) => parseSheet((await (await who.bucket.get(`files/${id}.csv`))?.text()) ?? "");

/** Every console line while `work` runs, so a test can say the key never reached a log. */
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

test("a Stripe balance transaction becomes a revenue row in the currency's main unit, and a payout none", () => {
  assert.deepEqual(stripeRow(txn("txn_1", "2026-11-25T10:00:00Z", "charge", 4900)), { id: "txn_1", date: "2026-11-25T10:00:00Z", category: "charge", currency: "usd", amount: "49", fee: "1.47", net: "47.53", usd: "49" });
  assert.equal(stripeRow(txn("txn_2", "2026-11-25T10:00:00Z", "charge", 1200, "jpy")).amount, "1200");
  assert.equal(stripeRow(txn("txn_2", "2026-11-25T10:00:00Z", "charge", 1200, "jpy")).usd, "");
  assert.equal(stripeRow(txn("txn_3", "2026-11-25T10:00:00Z", "payout", -100)), null);
  assert.equal(Object.hasOwn(stripeRow(txn("txn_1", "2026-11-25T10:00:00Z", "charge", 1)), "description"), false, "a description can name a customer");
});

test("an owner connects Stripe: the key is checked, kept sealed, never answered or logged, and revenue lands in its sheet", { skip }, async () => {
  const w = await world();
  const ids = await withApps(w, w.alice);
  const seen = apps(w);
  const { result: done, lines } = await logsOf(() => connect(w, w.alice, "data/stripe/about.md", STRIPE_KEY));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.armed, true);
  assert.equal(done.body.last.outcome, "ok");
  assert.equal(JSON.stringify(done.body).includes(STRIPE_KEY), false);
  assert.equal(lines.some((line) => line.includes(STRIPE_KEY)), false, "the key reached a log");
  const rows = (await sheet(w.alice, ids.revenue)).rows;
  assert.deepEqual(rows.map((row) => [row.id, row.currency, row.amount]), [["txn_1", "jpy", "1200"], ["txn_3", "usd", "49"]]);
  // Kept sealed in the sync object, and nowhere in the bucket.
  const object = dataObject(w, "pAlice");
  const kept = object.storage.map.get("connections");
  assert.equal(typeof kept.stripe.sealed, "string");
  assert.equal(JSON.stringify([...object.storage.map.values()]).includes(STRIPE_KEY), false);
  for (const [key, value] of w.alice.bucket.objects) assert.equal(String(value.body ?? "").includes(STRIPE_KEY), false, key);
  assert.ok(seen.every((call) => call.host === "stripe"));
  assert.equal(object.storage.alarm, NOW + SYNC_EVERY_MS);
});

test("a secret key is refused before Stripe is asked, and nothing is kept", { skip }, async () => {
  const w = await world();
  await withApps(w, w.alice);
  const seen = apps(w);
  const done = await connect(w, w.alice, "data/stripe/about.md", `sk_live_${"x".repeat(24)}`);
  assert.equal(done.status, 400);
  assert.match(done.body.message, /secret key/);
  assert.equal(seen.length, 0);
  assert.equal(dataObject(w, "pAlice").storage.map.get("connections"), undefined);
  assert.equal(dataObject(w, "pAlice").storage.map.get("sources"), undefined);
});

test("an about.md edited to name another app stops the source, and the key never reaches that app", { skip }, async () => {
  const w = await world();
  const ids = await withApps(w, w.alice);
  const seen = apps(w);
  assert.equal((await connect(w, w.alice, "data/stripe/about.md", STRIPE_KEY)).body.armed, true);
  await w.alice.object.store.objects.put(`notes/${ids.stripe}.md`, ABOUT_APP("cloudflare"));
  const before = seen.length;
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  const source = dataObject(w, "pAlice").storage.map.get("sources")[ids.stripe];
  assert.equal(source.stopped, true);
  assert.match(source.last.said, /no longer says source: stripe/);
  assert.equal(seen.length, before, "nothing was asked of any app");
  assert.equal(seen.some((call) => call.host === "cloudflare"), false);
});

test("an owner who is now an editor stops the source; a refused key stops it too", { skip }, async () => {
  const w = await world();
  const ids = await withApps(w, w.alice);
  apps(w);
  assert.equal((await connect(w, w.alice, "data/stripe/about.md", STRIPE_KEY)).body.armed, true);
  await roleOf(w, w.alice, "editor");
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  assert.match(dataObject(w, "pAlice").storage.map.get("sources")[ids.stripe].last.said, /no longer an owner/);

  const v = await world();
  const vids = await withApps(v, v.alice);
  apps(v);
  assert.equal((await connect(v, v.alice, "data/stripe/about.md", STRIPE_KEY)).body.armed, true);
  apps(v, { stripeStatus: 401 });
  v.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(v, "pAlice").instance.alarm();
  const source = dataObject(v, "pAlice").storage.map.get("sources")[vids.stripe];
  assert.equal(source.stopped, true);
  assert.match(source.last.said, /Stripe refused the key/);
});

test("disconnect forgets the key and stops the source; the next hour asks Stripe nothing", { skip }, async () => {
  const w = await world();
  const ids = await withApps(w, w.alice);
  const seen = apps(w);
  await connect(w, w.alice, "data/stripe/about.md", STRIPE_KEY);
  const done = await send(w, w.alice, { workspaceId: w.alice.pwid, op: "disconnect", app: "stripe" });
  assert.equal(done.status, 200);
  assert.equal(done.body.disconnected, true);
  const object = dataObject(w, "pAlice");
  assert.equal(object.storage.map.get("connections").stripe, undefined);
  assert.equal(object.storage.map.get("sources")[ids.stripe].stopped, true);
  assert.equal(object.storage.alarm, null);
  const before = seen.length;
  w.clock.now = NOW + SYNC_EVERY_MS;
  await object.instance.alarm();
  assert.equal(seen.length, before);
});

test("Stripe reads the new rows and then the missing history, each run carrying it further back", { skip }, async () => {
  const w = await world();
  const ids = await withApps(w, w.alice);
  const seen = apps(w);
  await connect(w, w.alice, "data/stripe/about.md", STRIPE_KEY);
  w.clock.now = NOW + SYNC_EVERY_MS;
  await dataObject(w, "pAlice").instance.alarm();
  const asked = seen.filter((call) => call.url.includes("balance_transactions?") && !call.url.includes("limit=1&")).slice(-2).map((call) => new URL(call.url).searchParams);
  // The recent window starts three days before the newest kept row; the history window ends at the oldest.
  assert.equal(Number(asked[0].get("created[gte]")), Math.floor(Date.parse("2026-11-25T10:00:00Z") / 1000) - 3 * 86_400);
  assert.equal(asked[0].get("created[lt]"), null);
  assert.equal(Number(asked[1].get("created[lt]")), Math.floor(Date.parse("2026-11-20T10:00:00Z") / 1000));
  // A row seen again is the same row.
  assert.equal((await sheet(w.alice, ids.revenue)).rows.length, 2);
});
