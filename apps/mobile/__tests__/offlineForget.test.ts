import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { KeyValueStore } from "../features/offline/memory";
import { destinationKey, meetingKey } from "../features/meetings/keys";

/**
 * `forget.ts`, driven through the failure stance it is written about.
 *
 * The module is 138 lines whose entire stated value is what it does when the
 * device will not co-operate — "never block", "never silently", a verdict that
 * is "measured rather than assumed". Every one of those sentences was true of
 * the comment and untested in the code: neither `catch` had ever been entered,
 * `warnLeftBehind` had never been called, and no test had ever seen a verdict
 * that was not `cleared`. That is the shape this repository keeps finding — a
 * guard nobody has checked is not a guard — and it is worse here than most,
 * because the code path nobody exercises is the one that runs on the day
 * somebody's browser is refusing to co-operate at sign-out.
 *
 * So each store below is a lie of a different kind: one that throws when asked
 * what it holds, one that accepts a removal and performs none, one that answers
 * nothing at all, and one that is a private `Map` this module cannot see into.
 * Neither real store can do any of these — that is stated in the module and is
 * exactly why they have to be injected.
 */

/**
 * The store `forget.ts` opens. Replaced per test with something dishonest.
 *
 * `mock`-prefixed because the factory below reads it, and jest refuses any
 * other out-of-scope name inside a `jest.mock` factory. `mockOpened` is the name
 * the tests read with — the same arrangement `signOutHygiene.test.ts` makes
 * for its `ownedNow`.
 */
let mockOpened: KeyValueStore;

jest.mock("../features/offline/store", () => ({
  openStore: () => mockOpened,
}));

const {
  CLEAR_DEADLINE_MS,
  forgetContextCopies,
  forgetDepartedContexts,
  forgetLocalCopies,
  unsentOnDevice,
} = require("../features/offline/forget") as typeof import("../features/offline/forget");
const { currentEpoch } =
  require("../features/offline/epoch") as typeof import("../features/offline/epoch");
const { keyFor, scopedKeyFor } =
  require("../features/offline/keys") as typeof import("../features/offline/keys");

/** A store backed by a `Map`, with any of its four methods replaceable. */
function store(
  overrides: Partial<KeyValueStore> = {},
  seed: Record<string, string> = {},
): KeyValueStore {
  const held = new Map<string, string>(Object.entries(seed));
  return {
    durable: true,
    get: async (key) => held.get(key) ?? null,
    set: async (key, value) => {
      held.set(key, value);
    },
    remove: async (key) => {
      held.delete(key);
    },
    keys: async () => [...held.keys()],
    ...overrides,
  };
}

const NOTE_KEY = scopedKeyFor("note", "private", "w1", "1-projects/pay.md");
const OTHER_NOTE_KEY = scopedKeyFor("note", "private", "w2", "1-projects/other.md");
const DRAFT_KEY = keyFor("draft", "w1", "1-projects/pay.md");

const SEEDED = {
  [NOTE_KEY]: JSON.stringify({ value: { text: "private" }, cachedAt: 1 }),
  [OTHER_NOTE_KEY]: JSON.stringify({ value: { text: "private" }, cachedAt: 1 }),
  [DRAFT_KEY]: JSON.stringify({ path: "1-projects/pay.md", text: "typed", baseEtag: null }),
  "some.other.feature key": "not ours",
};

let warnings: string[];
let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  warnings = [];
  warn = jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.join(" "));
  });
  mockOpened = store({}, SEEDED);
});

afterEach(() => {
  warn.mockRestore();
  jest.useRealTimers();
});

/* -------------------------------------------------------------------------- */

describe("the meetings namespace", () => {
  /*
    Meetings are not in `ownedKeys` — they have their own namespace — so
    `forgetLocalCopies` has to name them, the way it already names the last
    place this device was on. `keys.ts` claimed sign-out swept them; its own
    file header said it did not, and the header was right.

    Seeded here rather than in `SEEDED` because the tests above count what is
    left, and two extra keys would change every one of those numbers for a
    reason that has nothing to do with what they assert.
  */
  test("a meeting on the device goes with the copies", async () => {
    const key = meetingKey("ws-1", "mtg_00000000000000000000");
    mockOpened = store({}, {
      [key]: JSON.stringify({ id: "mtg_00000000000000000000", title: "Private meeting" }),
    });

    expect(await forgetLocalCopies()).toEqual({ verdict: "cleared" });
    expect(await mockOpened.keys()).toEqual([]);
  });

  test("and so does the destination somebody last chose", async () => {
    /*
      The sharper of the two. It holds no note text — a context slug and the
      name of one of somebody's folders — which is exactly `lastPlace`'s own
      reason for being cleared by name. On a shared device it would otherwise
      survive one person's sign-out and preselect a row for the next.
    */
    mockOpened = store({}, {
      [destinationKey()]: JSON.stringify({
        kind: "currentPage",
        contextSlug: "field-notes",
        folder: "1-projects/portal",
      }),
    });

    expect(await forgetLocalCopies()).toEqual({ verdict: "cleared" });
    expect(await mockOpened.get(destinationKey())).toBeNull();
  });
});

