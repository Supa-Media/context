/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, test } from "@jest/globals";

/**
 * The store under the offline cache, and the cache on top of it.
 *
 * Run in jsdom because the web half is `localStorage` and the point of the
 * first block is that it is the **real** one, not a fake: this suite already
 * resolves `.web.ts` ahead of the bare extension (see `jest.config.js`), so a
 * test that stubbed the browser's storage would be testing the stub.
 *
 * The same conformance block runs against `memoryStore()`, which is the
 * fallback a browser with site data blocked lands on. `store.ts` — the native
 * half, `AsyncStorage` — is not here and cannot be: this suite runs in plain
 * node with no native mocks and no `jest-expo` preset (`jest.config.js` says
 * why), the same reason `clipboard.ts` and `fonts.ts` have untested native
 * halves. What holds it is that it is a delegation and nothing more, and that
 * everything above it is written against `KeyValueStore` rather than against
 * either implementation.
 */

const { memoryStore } =
  require("../features/offline/memory") as typeof import("../features/offline/memory");
const { openStore } =
  require("../features/offline/store.web") as typeof import("../features/offline/store.web");
const keys = require("../features/offline/keys") as typeof import("../features/offline/keys");
const cache = require("../features/offline/cache") as typeof import("../features/offline/cache");
const {
  emptyOutbox,
  enqueue,
} = require("../features/offline/outbox") as typeof import("../features/offline/outbox");

type KeyValueStore = import("../features/offline/memory").KeyValueStore;
type OpenNote = import("../features/console/files/types").OpenNote;
type FolderListing = import("../features/console/files/types").FolderListing;

