/**
 * Settling what an object-home workspace's object and bucket disagree about
 * (`lib/workspaceObjects/repair.ts`).
 *
 * Both sides are small in-memory stores with etags, conditional writes and
 * upload times, so each case sets exactly which copy is newer. Every value
 * here is fake.
 *
 * Sabotage, each confirmed to fail a case here: class a missing revision the
 * object's state names as an older one (a lost copy is never restored); class
 * every missing key as an erase (a live document's lost state is deleted from
 * the backup instead of restored); delete from the bucket without the etag
 * read (a save meanwhile is removed); let a read-only run write.
 */

import { describe, expect, test } from "vitest";
import { Facts, WRITE_BEHIND_LAG_MS, documentOfKey, repairPage, settleKey } from "../functions/lib/workspaceObjects/repair";
import type { BodyStore, WalkCursor } from "../functions/lib/workspaceObjects/bodies";

const ROOT = ".context/collaboration/v1/";
const LIVE = "dlive";
const GONE = "dgone";
const state = (id: string) => `${ROOT}documents/${id}.json`;
const revision = (id: string, name: string) => `${ROOT}revisions/${id}/${name}.json`;
const head = (name: string) => `${ROOT}heads/${name}.json`;
const NOTE = "notes/0199a000-0000-7000-8000-00000000000a.md";

type Entry = { bytes: Uint8Array; etag: string; uploaded: number };

