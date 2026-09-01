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

/**
 * A key from the version *this* one replaced: a note with no clearance in it.
 *
 * Written out by hand for the same reason `V0_KEY` is, and kept separately from
 * it because it is the shape the scope segment was introduced to retire. Every
 * assertion about it is about the migration: it is stale, it is swept, and it
 * is taken by both kinds of forget.
 */
const V1_NOTE_KEY = `context.lc.offline\u001fv1\u001fnote\u001fws1\u001fa.md`;

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
    const key = keys.scopedKeyFor("note", "private", "ws1", "1-projects/a.md");
    expect(keys.parseKey(key)).toEqual({
      kind: "note",
      scope: "private",
      workspaceId: "ws1",
      path: "1-projects/a.md",
    });
  });

  test("a kind that carries no clearance round-trips saying so", () => {
    // `scope: null` rather than a default: a draft is the person's own typing
    // and no clearance produced it, so there is nothing to record. Answering
    // `"team"` here would be inventing a fact about a record that has none.
    expect(keys.parseKey(keys.keyFor("draft", "ws1", "a.md"))).toEqual({
      kind: "draft",
      scope: null,
      workspaceId: "ws1",
      path: "a.md",
    });
    expect(keys.parseKey(keys.keyFor("outbox", "ws1"))).toEqual({
      kind: "outbox",
      scope: null,
      workspaceId: "ws1",
      path: "",
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
    const a = keys.scopedKeyFor("note", "private", "ws1", "a/b:c.md");
    const b = keys.scopedKeyFor("note", "private", "ws1", "a/b");
    expect(a).not.toBe(b);
    expect(keys.parseKey(a)?.path).toBe("a/b:c.md");
  });

  test("a cached copy filed under no clearance does not parse at all", () => {
    /*
      The half-finished migration, spelled out. A `note` key with three segments
      under *this* version's prefix is a copy nothing recorded a clearance for,
      and the tempting reading — "no scope means the old wide one, or the narrow
      one, take your pick" — is how an absent field becomes a decision nobody
      made. It is refused, which sends the caller to the bucket.

      The mirror case matters too: a clearance on a kind that has none would
      mean a draft filed under a tier, which is the orphaned-typing bug
      `UnscopedKind` exists to prevent.
    */
    const unscopedNote = `context.lc.offline\u001fv2\u001fnote\u001fws1\u001fa.md`;
    expect(keys.parseKey(unscopedNote)).toBeNull();

    const scopedDraft = `context.lc.offline\u001fv2\u001fdraft\u001fteam\u001fws1\u001fa.md`;
    expect(keys.parseKey(scopedDraft)).toBeNull();
  });

  test("a clearance this version does not recognise is not a clearance", () => {
    // Round-tripping rather than pattern-matching: the parser accepts the two
    // values `CacheScope` has and nothing else, so a key hand-written by a
    // newer version — or by anything at all — cannot smuggle in a third tier
    // that every later comparison would then treat as unequal to both.
    const invented = `context.lc.offline\u001fv2\u001fnote\u001fadmin\u001fws1\u001fa.md`;
    expect(keys.parseKey(invented)).toBeNull();
  });

  test("private may read a team copy, and team may never read a private one", () => {
    /*
      The direction, on its own, in the one function that decides it.
      `private` is a superset of `team`, so widening upwards is safe and
      widening downwards is the leak. This is the assertion to invert if you
      want to see the rest of this file fail.
    */
    expect(keys.readableAt("private")).toEqual(["private", "team"]);
    expect(keys.readableAt("team")).toEqual(["team"]);
    expect(keys.readableAt("team")).not.toContain("private");
  });

  test("another app's keys are not ours to sweep", () => {
    /*
      `isStaleVersion` is deliberately narrower than "anything `parseKey`
      rejects": that set includes every key belonging to the rest of the app,
      and a cache sweep that deletes somebody else's data is a far worse bug
      than a record left behind.
    */
    expect(keys.isStaleVersion(V0_KEY)).toBe(true);
    expect(keys.isStaleVersion(V1_NOTE_KEY)).toBe(true);
    expect(keys.isStaleVersion(keys.scopedKeyFor("note", "team", "ws1", "a.md"))).toBe(false);
    expect(keys.isStaleVersion("some.other.feature key")).toBe(false);
    expect(keys.ownedKeys(["some.other.feature key"])).toEqual([]);
  });

  test("sign-out's set is every version's keys, this one's included", () => {
    // `ownedKeys` keys off the namespace and nothing else, which is what makes
    // "signing out takes the notes off the device" survive a version bump. A
    // set derived from `parseKey` would quietly stop covering the shape the
    // bump replaced — on exactly the records nobody has read since.
    const current = keys.scopedKeyFor("note", "private", "ws1", "a.md");
    expect(keys.ownedKeys([V0_KEY, V1_NOTE_KEY, current, "some.other.feature key"])).toEqual([
      V0_KEY,
      V1_NOTE_KEY,
      current,
    ]);
  });

  test("leaving a context takes the records this version cannot read", () => {
    /*
      The regression the scope segment could have introduced. `forgetWorkspace`
      used to filter on `parseKey(key)?.workspaceId`, and a bumped version makes
      every older key unparseable — so leaving a context would have left its
      note bodies on the device until the age bound caught them thirty days
      later. A stale key cannot be attributed to a workspace at all, so they are
      all taken; `sweep` was already taking exactly that set unconditionally.

      What is *not* taken is another feature's key, or another context's
      readable records — the same line `forgetEverything` does not cross.
    */
    const mine = keys.scopedKeyFor("note", "private", "ws1", "a.md");
    const theirs = keys.scopedKeyFor("note", "private", "ws2", "a.md");
    const held = [mine, theirs, V0_KEY, V1_NOTE_KEY, "some.other.feature key"];

    expect(keys.keysForWorkspace(held, "ws1")).toEqual([mine, V0_KEY, V1_NOTE_KEY]);
  });
});