function note(path: string, text = "body", etag = "e1"): OpenNote {
  return {
    path,
    text,
    etag,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

function listing(path: string): FolderListing {
  return { path, folderDefault: "private", entries: [], truncated: false, manifestUsable: true };
}

/**
 * A key from a version of this feature that does not exist any more.
 *
 * Written out by hand, separator and all, rather than built from `keyFor` —
 * the whole point is that it is a key *this* code cannot produce, and one
 * derived from the current builder could never be stale.
 */
const V0_KEY = `context.lc.offline\u001fv0\u001fnote\u001fws1\u001fa.md`;

/* -------------------------------------------------------------------------- */

describe("the key/value port", () => {
  beforeEach(() => window.localStorage.clear());

  const implementations: [string, () => KeyValueStore][] = [
    ["localStorage", () => openStore()],
    ["memory", () => memoryStore()],
  ];

  for (const [name, make] of implementations) {
    describe(name, () => {
      test("round-trips, overwrites, removes, and lists", async () => {
        const store = make();
        expect(await store.get("a")).toBeNull();

        await store.set("a", "one");
        expect(await store.get("a")).toBe("one");

        await store.set("a", "two");
        expect(await store.get("a")).toBe("two");

        await store.set("b", "three");
        expect((await store.keys()).sort()).toEqual(["a", "b"]);

        await store.remove("a");
        expect(await store.get("a")).toBeNull();
        // Removing something absent is not an error anywhere.
        await store.remove("a");
      });
    });
  }

  test("localStorage is durable and memory says it is not", () => {
    /*
      The whole reason `durable` is on the interface. `copy.ts` turns this
      boolean into two different promises about somebody's queued typing, so a
      store that lied here would be the console lying on screen.
    */
    expect(openStore().durable).toBe(true);
    expect(memoryStore().durable).toBe(false);
  });

  test("a browser that refuses site data degrades to memory rather than throwing", () => {
    /*
      Safari in Private Browsing, an embedded webview, a browser configured to
      block storage: `setItem` throws, and in the third case reading the
      property throws. `openStore` probes with a real write for exactly this —
      `typeof window.localStorage !== "undefined"` is true in every one of them.

      Patched on `Storage.prototype`, not on the instance. jsdom's
      `localStorage` is a proxy whose property *sets* become stored items, so
      `window.localStorage.setItem = fn` quietly stores a string under the key
      "setItem" and the real method keeps working — a sabotage that sabotages
      nothing, which is the shape of guard this repository keeps finding was
      never really checked.
    */
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(openStore().durable).toBe(false);
    } finally {
      Storage.prototype.setItem = real;
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("keys", () => {
  test("a key round-trips through its parser", () => {
    const key = keys.keyFor("note", "ws1", "1-projects/a.md");
    expect(keys.parseKey(key)).toEqual({
      kind: "note",
      workspaceId: "ws1",
      path: "1-projects/a.md",
    });
  });

  test("a path containing slashes and colons cannot collide with another key", () => {
    /*
      The separator is the point. Built with `/` or `:` — both legal inside a
      bucket key — `note/ws1/a:b.md` and `note/ws1/a` + `b.md` are the same
      string, so two different notes share one cache entry. The separator here
      is a character `assertSafePrefix` refuses in the adapter, so no path can
      contain one.
    */
    const a = keys.keyFor("note", "ws1", "a/b:c.md");
    const b = keys.keyFor("note", "ws1", "a/b");
    expect(a).not.toBe(b);
    expect(keys.parseKey(a)?.path).toBe("a/b:c.md");
  });

  test("another app's keys are not ours to sweep", () => {
    /*
      `isStaleVersion` is deliberately narrower than "anything `parseKey`
      rejects": that set includes every key belonging to the rest of the app,
      and a cache sweep that deletes somebody else's data is a far worse bug
      than a record left behind.
    */
    expect(keys.isStaleVersion(V0_KEY)).toBe(true);
    expect(keys.isStaleVersion(keys.keyFor("note", "ws1", "a.md"))).toBe(false);
    expect(keys.isStaleVersion("some.other.feature key")).toBe(false);
    expect(keys.ownedKeys(["some.other.feature key"])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("the cache", () => {
  let store: KeyValueStore;
  beforeEach(() => {
    store = memoryStore();
  });

  test("a note and a listing come back with the moment they were read", async () => {
    await cache.putNote(store, "ws1", note("a.md", "hello"), 1_000);
    await cache.putListing(store, "ws1", listing(""), 2_000);

    expect(await cache.getNote(store, "ws1", "a.md")).toEqual({
      value: note("a.md", "hello"),
      cachedAt: 1_000,
    });
    expect((await cache.getListing(store, "ws1", ""))?.cachedAt).toBe(2_000);
  });

  test("one context's cache is not another's", async () => {
    // Non-negotiable #4 as a cache rule: a person belongs to many contexts and
    // the console switches between them.
    await cache.putNote(store, "ws1", note("a.md", "mine"), 1);
    expect(await cache.getNote(store, "ws2", "a.md")).toBeNull();
  });

  test("a record that will not parse is a record we do not have", async () => {
    await store.set(keys.keyFor("note", "ws1", "a.md"), "{not json");
    expect(await cache.getNote(store, "ws1", "a.md")).toBeNull();
  });

  test("a draft survives being written and read back, with its base etag", async () => {
    await cache.putDraft(store, "ws1", {
      path: "a.md",
      text: "half a sentence",
      baseEtag: "e1",
      savedAt: 5,
    });
    expect(await cache.getDraft(store, "ws1", "a.md")).toEqual({
      path: "a.md",
      text: "half a sentence",
      baseEtag: "e1",
      savedAt: 5,
    });
    await cache.clearDraft(store, "ws1", "a.md");
    expect(await cache.getDraft(store, "ws1", "a.md")).toBeNull();
  });

  test("the sweep never touches a draft or the queue", async () => {
    /*
      The single most important property in this file. Notes and listings are
      disposable derivatives of the customer's files; a draft and a queued write
      are the only copy of something a person typed. An eviction path that
      cannot tell them apart is data loss wearing the word "cache".
    */
    await cache.putNote(store, "ws1", note("old.md"), 0);
    await cache.putDraft(store, "ws1", { path: "old.md", text: "typed", baseEtag: null, savedAt: 0 });
    await cache.putOutbox(
      store,
      enqueue(emptyOutbox("ws1"), { path: "old.md", text: "typed", baseEtag: null, now: 0 }),
    );

    const { removed } = await cache.sweep(store, { now: cache.MAX_AGE_MS + 1 });

    expect(removed).toBe(1);
    expect(await cache.getNote(store, "ws1", "old.md")).toBeNull();
    expect(await cache.getDraft(store, "ws1", "old.md")).not.toBeNull();
    expect((await cache.getOutbox(store, "ws1")).writes).toHaveLength(1);
  });

  test("the sweep drops the oldest first once the count bound is passed", async () => {
    for (let index = 0; index < 5; index += 1) {
      await cache.putNote(store, "ws1", note(`n${index}.md`), index);
    }
    await cache.sweep(store, { now: 10, maxEntries: 2 });

    expect(await cache.getNote(store, "ws1", "n0.md")).toBeNull();
    expect(await cache.getNote(store, "ws1", "n2.md")).toBeNull();
    expect(await cache.getNote(store, "ws1", "n3.md")).not.toBeNull();
    expect(await cache.getNote(store, "ws1", "n4.md")).not.toBeNull();
  });

  test("a record written by a version we cannot read is dropped, not parsed", async () => {
    await store.set(V0_KEY, "{}");
    await cache.sweep(store, { now: 1 });
    expect(await store.get(V0_KEY)).toBeNull();
  });

  test("signing out leaves nothing of anybody's notes behind", async () => {
    await cache.putNote(store, "ws1", note("a.md", "private thoughts"), 1);
    await cache.putDraft(store, "ws1", { path: "a.md", text: "more", baseEtag: "e1", savedAt: 1 });
    await cache.putOutbox(
      store,
      enqueue(emptyOutbox("ws2"), { path: "b.md", text: "queued", baseEtag: null, now: 1 }),
    );
    await store.set("unrelated", "keep me");

    await cache.forgetEverything(store);

    expect(await store.keys()).toEqual(["unrelated"]);
  });

  test("forgetting one context leaves the others alone", async () => {
    await cache.putNote(store, "ws1", note("a.md"), 1);
    await cache.putNote(store, "ws2", note("a.md"), 1);

    await cache.forgetWorkspace(store, "ws1");

    expect(await cache.getNote(store, "ws1", "a.md")).toBeNull();
    expect(await cache.getNote(store, "ws2", "a.md")).not.toBeNull();
  });

  test("what is waiting on this device counts every context but the open one's queue", async () => {
    /*
      What the sign-out warning is built from. The open context's queue is
      excluded because the console holds a live copy of it that is newer than
      the persisted one — the caller adds that — and a draft is counted
      everywhere, because the live counts are the outbox's alone.

      Two ways this can be wrong and both discard somebody's typing without a
      sentence: counting only the open context (a queue nobody has looked at
      this session goes silently), or counting the open context's persisted
      queue as well (its live counts are added on top, so the number doubles
      and the warning stops being believable).
    */
    await cache.putOutbox(
      store,
      enqueue(emptyOutbox("ws1"), { path: "open.md", text: "here", baseEtag: null, now: 0 }),
    );
    await cache.putOutbox(
      store,
      enqueue(emptyOutbox("ws2"), { path: "away.md", text: "elsewhere", baseEtag: null, now: 0 }),
    );
    await cache.putDraft(store, "ws1", {
      path: "typed.md",
      text: "never saved",
      baseEtag: null,
      savedAt: 0,
    });

    expect(await cache.waitingOnDevice(store, "ws1")).toEqual({
      pending: 2, // ws2's queued write, and the draft in the open context
      conflicted: 0,
      rejected: 0,
    });
    // With no context open, nothing is excluded.
    expect((await cache.waitingOnDevice(store, null)).pending).toBe(3);
  });

  test("a note or a listing is never something waiting to be sent", async () => {
    // Anti-vacuity for the count above: a cache entry is a disposable
    // derivative, and warning about one before sign-out would be the console
    // asking about a round trip.
    await cache.putNote(store, "ws1", note("a.md"), 1);
    await cache.putListing(store, "ws1", listing(""), 1);

    expect(await cache.waitingOnDevice(store, null)).toEqual({
      pending: 0,
      conflicted: 0,
      rejected: 0,
    });
  });

  test("a key this version cannot read is still counted, because it is still deleted", async () => {
    /*
      `forgetEverything` walks `ownedKeys`, which is every key under the
      namespace whatever its version segment says — so a `v0` outbox or draft
      is discarded by sign-out. `parseKey` answers `null` for the same key, so
      before this it was discarded **without ever being mentioned**, which is
      the exact failure this count exists to prevent.

      It is deliberately over-counted rather than classified: the kind segment
      belongs to a shape this version cannot read, so a stale note cache and a
      stale queue are indistinguishable. Over-warning costs a dialog;
      under-warning costs somebody's typing.
    */
    await store.set("context.lc.offline\u001fv0\u001foutbox\u001fws1\u001f", "{}");
    await store.set("context.lc.offline\u001fv0\u001fdraft\u001fws1\u001ftyped.md", "{}");
    // Another feature's key on the same origin is not ours to count, the same
    // way it is not ours to delete.
    await store.set("some.other.feature key", "not ours");

    expect(await cache.waitingOnDevice(store, null)).toEqual({
      pending: 2,
      conflicted: 0,
      rejected: 0,
    });
  });

  test("an emptied queue leaves no record behind", async () => {
    await cache.putOutbox(store, emptyOutbox("ws1"));
    expect(await store.keys()).toEqual([]);
  });
});
