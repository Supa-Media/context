// A listing through the logical-delete view reads the markers it must tell from live objects a few at a time
// (`src/store/logicalDelete.js` `list`), and answers, charges and fails exactly as it did reading them in turn.
import test from "node:test";
import assert from "node:assert/strict";
import { withLogicalDelete } from "../src/store/logicalDelete.js";

/** A bucket: conditional writes and creates, no conditional delete, so a delete through the view leaves a marker. */
class RawStore {
  constructor() {
    this.objects = new Map();
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
    this.counter = 0;
  }

  seed(key, text, contentType = "text/markdown; charset=utf-8") {
    this.objects.set(key, { body: new TextEncoder().encode(text), etag: `e${++this.counter}`, contentType });
  }

  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    const body = item.body.slice();
    return { etag: item.etag, contentType: item.contentType, arrayBuffer: () => body.slice().buffer, text: async () => new TextDecoder().decode(body) };
  }

  async head(key) {
    const item = this.objects.get(key);
    return item ? { etag: item.etag, size: item.body.byteLength, contentType: item.contentType } : null;
  }

  async put(key, value, options = {}) {
    const current = this.objects.get(key);
    if (options.onlyIf?.absent === true && current) return null;
    if (options.onlyIf?.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const item = { body: bytes.slice(), etag: `e${++this.counter}`, contentType: options.contentType || "text/markdown; charset=utf-8" };
    this.objects.set(key, item);
    return { etag: item.etag };
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async list({ prefix = "" } = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    return { objects: keys.map((key) => ({ key, etag: this.objects.get(key).etag, size: this.objects.get(key).body.byteLength })), truncated: false };
  }
}

/*
 * A LISTING READS ITS DELETION MARKERS TOGETHER, NOT ONE AFTER ANOTHER.
 *
 * A marker is never physically deleted, and a listing tells one from a live object of the same size by reading it.
 * Read one at a time, a folder whose objects come and go costs one bucket round trip per object it ever held:
 * `.context/approvals/pending/` in a person's bucket took a median 3.1 s to list (production `tex_entry`
 * `store:list:bucket`, 2026-11-18), and a texted turn that holds an email for a yes lists it five times.
 */

/** A raw store whose reads can be held open, so a test sees how many are in flight together. */
class GatedStore extends RawStore {
  constructor() {
    super();
    this.inFlight = 0;
    this.most = 0;
    this.started = [];
    this.waiting = [];
    this.gated = false;
    this.failOn = new Map();
  }

  async get(key) {
    if (!this.gated) return super.get(key);
    this.started.push(key);
    this.inFlight += 1;
    this.most = Math.max(this.most, this.inFlight);
    await new Promise((resolve) => this.waiting.push(resolve));
    this.inFlight -= 1;
    if (this.failOn.has(key)) throw new Error(this.failOn.get(key));
    return super.get(key);
  }

  /** Let every read now waiting finish, and those they let start, until none is left: how many rounds it took. */
  async drain() {
    let rounds = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.waiting.length === 0) return rounds;
      rounds += 1;
      for (const release of this.waiting.splice(0)) release();
    }
  }
}

/** `count` objects under `asks/`, every third still live, the rest deleted through the wrapper. */
async function comeAndGone(count) {
  const raw = new GatedStore();
  const store = withLogicalDelete(raw);
  const live = [];
  for (let n = 0; n < count; n += 1) {
    const key = `asks/${String(n).padStart(3, "0")}.json`;
    raw.seed(key, JSON.stringify({ id: n }), "application/json");
    if (n % 3 === 0) live.push(key);
    else await store.delete(key);
  }
  // A live object the size of a marker is read too, and kept.
  const sameSize = "asks/same-size.json";
  raw.seed(sameSize, "x".repeat(raw.objects.get("asks/001.json").body.byteLength), "application/json");
  live.push(sameSize);
  return { raw, store, live, markers: count - Math.ceil(count / 3) };
}

test("a listing reads its markers a few at a time and answers exactly what reading them in turn did", async () => {
  const { raw, store, live, markers } = await comeAndGone(40);
  const expected = (await store.list({ prefix: "asks/" })).objects.map(({ key }) => key);
  assert.deepEqual(expected, live, "the listing hides every marker and keeps every live object, in order");

  raw.gated = true;
  const listing = store.list({ prefix: "asks/" });
  const rounds = await raw.drain();
  const page = await listing;
  assert.deepEqual(page.objects.map(({ key }) => key), live);
  assert.equal(page.resumeAfter, "asks/same-size.json");
  // Every marker and the one same-size object is read once: no more reads than before.
  assert.equal(raw.started.length, markers + 1);
  assert.deepEqual(raw.started, [...raw.started].sort(), "reads start in listing order");
  assert.ok(raw.most > 1, "the markers were read one after another");
  assert.ok(raw.most <= 6, `${raw.most} reads were open at once: a Worker holds six connections`);
  assert.ok(rounds <= Math.ceil((markers + 1) / 6) + 1, `${markers + 1} reads took ${rounds} rounds`);
});

test("a listing's extra reads are charged once each, in order, and a refused charge stops the listing there", async () => {
  const { raw, store, markers } = await comeAndGone(20);
  let charges = 0;
  store.setExtraOperationCharge(() => {
    charges += 1;
  });
  await store.list({ prefix: "asks/" });
  assert.equal(charges, markers + 1, "one charge per read after the listing itself");

  charges = 0;
  raw.gated = true;
  store.setExtraOperationCharge(() => {
    charges += 1;
    if (charges === 4) throw new Error("out of budget");
  });
  const refused = assert.rejects(() => store.list({ prefix: "asks/" }), /out of budget/);
  await raw.drain();
  await refused;
  assert.equal(charges, 4, "reads went on being charged after one was refused");
  assert.equal(raw.started.length, 3, "a read was started after its charge was refused");
});

test("a listing whose reads fail answers the failure reading them in turn would have met first", async () => {
  const { raw, store } = await comeAndGone(20);
  raw.gated = true;
  raw.failOn.set("asks/007.json", "seventh is unreadable");
  raw.failOn.set("asks/002.json", "second is unreadable");
  const failed = assert.rejects(() => store.list({ prefix: "asks/" }), /second is unreadable/);
  await raw.drain();
  await failed;
  // Nothing new is started once one has failed.
  assert.ok(raw.started.length <= 12, `${raw.started.length} reads were started`);
});