describe("a store that behaves", () => {
  test("the verdict is cleared, and only this feature's keys go", async () => {
    // The anti-vacuity witness for everything below: a verdict of `cleared`
    // has to be reachable, or "not cleared" proves nothing.
    expect(await forgetLocalCopies()).toEqual({ verdict: "cleared" });
    expect(await mockOpened.keys()).toEqual(["some.other.feature key"]);
    expect(warnings).toEqual([]);
  });

  test("one context leaves the others alone", async () => {
    expect(await forgetContextCopies("w1")).toEqual({ verdict: "cleared" });
    expect(await mockOpened.keys()).toEqual([OTHER_NOTE_KEY, "some.other.feature key"]);
  });
});

describe("a store that cannot say what it holds", () => {
  test("sign-out reports unmeasured rather than throwing", async () => {
    mockOpened = store({
      keys: async () => {
        throw new Error("site data is blocked");
      },
    });

    // The whole stance in one assertion: it answers, and the answer is not a
    // claim. Refusing to sign out would be the worse failure.
    expect(await forgetLocalCopies()).toEqual({ verdict: "unmeasured" });
    expect(warnings).toEqual([
      "[offline] sign-out: this device's store could not be read or written",
    ]);
  });

  test("leaving a context reports it under its own name", async () => {
    mockOpened = store({
      keys: async () => {
        throw new Error("site data is blocked");
      },
    });

    expect(await forgetContextCopies("w1")).toEqual({ verdict: "unmeasured" });
    expect(warnings).toEqual([
      "[offline] leave: this device's store could not be read or written",
    ]);
  });

  test("the session is ended anyway", async () => {
    /*
      The load-bearing half, and the reason the epoch is bumped before the
      store is even opened. A device that cannot be cleared is the device most
      in need of the barrier: if the bump were conditional on the clear
      succeeding, the one case where records survive would also be the case
      where new ones keep arriving.
    */
    mockOpened = store({
      keys: async () => {
        throw new Error("site data is blocked");
      },
    });
    const before = currentEpoch();

    await forgetLocalCopies();

    expect(currentEpoch()).toBe(before + 1);
  });
});

describe("a store that accepts a removal and performs none", () => {
  test("the verdict says records were left behind, with a count and no paths", async () => {
    /*
      The case the whole "verified rather than trusted" paragraph exists for.
      `remove` resolves, so nothing throws and nothing is visibly wrong; only
      the re-listing afterwards can tell. The warning carries a count and never
      a key, because a key carries a bucket path and a path is a note's name.
    */
    mockOpened = store({ remove: async () => {} }, SEEDED);

    expect(await forgetLocalCopies()).toEqual({ verdict: "left-behind" });
    expect(warnings).toEqual([
      "[offline] sign-out: 3 record(s) could not be removed from this device",
    ]);
    expect(warnings.join(" ")).not.toContain("pay.md");
  });

  test("and the same for one context, counting only that context's records", async () => {
    mockOpened = store({ remove: async () => {} }, SEEDED);

    expect(await forgetContextCopies("w1")).toEqual({ verdict: "left-behind" });
    expect(warnings).toEqual([
      "[offline] leave: 2 record(s) could not be removed from this device",
    ]);
  });
});

describe("a store this handle cannot see into", () => {
  test("the in-memory fallback answers unmeasured, not cleared", async () => {
    /*
      `forget.ts` opens its own handle, and on the in-memory fallback a second
      handle is a second `Map`. So the removals ran against an empty one and
      the re-listing measured that same empty one: a verdict of `cleared` there
      would be assumed, which is precisely the word the module says it is not.
      It is not a leak either — the console's `Map` dies with the tab and never
      survived a reload — so it is not warned about, only refused as a claim.
    */
    mockOpened = store({ durable: false }, SEEDED);

    expect(await forgetLocalCopies()).toEqual({ verdict: "unmeasured" });
    expect(await forgetContextCopies("w1")).toEqual({ verdict: "unmeasured" });
    expect(warnings).toEqual([]);
  });
});