/* -------------------------------------------------------------------------- */

describe("the cache", () => {
  let store: KeyValueStore;
  beforeEach(() => {
    store = memoryStore();
  });

  test("a note and a listing come back with the moment they were read", async () => {
    await cache.putNote(store, "private", "ws1", note("a.md", "hello"), 1_000);
    await cache.putListing(store, "private", "ws1", listing(""), 2_000);

    expect(await cache.getNote(store, "private", "ws1", "a.md")).toEqual({
      value: note("a.md", "hello"),
      cachedAt: 1_000,
    });
    expect((await cache.getListing(store, "private", "ws1", ""))?.cachedAt).toBe(2_000);
  });

  test("one clearance's cache is not a narrower one's", async () => {
    /*
      The module-level half of `offlineScope.test.ts`. That file proves the leak
      through the hook, which is where it is reachable from; this proves the
      same rule at the layer any future caller will use, so a second consumer of
      `cache.ts` cannot reintroduce it by not going through `useOfflineNotes`.

      An owner's read is filtered at `private` and everybody else's at `team`
      (`scopeForRole`), so a copy taken by an owner is a copy of an answer the
      server would not give the same person after a demotion.
    */
    await cache.putNote(store, "private", "ws1", note("a.md", "salary numbers"), 1);
    await cache.putListing(store, "private", "ws1", listing(""), 1);

    expect(await cache.getNote(store, "team", "ws1", "a.md")).toBeNull();
    expect(await cache.getListing(store, "team", "ws1", "")).toBeNull();
  });

  test("and a copy taken at team level may be served to an owner", async () => {
    /*
      The safe direction, and the anti-vacuity witness for the test above:
      "return nothing, ever" satisfies it and deletes the feature. `private` is
      a superset of `team`, so a copy taken while this person was a member holds
      nothing an owner is not already entitled to.
    */
    await cache.putNote(store, "team", "ws1", note("a.md", "shared with the team"), 1);

    expect((await cache.getNote(store, "private", "ws1", "a.md"))?.value.text).toBe(
      "shared with the team",
    );
    // And the narrower session still reads its own, which is the ordinary case.
    expect(await cache.getNote(store, "team", "ws1", "a.md")).not.toBeNull();
  });

  test("the clearance narrows within one context, not across two", async () => {
    // Both segments are load-bearing and neither stands in for the other: same
    // clearance, different context, is still a miss.
    await cache.putNote(store, "team", "ws1", note("a.md", "mine"), 1);
    expect(await cache.getNote(store, "team", "ws2", "a.md")).toBeNull();
  });

  test("one context's cache is not another's", async () => {
    // Non-negotiable #4 as a cache rule: a person belongs to many contexts and
    // the console switches between them.
    await cache.putNote(store, "private", "ws1", note("a.md", "mine"), 1);
    expect(await cache.getNote(store, "private", "ws2", "a.md")).toBeNull();
  });

  test("a record that will not parse is a record we do not have", async () => {
    await store.set(keys.scopedKeyFor("note", "private", "ws1", "a.md"), "{not json");
    expect(await cache.getNote(store, "private", "ws1", "a.md")).toBeNull();
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
    await cache.putNote(store, "private", "ws1", note("old.md"), 0);
    await cache.putDraft(store, "ws1", { path: "old.md", text: "typed", baseEtag: null, savedAt: 0 });
    await cache.putOutbox(
      store,
      enqueue(emptyOutbox("ws1"), { path: "old.md", text: "typed", baseEtag: null, now: 0 }),
    );

    const { removed } = await cache.sweep(store, { now: cache.MAX_AGE_MS + 1 });

    expect(removed).toBe(1);
    expect(await cache.getNote(store, "private", "ws1", "old.md")).toBeNull();
    expect(await cache.getDraft(store, "ws1", "old.md")).not.toBeNull();
    expect((await cache.getOutbox(store, "ws1")).writes).toHaveLength(1);
  });

  test("the sweep drops the oldest first once the count bound is passed", async () => {
    for (let index = 0; index < 5; index += 1) {
      await cache.putNote(store, "private", "ws1", note(`n${index}.md`), index);
    }
    await cache.sweep(store, { now: 10, maxEntries: 2 });

    expect(await cache.getNote(store, "private", "ws1", "n0.md")).toBeNull();
    expect(await cache.getNote(store, "private", "ws1", "n2.md")).toBeNull();
    expect(await cache.getNote(store, "private", "ws1", "n3.md")).not.toBeNull();
    expect(await cache.getNote(store, "private", "ws1", "n4.md")).not.toBeNull();
  });

  test("a record written by a version we cannot read is dropped, not parsed", async () => {
    await store.set(V0_KEY, "{}");
    await cache.sweep(store, { now: 1 });
    expect(await store.get(V0_KEY)).toBeNull();
  });

  test("signing out leaves nothing of anybody's notes behind", async () => {
    await cache.putNote(store, "private", "ws1", note("a.md", "private thoughts"), 1);
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
    await cache.putNote(store, "private", "ws1", note("a.md"), 1);
    await cache.putNote(store, "private", "ws2", note("a.md"), 1);

    await cache.forgetWorkspace(store, "ws1");

    expect(await cache.getNote(store, "private", "ws1", "a.md")).toBeNull();
    expect(await cache.getNote(store, "private", "ws2", "a.md")).not.toBeNull();
  });

  test("forgetting one context also takes the records this version cannot read", async () => {
    /*
      Driven through the real `forgetWorkspace` rather than through
      `keysForWorkspace` alone, because the regression this guards against is a
      *call site* one: the filter used to be written out here, and a version
      bump makes every older key unparseable to it. What is left behind then is
      a note body for a context the person has just left.

      Another feature's key on the same origin survives, which is the line the
      whole namespace rule draws.
    */
    await store.set(V1_NOTE_KEY, JSON.stringify({ value: note("a.md"), cachedAt: 1 }));
    await store.set("some.other.feature key", "not ours");

    await cache.forgetWorkspace(store, "ws1");

    expect(await store.get(V1_NOTE_KEY)).toBeNull();
    expect(await store.get("some.other.feature key")).toBe("not ours");
  });

  test("the sweep leaves the rest of the app's storage alone", async () => {
    // `isStaleVersion` is namespaced, and this is what that buys: a sweep runs
    // on every mount, so a predicate one character wider than the namespace
    // would empty somebody else's storage on the first render after an upgrade.
    await store.set("some.other.feature key", "not ours");
    await store.set("context.lc.somethingelse\u001fv1\u001fx", "also not ours");

    await cache.sweep(store, { now: cache.MAX_AGE_MS + 1 });

    expect(await store.get("some.other.feature key")).toBe("not ours");
    expect(await store.get("context.lc.somethingelse\u001fv1\u001fx")).toBe("also not ours");
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
    await cache.putNote(store, "private", "ws1", note("a.md"), 1);
    await cache.putListing(store, "private", "ws1", listing(""), 1);

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
