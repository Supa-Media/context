/**
 * Tex's sign-ins, kept sealed in the person's vault between browsers
 * (`src/agent/browserJar.js`; decided by the owner, 2026-10-20).
 *
 * Sabotage record (2026-10-20): sealing the jar as plain JSON fails "a bucket
 * read never yields a sign-in"; letting `browseResult` pass `jar` on fails "the
 * jar never reaches the turn"; dropping the personal check fails "only a
 * personal workspace keeps one". 2026-10-22: dropping IndexedDB from the
 * size trim fails "a full jar gives up the IndexedDB…"; merging IndexedDB as
 * the cookies are (the read replaces the jar) fails "…keeps what was held".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { JAR_KEY, MAX_JAR_CHARS, browserJar, mergeJar } from "../src/agent/browserJar.js";
import { resetBrowserbaseProbe, siteShotsComputer } from "../src/agent/browserProviders.js";

const material = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
const KEYS = { current: "k1", keys: { k1: material } };
const COOKIE = "sid-s3cret-value";
const TOKEN = "jwt-very-secret";
const READ = {
  cookies: [{ name: "sid", value: COOKIE, domain: ".app.example", path: "/", secure: true, httpOnly: true }],
  storage: { "https://app.example": { token: TOKEN } },
};

function memoryStore({ kind = "personal", workspaceId = "ws_1", keys = KEYS } = {}) {
  const objects = new Map();
  const store = {
    objects,
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      objects.set(key, String(value));
    },
    actor: { workspaceId, userId: "user_a" },
    contexts: [{ current: true, kind, name: "seyi" }],
  };
  if (keys) Object.defineProperty(store, "encryptionKey", { value: keys, enumerable: false });
  return store;
}

test("a bucket read never yields a sign-in, and the jar opens again from the bucket", async () => {
  const store = memoryStore();
  await browserJar(store).save(READ);
  const raw = store.objects.get(JAR_KEY);
  assert.ok(raw, "the jar is in the vault");
  for (const plain of [COOKIE, TOKEN, "app.example", "sid"]) assert.equal(raw.includes(plain), false, `${plain} is in the bucket`);
  assert.deepEqual(await browserJar(store).load(), READ);
});

test("a jar sealed for one workspace does not open in another", async () => {
  const mine = memoryStore();
  await browserJar(mine).save(READ);
  const theirs = memoryStore({ workspaceId: "ws_2" });
  theirs.objects.set(JAR_KEY, mine.objects.get(JAR_KEY));
  assert.equal(await browserJar(theirs).load(), null);
});

test("only a personal workspace keeps one, and only with a data key", () => {
  assert.equal(browserJar(memoryStore({ kind: "shared" })), null);
  assert.equal(browserJar(memoryStore({ keys: null })), null);
  assert.ok(browserJar(memoryStore()));
});

test("the browser's cookies replace the jar's, and a site that signed out keeps nothing", () => {
  const held = { cookies: [{ name: "old" }], storage: { "https://a.example": { t: "1" }, "https://b.example": { t: "2" } } };
  assert.deepEqual(mergeJar(held, { cookies: [{ name: "new" }], storage: { "https://a.example": {} } }), {
    cookies: [{ name: "new" }],
    storage: { "https://b.example": { t: "2" } },
  });
});

const FIREBASE = [{ name: "firebaseLocalStorageDb", version: 1, stores: [{ name: "firebaseLocalStorage", keyPath: "fbase_key", autoIncrement: false, indexes: [], records: [{ value: { fbase_key: "firebase:authUser", value: { refreshToken: "fb-refresh-s3cret" } } }] }] }];

test("a site's IndexedDB is sealed like its storage, and a site read without it keeps what was held", async () => {
  const store = memoryStore();
  await browserJar(store).save({ ...READ, idb: { "https://fb.example": FIREBASE } });
  const raw = store.objects.get(JAR_KEY);
  for (const plain of ["fb-refresh-s3cret", "firebaseLocalStorageDb", "fb.example"]) assert.equal(raw.includes(plain), false, `${plain} is in the bucket`);
  assert.deepEqual((await browserJar(store).load()).idb, { "https://fb.example": FIREBASE });

  const held = { cookies: [], storage: {}, idb: { "https://fb.example": FIREBASE, "https://other.example": FIREBASE } };
  // Not read this time (another site, or IndexedDB that could not be read): kept.
  assert.deepEqual(mergeJar(held, { cookies: [], storage: {} }).idb, held.idb);
  // Read and empty: that site signed out, so nothing of it is kept.
  assert.deepEqual(mergeJar(held, { cookies: [], storage: {}, idb: { "https://fb.example": [] } }).idb, { "https://other.example": FIREBASE });
  assert.equal("idb" in mergeJar({ cookies: [], storage: {}, idb: { "https://fb.example": FIREBASE } }, { cookies: [], storage: {}, idb: { "https://fb.example": [] } }), false);
});

test("a full jar gives up the IndexedDB read longest ago before any site's storage", async () => {
  const store = memoryStore();
  const jar = browserJar(store);
  const big = "x".repeat(200 * 1024);
  const db = (tag) => [{ name: "d", version: 1, stores: [{ name: "s", keyPath: "id", autoIncrement: false, indexes: [], records: [{ value: { id: tag, big } }] }] }];
  await jar.save({ cookies: [], storage: { "https://keep.example": { t: "small" } } });
  for (let i = 0; i < 12; i++) await jar.save({ cookies: [], storage: {}, idb: { [`https://s${i}.example`]: db(i) } });
  const kept = await browserJar(store).load();
  assert.ok(kept.idb["https://s11.example"], "the newest sign-in is kept");
  assert.equal(kept.idb["https://s0.example"], undefined);
  assert.deepEqual(kept.storage, { "https://keep.example": { t: "small" } });
  assert.ok(store.objects.get(JAR_KEY).length <= MAX_JAR_CHARS);
});

test("the jar goes to the browser and comes back to the vault, and never reaches the turn", async () => {
  resetBrowserbaseProbe();
  const store = memoryStore();
  await browserJar(store).save(READ);
  const sent = [];
  const binding = {
    async fetch(_url, init) {
      const body = JSON.parse(init.body);
      sent.push(body);
      return Response.json({
        session: "bb-1",
        ran: [{ do: "read", ok: true }],
        page: { url: "https://app.example/", title: "App", text: "Signed in", elements: [] },
        jar: { cookies: [{ name: "sid", value: "rotated", domain: ".app.example", path: "/", secure: true, httpOnly: true }], storage: {} },
      });
    },
  };
  const computer = siteShotsComputer({ SITE_SHOTS: binding }, { owner: "a".repeat(64), jar: browserJar(store) });
  const result = await computer.browse(null, [{ do: "read" }]);
  assert.equal(sent[0].keep, true);
  assert.deepEqual(sent[0].jar, READ);
  assert.equal("jar" in result, false);
  assert.equal(JSON.stringify(result).includes("rotated"), false);
  assert.equal((await browserJar(store).load()).cookies[0].value, "rotated");
});

test("a full jar drops the storage of the sites read longest ago, and still takes a new sign-in", async () => {
  const store = memoryStore();
  const jar = browserJar(store);
  const big = "x".repeat(200 * 1024);
  for (let i = 0; i < 12; i++) await jar.save({ cookies: [], storage: { [`https://s${i}.example`]: { t: big } } });
  const kept = await browserJar(store).load();
  assert.ok(kept.storage["https://s11.example"], "the newest sign-in is kept");
  assert.equal(kept.storage["https://s0.example"], undefined);
  assert.ok(store.objects.get(JAR_KEY).length <= MAX_JAR_CHARS);
});

test("without a jar nothing is asked of the browser", async () => {
  resetBrowserbaseProbe();
  const sent = [];
  const binding = {
    async fetch(_url, init) {
      sent.push(JSON.parse(init.body));
      return Response.json({ session: "bb-1", ran: [], page: { url: "https://app.example/", title: "", text: "", elements: [] }, jar: READ });
    },
  };
  const result = await siteShotsComputer({ SITE_SHOTS: binding }, { owner: "a".repeat(64) }).browse(null, [{ do: "read" }]);
  assert.equal(sent[0].keep, undefined);
  assert.equal(JSON.stringify(result).includes(COOKIE), false);
});