function fakeStore(clock: { now: number }) {
  const objects = new Map<string, Entry>();
  let counter = 0;
  const writes: string[] = [];
  const store = {
    objects,
    writes,
    seed(key: string, body: string, uploaded = clock.now) {
      objects.set(key, { bytes: new TextEncoder().encode(body), etag: `e${++counter}`, uploaded });
    },
    text(key: string) {
      const entry = objects.get(key);
      return entry ? new TextDecoder().decode(entry.bytes) : null;
    },
    async get(key: string) {
      const entry = objects.get(key);
      if (!entry) return null;
      return { etag: entry.etag, uploaded: new Date(entry.uploaded), arrayBuffer: async () => entry.bytes.slice().buffer };
    },
    async put(key: string, value: ArrayBuffer | Uint8Array, options: { onlyIf?: { absent?: boolean; etagMatches?: string } } = {}) {
      const current = objects.get(key);
      if (options.onlyIf?.absent && current) return null;
      if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      writes.push(`put:${key}`);
      const etag = `e${++counter}`;
      objects.set(key, { bytes: new Uint8Array(value), etag, uploaded: clock.now });
      return { etag };
    },
    async delete(key: string, options: { onlyIf?: { etagMatches?: string } } = {}) {
      const current = objects.get(key);
      if (options.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      writes.push(`delete:${key}`);
      objects.delete(key);
      return undefined;
    },
    async list({ prefix = "", cursor, limit = 1000 }: { prefix?: string; cursor?: string; limit?: number }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const slice = keys.slice(from, from + limit);
      const truncated = from + limit < keys.length;
      return { objects: slice.map((key) => ({ key })), truncated, ...(truncated ? { cursor: String(from + limit) } : {}) };
    },
  };
  return store;
}

function world() {
  const clock = { now: 1_000_000_000_000 };
  const bucket = fakeStore(clock);
  const object = fakeStore(clock);
  return { clock, bucket, object, b: bucket as unknown as BodyStore, o: object as unknown as BodyStore };
}

const live = (current: string) => JSON.stringify({ documentId: LIVE, revision: current, pending: null });

describe("the key a document belongs to", () => {
  test("state, revisions and operations name their document; heads and notes do not", () => {
    expect(documentOfKey(state(LIVE))).toBe(LIVE);
    expect(documentOfKey(revision(LIVE, "r1"))).toBe(LIVE);
    expect(documentOfKey(`${ROOT}documents/${LIVE}/operations/x.json`)).toBe(LIVE);
    expect(documentOfKey(head("h1"))).toBeNull();
    expect(documentOfKey(NOTE)).toBeNull();
  });
});

describe("classing a key the bucket holds and the object lacks", () => {
  test("a revision the object's document still names was lost: restored into the object", async () => {
    const { bucket, object, b, o } = world();
    object.seed(state(LIVE), live("r2"));
    bucket.seed(state(LIVE), live("r2"));
    bucket.seed(revision(LIVE, "r2"), "snapshot-2");
    const result = await settleKey(b, o, revision(LIVE, "r2"), new Facts(o), true);
    expect(result).toEqual({ verdict: "bucketNewer", done: "restored" });
    expect(object.text(revision(LIVE, "r2"))).toBe("snapshot-2");
    expect(bucket.text(revision(LIVE, "r2"))).toBe("snapshot-2");
  });

  test("a revision the object's document no longer names stays in the bucket alone", async () => {
    const { bucket, object, b, o } = world();
    object.seed(state(LIVE), live("r2"));
    bucket.seed(revision(LIVE, "r1"), "snapshot-1");
    const result = await settleKey(b, o, revision(LIVE, "r1"), new Facts(o), true);
    expect(result).toEqual({ verdict: "olderRevision", done: null });
    expect(object.writes).toEqual([]);
    expect(bucket.writes).toEqual([]);
  });

  test("everything of a document the object no longer has was erased: deleted from the bucket", async () => {
    const { bucket, object, b, o } = world();
    bucket.seed(state(GONE), JSON.stringify({ documentId: GONE, revision: "r1" }));
    bucket.seed(revision(GONE, "r1"), "erased words");
    bucket.seed(head("h-gone"), JSON.stringify({ documentId: GONE }));
    const facts = new Facts(o);
    for (const key of [state(GONE), revision(GONE, "r1"), head("h-gone")]) {
      expect(await settleKey(b, o, key, facts, true)).toEqual({ verdict: "eraseNotApplied", done: "erased" });
    }
    expect(bucket.objects.size).toBe(0);
    expect(object.writes).toEqual([]);
  });

  test("a live document's lost state is restored, not erased: its versions are still in the object", async () => {
    const { bucket, object, b, o } = world();
    object.seed(revision(LIVE, "r2"), "snapshot-2");
    bucket.seed(state(LIVE), live("r2"));
    expect(await settleKey(b, o, state(LIVE), new Facts(o), true)).toEqual({ verdict: "bucketNewer", done: "restored" });
    expect(object.text(state(LIVE))).toBe(live("r2"));
  });

  test("a head of a live document was lost: restored", async () => {
    const { bucket, object, b, o } = world();
    object.seed(state(LIVE), live("r2"));
    bucket.seed(head("h-live"), JSON.stringify({ documentId: LIVE }));
    expect(await settleKey(b, o, head("h-live"), new Facts(o), true)).toEqual({ verdict: "bucketNewer", done: "restored" });
  });

  test("an operation of a live document, a note text, or an unreadable head is left alone", async () => {
    const { bucket, object, b, o } = world();
    object.seed(state(LIVE), live("r2"));
    bucket.seed(`${ROOT}documents/${LIVE}/operations/x.json`, "{}");
    bucket.seed(NOTE, "# text");
    bucket.seed(head("h-bad"), "not json");
    const facts = new Facts(o);
    for (const key of [`${ROOT}documents/${LIVE}/operations/x.json`, NOTE, head("h-bad")]) {
      expect((await settleKey(b, o, key, facts, true)).verdict).toBe("unsure");
    }
    expect(object.writes).toEqual([]);
    expect(bucket.writes).toEqual([]);
  });
});

describe("classing a key both hold with different bytes", () => {
  test("the object's copy written later: the bucket's backup is brought up to date", async () => {
    const { clock, bucket, object, b, o } = world();
    bucket.seed(state(LIVE), live("r1"), clock.now - 10_000);
    object.seed(state(LIVE), live("r2"), clock.now);
    expect(await settleKey(b, o, state(LIVE), new Facts(o), true)).toEqual({ verdict: "objectNewer", done: "backedUp" });
    expect(bucket.text(state(LIVE))).toBe(live("r2"));
  });

  test("the bucket's copy later by more than a write behind lags: the object takes it", async () => {
    const { clock, bucket, object, b, o } = world();
    object.seed(state(LIVE), live("r1"), clock.now - WRITE_BEHIND_LAG_MS - 1_000);
    bucket.seed(state(LIVE), live("r2"), clock.now);
    expect(await settleKey(b, o, state(LIVE), new Facts(o), true)).toEqual({ verdict: "bucketNewer", done: "restored" });
    expect(object.text(state(LIVE))).toBe(live("r2"));
  });

  test("the bucket's copy only a moment later is a write behind, not a newer save: left alone", async () => {
    const { clock, bucket, object, b, o } = world();
    object.seed(state(LIVE), live("r1"), clock.now - 500);
    bucket.seed(state(LIVE), live("r2"), clock.now);
    expect(await settleKey(b, o, state(LIVE), new Facts(o), true)).toEqual({ verdict: "unsure", done: null });
  });
});

describe("races and read-only runs", () => {
  test("an erase is applied only to the bucket copy that was read: a save meanwhile survives", async () => {
    const { bucket, b, o } = world();
    bucket.seed(state(GONE), "old");
    const realGet = bucket.get.bind(bucket);
    // The bucket's copy is replaced between the read and the delete.
    (bucket as { get: typeof bucket.get }).get = async (key: string) => {
      const found = await realGet(key);
      bucket.seed(key, "saved meanwhile");
      return found;
    };
    expect(await settleKey(b, o, state(GONE), new Facts(o), true)).toEqual({ verdict: "eraseNotApplied", done: "raced" });
    expect(bucket.text(state(GONE))).toBe("saved meanwhile");
  });

  test("without apply nothing is written on either side, and the page counts each class by shape", async () => {
    const { clock, bucket, object, b, o } = world();
    object.seed(state(LIVE), live("r2"));
    bucket.seed(state(LIVE), live("r2"));
    bucket.seed(revision(LIVE, "r2"), "lost");
    bucket.seed(revision(LIVE, "r1"), "older");
    bucket.seed(state(GONE), "erased");
    bucket.seed(head("h1"), JSON.stringify({ documentId: LIVE }), clock.now - 10_000);
    object.seed(head("h1"), JSON.stringify({ documentId: LIVE, moved: true }));
    bucket.seed(NOTE, "# same");
    object.seed(NOTE, "# same");
    const facts = new Facts(o);
    const totals: Record<string, number> = {};
    const shapes: Record<string, number> = {};
    let at: WalkCursor | null = { prefix: 0 };
    while (at !== null) {
      const page = await repairPage(b, o, { at, limit: 2, apply: false, facts });
      for (const [name, n] of Object.entries(page.counts)) totals[name] = (totals[name] ?? 0) + n;
      for (const [label, n] of Object.entries(page.shapes)) shapes[label] = (shapes[label] ?? 0) + n;
      at = page.next;
    }
    expect(object.writes).toEqual([]);
    expect(bucket.writes).toEqual([]);
    expect(totals).toMatchObject({ listed: 6, same: 2, bucketNewer: 1, olderRevision: 1, eraseNotApplied: 1, objectNewer: 1, restored: 0, erased: 0, backedUp: 0 });
    expect(shapes).toEqual({
      "bucketNewer#revisions/<64/plain": 1,
      "olderRevision#revisions/<64/plain": 1,
      "eraseNotApplied#documents/<64/plain": 1,
      "objectNewer#heads/<64/plain": 1,
    });
  });
});