describe("a store that never answers at all", () => {
  test("sign-out is not held for longer than the deadline", async () => {
    /*
      The failure the stance did not cover before: it wrapped rejection, and a
      wedged native bridge does not reject — it never settles. `AsyncStorage`
      is a bridge call, and the console awaits this before `signOut`, so an
      unbounded wait is a sign-out button that never returns. This codebase is
      already precise about the difference: `ConvexReactClient.action()`
      "neither resolves nor rejects" is why the offline read path exists.
    */
    jest.useFakeTimers();
    mockOpened = store({ keys: () => new Promise<string[]>(() => {}) });

    const answering = forgetLocalCopies();
    let answered = false;
    void answering.then(() => {
      answered = true;
    });

    await jest.advanceTimersByTimeAsync(CLEAR_DEADLINE_MS - 1);
    expect(answered).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await answering).toEqual({ verdict: "unmeasured" });
    expect(warnings).toEqual(["[offline] sign-out: this device's store did not answer in time"]);
  });

  test("and a clear that answers in time leaves no timer behind", async () => {
    /*
      `withDeadline` clears its timer in a `finally`, and nothing checked that
      — deleting the `clearTimeout` left this whole suite green, including
      under `--detectOpenHandles`, because the run outlives a two-second timer
      and the fake-timer cases discard theirs at teardown. So the comment
      justifying it ("a two-second handle holding the process open in every
      test that presses one") was arguing for a line no test could miss.

      Counting the timers is what actually sees it: the race leaves one
      pending, and the winning path has to take it back.
    */
    jest.useFakeTimers();
    mockOpened = store({ keys: async () => [] });

    expect(await forgetLocalCopies()).toEqual({ verdict: "cleared" });
    expect(jest.getTimerCount()).toBe(0);
  });

  test("and the barrier is up before the wait even starts", async () => {
    jest.useFakeTimers();
    mockOpened = store({ keys: () => new Promise<string[]>(() => {}) });
    const before = currentEpoch();

    const answering = forgetLocalCopies();
    // Not awaited: the bump is synchronous, which is what makes a store that
    // never answers survivable rather than an open window of unknown length.
    expect(currentEpoch()).toBe(before + 1);

    await jest.advanceTimersByTimeAsync(CLEAR_DEADLINE_MS);
    await answering;
  });

  test("leaving a context is bounded the same way", async () => {
    jest.useFakeTimers();
    mockOpened = store({ keys: () => new Promise<string[]>(() => {}) });

    const answering = forgetContextCopies("w1");
    await jest.advanceTimersByTimeAsync(CLEAR_DEADLINE_MS);

    expect(await answering).toEqual({ verdict: "unmeasured" });
    expect(warnings).toEqual(["[offline] leave: this device's store did not answer in time"]);
  });
});

describe("counting what is waiting on a store that will not answer", () => {
  test("a count that could not be read is zero, never a fabricated number", async () => {
    mockOpened = store({
      keys: async () => {
        throw new Error("site data is blocked");
      },
    });

    expect(await unsentOnDevice(null)).toEqual({ pending: 0, conflicted: 0, rejected: 0 });
  });

  test("and one that never answers is bounded too, because it runs first", async () => {
    /*
      The other half, and the ordering is the whole point. `onSignOut` awaits
      the count *before* the clear, so an unbounded count hangs the button
      before the clear's own deadline can ever be reached — putting the failure
      that deadline exists for one call earlier, on the same press. A store
      that throws is the case above; a wedged bridge does not throw, it goes
      quiet, and this file's own paragraph on the clear draws exactly that
      distinction.
    */
    jest.useFakeTimers();
    mockOpened = store({ keys: () => new Promise<string[]>(() => {}) });

    const counting = unsentOnDevice(null);
    let answered = false;
    void counting.then(() => {
      answered = true;
    });

    await jest.advanceTimersByTimeAsync(CLEAR_DEADLINE_MS - 1);
    expect(answered).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await counting).toEqual({ pending: 0, conflicted: 0, rejected: 0 });
    expect(warnings).toEqual([
      "[offline] the count of unsent work: this device's store did not answer in time",
    ]);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The contexts nobody left, and nobody is a member of any more.
 *
 * `forgetContextCopies` fires on the one transition this device can see — the
 * person pressing Leave. Every other way a membership ends happens on somebody
 * else's machine: an owner removes you, a shared context is deleted, a grant is
 * revoked. Nothing here hears about any of them, so the only thing that ever
 * takes those copies off the device is `sweep`'s age bound — thirty days, a
 * cache-hygiene number nobody chose as a revocation bound.
 *
 * The console does already hold the answer: the context list the server returns
 * *is* the set of memberships that are still live, recomputed on every
 * subscription tick. A workspace with copies on this device that is not in that
 * list is a context this person can no longer read from the server, and its
 * cached bodies are the copy that outlived the membership.
 *
 * Two hazards decide the shape, and both point the same way:
 *
 *  1. **The list must be known, not merely empty.** `workspaces` is `undefined`
 *     while the subscription is in flight and `[]` for an account that genuinely
 *     has none; purging on either would blank the cache of somebody whose
 *     network is simply slow — which is the one moment the offline copy exists
 *     for. So an empty list purges nothing, and says `unmeasured` rather than
 *     claiming a clear it did not attempt.
 *  2. **Scoped kinds only.** A `note` or a `listing` is a copy of what the
 *     bucket answered and the server can hand it back; a `draft` or an `outbox`
 *     record is somebody's own typing and this device is the only place it
 *     exists. Being wrong in the safe direction costs a cache miss. Being wrong
 *     in the unsafe direction costs unsent work, and somebody whose membership
 *     was revoked mid-write is exactly who would pay it.
 *
 * Stale-version keys stay too, for the reason `keysForWorkspace` takes them and
 * this cannot: a key this version cannot parse cannot be attributed to a
 * workspace at all, so "not in the list" is unanswerable for it. `sweep`
 * deletes that whole set unconditionally on the first mount after an upgrade
 * anyway, so nothing is kept here that anything else was keeping.
 */
describe("contexts that are no longer in the person's list", () => {
  const OTHER_LISTING_KEY = scopedKeyFor("listing", "team", "w2", "1-projects");
  const OTHER_DRAFT_KEY = keyFor("draft", "w2", "1-projects/other.md");
  const OTHER_OUTBOX_KEY = keyFor("outbox", "w2", "");
  const STALE_KEY = `context.lc.offlinev1notew21-projects/old.md`;

  beforeEach(() => {
    mockOpened = store({}, {
      ...SEEDED,
      [OTHER_LISTING_KEY]: JSON.stringify({ value: { entries: [] }, cachedAt: 1 }),
      [OTHER_DRAFT_KEY]: JSON.stringify({
        path: "1-projects/other.md",
        text: "typed",
        baseEtag: null,
      }),
      [OTHER_OUTBOX_KEY]: JSON.stringify({ writes: [] }),
      [STALE_KEY]: "from a shape this version cannot read",
    });
  });

  test("their notes and listings go, and their unsent work stays", async () => {
    expect(await forgetDepartedContexts(["w1"])).toEqual({ verdict: "cleared" });

    expect((await mockOpened.keys()).sort()).toEqual(
      [
        NOTE_KEY,
        DRAFT_KEY,
        OTHER_DRAFT_KEY,
        OTHER_OUTBOX_KEY,
        STALE_KEY,
        "some.other.feature key",
      ].sort(),
    );
    expect(warnings).toEqual([]);
  });

  test("a list that is empty purges nothing at all", async () => {
    // Hazard 1. An empty array is what an account with no contexts and a caller
    // that has not checked both look like, and only one of those may reach a
    // `remove()`.
    const before = (await mockOpened.keys()).sort();
    expect(await forgetDepartedContexts([])).toEqual({ verdict: "unmeasured" });
    expect((await mockOpened.keys()).sort()).toEqual(before);
  });

  test("a context still in the list keeps everything", async () => {
    // The anti-vacuity witness for the test above it: with both workspaces
    // named, `cleared` has to leave every key standing — otherwise "nothing was
    // purged" would also be true of a function that purges nothing ever.
    const before = (await mockOpened.keys()).sort();
    expect(await forgetDepartedContexts(["w1", "w2"])).toEqual({ verdict: "cleared" });
    expect((await mockOpened.keys()).sort()).toEqual(before);
  });

  test("a store that accepts a removal and performs none says so", async () => {
    mockOpened = store(
      { remove: async () => {} },
      { [OTHER_NOTE_KEY]: JSON.stringify({ value: { text: "private" }, cachedAt: 1 }) },
    );

    expect(await forgetDepartedContexts(["w1"])).toEqual({ verdict: "left-behind" });
    expect(warnings).toEqual([
      "[offline] departed contexts: 1 record(s) could not be removed from this device",
    ]);
  });

  test("a store that cannot say what it holds never throws", async () => {
    mockOpened = store({
      keys: async () => {
        throw new Error("nope");
      },
    });

    expect(await forgetDepartedContexts(["w1"])).toEqual({ verdict: "unmeasured" });
    expect(warnings).toEqual([
      "[offline] departed contexts: this device's store could not be read or written",
    ]);
  });

  test("and a store that never answers is bounded like every other clear", async () => {
    jest.useFakeTimers();
    mockOpened = store({ keys: () => new Promise<string[]>(() => {}) });

    const clearing = forgetDepartedContexts(["w1"]);
    let answered = false;
    void clearing.then(() => {
      answered = true;
    });

    await jest.advanceTimersByTimeAsync(CLEAR_DEADLINE_MS - 1);
    expect(answered).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await clearing).toEqual({ verdict: "unmeasured" });
    expect(warnings).toEqual([
      "[offline] departed contexts: this device's store did not answer in time",
    ]);
  });
});
