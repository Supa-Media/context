import { beforeEach, describe, expect, test } from "@jest/globals";
import { memoryStore } from "../features/offline/memory";
import type { KeyValueStore } from "../features/offline/memory";
import {
  MAX_REMEMBERED_CONTEXTS,
  contextHrefFor,
  forgetPlace,
  landingStep,
  lastPathFor,
  placeFor,
  placeHref,
  placeKeys,
  recallPlace,
  recallPlaces,
  rememberPlace,
} from "../features/console/lastPlace";

/**
 * **Relaunching the app lost the file you were reading.**
 *
 * The web has an address bar and `?note=` in it, so a reload is free. A phone
 * launched from the home screen starts at `/`, which resolves to `/console`,
 * which resolved to the first context the account owns — however long somebody
 * had spent in a note before their phone went to sleep.
 *
 * What is asserted here is the record and the rule around it, not the store:
 * the platform halves (`offline/store.ts` / `store.web.ts`) are delegations by
 * design and this suite runs in plain node with no native mocks, so it drives
 * `memoryStore()` through the same `KeyValueStore` port everything else in the
 * offline layer is written against.
 *
 * The security-shaped assertions are the interesting half. A restore is a
 * **navigation**, not a claim: it produces a console URL, and that URL is gated
 * exactly as a typed one is. Nothing here may turn a record on a device into
 * access, into a path the bucket adapter would refuse, or into a note name that
 * outlives a sign-out.
 */

/** The workspace list has arrived. Every case below is about what happens then. */
const LISTED = true;

const CONTEXTS = [
  { slug: "seyi", role: "owner" },
  { slug: "supa", role: "editor" },
];

let store: KeyValueStore;
beforeEach(() => {
  store = memoryStore();
});

/**
 * The log exactly as it sits on the device.
 *
 * Deliberately not `recallPlaces`. That function bounds and de-duplicates on
 * the way out, so it is the wrong instrument for asserting that the *writer*
 * bounds and de-duplicates — it makes a growing file look like a tidy one. See
 * the two tests that say so.
 */
async function storedLog(from: KeyValueStore): Promise<{ slug: string; note: string | null }[]> {
  const raw = await from.get("context.lc.place.v2.visits");
  return raw === null ? [] : JSON.parse(raw);
}

describe("what a device remembers", () => {
  test("a place written comes back", async () => {
    await rememberPlace(store, { slug: "supa", note: "1-projects/a.md" });
    expect(await recallPlace(store)).toEqual({ slug: "supa", note: "1-projects/a.md" });
  });

  test("a context with nothing open is still a place", async () => {
    await rememberPlace(store, { slug: "supa", note: null });
    expect(await recallPlace(store)).toEqual({ slug: "supa", note: null });
  });

  test("a device that knows nothing says so", async () => {
    expect(await recallPlace(store)).toBeNull();
  });

  test("writing again moves the head, and keeps one key", async () => {
    // This used to be "replaces rather than accumulates", and half of it has
    // reversed: the record is a log now, so the previous context is kept
    // *behind* the new one rather than overwritten — that is what lets the
    // strip order itself and what lets switching back restore a path. The half
    // that has not changed is the one that mattered: it is still one key, so
    // nothing accumulates on the device without bound.
    await rememberPlace(store, { slug: "supa", note: "a.md" });
    await rememberPlace(store, { slug: "seyi", note: "b.md" });
    expect(await recallPlace(store)).toEqual({ slug: "seyi", note: "b.md" });
    expect(await recallPlaces(store)).toEqual([
      { slug: "seyi", note: "b.md" },
      { slug: "supa", note: "a.md" },
    ]);
    expect(placeKeys(await store.keys())).toHaveLength(1);
  });

  test("nothing but a slug and a path is stored", async () => {
    /*
      Non-negotiable #1: no credential, and no note content, on a device. The
      assertion is on the serialized record rather than on the interface,
      because the interface is what a future field would be added to — and on
      *every* entry rather than the head, because the log is where a future
      field would arrive unnoticed.
    */
    await rememberPlace(store, { slug: "seyi", note: null });
    await rememberPlace(store, { slug: "supa", note: "1-projects/a.md" });
    const [key] = placeKeys(await store.keys());
    expect(JSON.parse((await store.get(key!))!)).toEqual([
      { slug: "supa", note: "1-projects/a.md" },
      { slug: "seyi", note: null },
    ]);
  });
});

describe("a record read back off a device is not trusted", () => {
  /*
    It is a file this app wrote, and it is a file on a device: a rooted phone, a
    restored backup, a browser console. The path in it becomes a request to
    somebody's bucket, so it goes through `safeNotePath` on the way out exactly
    as a URL does.
  */
  const KEY = "context.lc.place.v1.last";

  test("a traversal path is refused rather than repaired", async () => {
    await store.set(KEY, JSON.stringify({ slug: "supa", note: "../../etc/passwd" }));
    expect(await recallPlace(store)).toBeNull();
  });

  test("a rooted path is refused", async () => {
    await store.set(KEY, JSON.stringify({ slug: "supa", note: "/1-projects/a.md" }));
    expect(await recallPlace(store)).toBeNull();
  });

  test("a slug that would build a different URL than it names is refused", async () => {
    for (const slug of ["../seyi", "supa/settings", "a?b", "@supa", "", "sup a"]) {
      await store.set(KEY, JSON.stringify({ slug, note: null }));
      expect(await recallPlace(store)).toBeNull();
    }
  });

  test("a record that is not a record is refused", async () => {
    for (const raw of ["", "null", "[]", "{", '"supa"', '{"note":"a.md"}', '{"slug":7}']) {
      await store.set(KEY, raw);
      expect(await recallPlace(store)).toBeNull();
    }
  });

  test("a store that throws is a device that knows nothing", async () => {
    const broken: KeyValueStore = {
      ...memoryStore(),
      get: async () => {
        throw new Error("no");
      },
    };
    expect(await recallPlace(broken)).toBeNull();
  });
});

describe("what is worth remembering", () => {
  test("a note in a context this account can reach", () => {
    expect(placeFor(CONTEXTS, "supa", "1-projects/a.md")).toEqual({
      slug: "supa",
      note: "1-projects/a.md",
    });
  });

  test("a context with nothing open, which is still somewhere you were", () => {
    expect(placeFor(CONTEXTS, "supa", null)).toEqual({ slug: "supa", note: null });
  });

  test("not a context this account cannot reach", () => {
    /*
      A `@name` somebody was removed from, or mistyped. The console redirects
      away from it a moment later, so recording it would store a screen nobody
      was on — and would overwrite the record of where they really were, which
      is worse than not writing at all.
    */
    expect(placeFor(CONTEXTS, "gone", "1-projects/a.md")).toBeNull();
  });

  test("not a render that has no context yet", () => {
    expect(placeFor(CONTEXTS, null, "1-projects/a.md")).toBeNull();
    expect(placeFor([], "supa", null)).toBeNull();
  });
});

describe("where a remembered place sends somebody", () => {
  test("to that note in that context", () => {
    expect(placeHref({ slug: "supa", note: "1-projects/a.md" })).toBe(
      "/console/@supa?note=1-projects%2Fa.md",
    );
    expect(placeHref({ slug: "supa", note: null })).toBe("/console/@supa");
  });

  test("a context this account cannot reach is ignored, not followed", () => {
    /*
      Following it would also work — `resolveContextRoute` redirects a dead
      context to the landing — but it would put somebody who lost access through
      a bounce that names the context they lost in the address bar on the way.
    */
    expect(landingStep(CONTEXTS, { slug: "gone", note: "a.md" }, LISTED)).toEqual({
      action: "redirect",
      href: "/console/@seyi",
    });
  });

  test("a place is never a substitute for authorization", () => {
    // The whole surface: a record decides *where*, and membership decides
    // *whether*. An account with no contexts goes to the Map, not to the note.
    expect(landingStep([], { slug: "supa", note: "a.md" }, LISTED)).toEqual({ action: "map" });
  });

  test("the default is unchanged when this device knows nothing", () => {
    // `landingHref`'s rule, not a second one: a context you own, before the
    // first of the list.
    expect(landingStep(CONTEXTS, null, LISTED)).toEqual({
      action: "redirect",
      href: "/console/@seyi",
    });
  });

  test("nothing is painted while a device with contexts in hand is asked", () => {
    /*
      Not the same answer as "this device knows nothing", and the difference is
      a visible one: `map` here would draw the constellation for a frame and
      then redirect out of it, which is the flash `/console` exists to remove.
    */
    expect(landingStep(CONTEXTS, undefined, LISTED)).toEqual({ action: "wait" });
  });

  test("nothing is drawn at all until the workspace list has arrived", () => {
    /**
     * **Filmed on a cold launch of the native app: splash, blank, the Map for
     * one frame, blank, then the note.**
     *
     * The Map frame was this function answering `map` for an empty
     * `contexts` — and on a cold launch `contexts` is empty because nothing
     * has been fetched yet, not because this account has nothing. So what
     * appeared for an eighth of a second was a picture of an account with
     * nothing in it: "0 reachable", "0 connected", a lone "You" node, "0 in
     * your context". Every number in it counted a list that had not arrived.
     *
     * It is also a flicker by construction, whatever the numbers said: for
     * somebody who has contexts the Map is a screen they are about to be
     * redirected out of, so drawing it is a transition that exists only to be
     * undone.
     */
    expect(landingStep([], undefined, false)).toEqual({ action: "wait" });
    expect(landingStep([], null, false)).toEqual({ action: "wait" });
    expect(landingStep([], { slug: "supa", note: "a.md" }, false)).toEqual({ action: "wait" });
    expect(landingStep(CONTEXTS, null, false)).toEqual({ action: "wait" });
  });

  test("but a list that has arrived and is empty is the Map, honestly", () => {
    /**
     * **Reported from a phone: relaunching landed on a blank page.**
     *
     * A cold launch asks the device before the workspace list has landed, and
     * `wait` paints nothing — so the console drew its rail, with the person's
     * own brain selected in it, around an empty pane and held it there for as
     * long as an `AsyncStorage` read took. A bridge is slowest at exactly the
     * moment this runs.
     *
     * `wait` is for the warm state it was written for: contexts in hand, the
     * device answering in a tick, and a `map` that would be a flash on the way
     * to a redirect. With no contexts there is nothing to flash past — the Map
     * is what this route draws anyway until the list arrives.
     */
    expect(landingStep([], undefined, LISTED)).toEqual({ action: "map" });
  });

  test("a place in a context that is reachable wins over the default", () => {
    expect(landingStep(CONTEXTS, { slug: "supa", note: "1-projects/a.md" }, LISTED)).toEqual({
      action: "redirect",
      href: "/console/@supa?note=1-projects%2Fa.md",
    });
  });
});

describe("signing out takes it", () => {
  test("the current record goes", async () => {
    await rememberPlace(store, { slug: "supa", note: "1-projects/a.md" });
    await forgetPlace(store);
    expect(await recallPlace(store)).toBeNull();
    expect(placeKeys(await store.keys())).toEqual([]);
  });

  test("and so does one written by a shape this version cannot read", async () => {
    // A path is the name of one of somebody's notes. Leaving a stale-version
    // record behind on a signed-out device would leave that name on it.
    await store.set("context.lc.place.v0.last", "whatever this used to be");
    await forgetPlace(store);
    expect(placeKeys(await store.keys())).toEqual([]);
  });

  test("and nothing that belongs to somebody else", async () => {
    await store.set("context.lc.offlinev2outboxw1", "{}");
    await store.set("unrelated.app.key", "x");
    await rememberPlace(store, { slug: "supa", note: "a.md" });
    await forgetPlace(store);
    expect((await store.keys()).sort()).toEqual(
      ["context.lc.offlinev2outboxw1", "unrelated.app.key"].sort(),
    );
  });
});

/**
 * **Switching context restored the root, not the note.**
 *
 * The single record answered "where was I", full stop, so `/console` came back
 * to the right note and every *other* context was a fresh start: press `@supa`
 * in the strip, land on its root, walk the tree down to the note you were in
 * ninety seconds ago. On a phone, where the tree is not a column beside you,
 * that is the whole cost of moving between two contexts, paid on every move.
 *
 * The fix is not a second store. Ordering the strip and restoring a path are
 * the same fact — *when was I last in this context, and where* — so the record
 * became a log, most recently visited first, and the old single record is its
 * head. Two stores would have drifted on the first navigation that wrote one
 * and not the other.
 *
 * SABOTAGE (recorded per case below): each rule was reversed in
 * `features/console/lastPlace.ts` and the suite re-run, to confirm the failure
 * lands on the test that names it rather than on a neighbour.
 */
describe("the log is ordered by recency, and it is the strip's order", () => {
  /**
   * SABOTAGE: `rememberPlace` appending (`[...kept, place]`) instead of
   * unshifting. Fails here and in "writing again moves the head" — two tests,
   * both about ordering, which is the right blast radius. Nothing about
   * validation or sign-out moved.
   */
  test("the context you are in is first, and the rest are behind it", async () => {
    await rememberPlace(store, { slug: "one", note: "a.md" });
    await rememberPlace(store, { slug: "two", note: "b.md" });
    await rememberPlace(store, { slug: "three", note: null });
    expect((await recallPlaces(store)).map((place) => place.slug)).toEqual([
      "three",
      "two",
      "one",
    ]);
  });

  /**
   * **Asserted on what is on the device, not on what comes back out.**
   *
   * The first version of this test read through `recallPlaces`, and
   * `recallPlaces` collapses duplicates on the way out — keeping the first,
   * which is the freshly written one — so it went green with the writer's
   * dedupe removed. That is a guard nobody had checked: the read looked
   * perfect while the file on the device grew an entry per navigation forever,
   * which on a phone somebody moves between two contexts on all day is the
   * whole feature leaking. The sanitising reader is worth having *and* is
   * exactly what makes a read-side assertion vacuous here.
   *
   * SABOTAGE: dropped the `filter((entry) => entry.slug !== place.slug)` from
   * `rememberPlace`. Fails here and nowhere else. Re-run with the assertion
   * back on `recallPlaces` instead of the stored record: **passes** — which is
   * the measurement that produced this paragraph.
   */
  test("revisiting a context moves its entry rather than adding a second", async () => {
    await rememberPlace(store, { slug: "one", note: "a.md" });
    await rememberPlace(store, { slug: "two", note: "b.md" });
    await rememberPlace(store, { slug: "one", note: "c.md" });

    expect(await storedLog(store)).toEqual([
      { slug: "one", note: "c.md" },
      { slug: "two", note: "b.md" },
    ]);
    expect(await recallPlaces(store)).toEqual(await storedLog(store));
  });

  /**
   * SABOTAGE: removed the `.slice(0, MAX_REMEMBERED_CONTEXTS)` from
   * `rememberPlace`. Fails here only. Asserted on the stored record for the
   * reason above — `recallPlaces` stops at the same bound, so a read-side
   * assertion passes over an unbounded file.
   */
  test("the device's copy is bounded, and the oldest is what goes", async () => {
    for (let index = 0; index <= MAX_REMEMBERED_CONTEXTS; index += 1) {
      await rememberPlace(store, { slug: `ctx-${index}`, note: null });
    }
    const stored = await storedLog(store);
    expect(stored).toHaveLength(MAX_REMEMBERED_CONTEXTS);
    // The most recent is kept and the first one ever written is the one gone.
    expect(stored[0]!.slug).toBe(`ctx-${MAX_REMEMBERED_CONTEXTS}`);
    expect(stored.some((place) => place.slug === "ctx-0")).toBe(false);
  });

  /**
   * The reader's own bound, which is a different claim from the writer's: this
   * file can be hand-edited, restored from a backup, or written by a version
   * that had no cap, and a read is work done on a screen somebody is waiting
   * for.
   *
   * SABOTAGE: removed the `break` at `MAX_REMEMBERED_CONTEXTS` from
   * `recallPlaces`. Fails here only — the writer's cap never sees this file.
   */
  test("and so is what the reader will take from a file it did not write", async () => {
    const oversized = Array.from({ length: MAX_REMEMBERED_CONTEXTS + 10 }, (_, index) => ({
      slug: `ctx-${index}`,
      note: null,
    }));
    await store.set("context.lc.place.v2.visits", JSON.stringify(oversized));
    expect(await recallPlaces(store)).toHaveLength(MAX_REMEMBERED_CONTEXTS);
  });

  /**
   * SABOTAGE: made `recallPlaces` return `[]` on the first bad entry rather
   * than skipping it. Fails here only.
   */
  test("one unreadable entry costs its own place and not the list", async () => {
    // The single-record version answered `null` to a malformed record, which
    // was the whole answer because the record was the whole store. Here that
    // would cost somebody the order of every context they have.
    await store.set(
      "context.lc.place.v2.visits",
      JSON.stringify([
        { slug: "good", note: "a.md" },
        { slug: "../etc", note: "b.md" },
        { slug: "alsogood", note: null },
      ]),
    );
    expect(await recallPlaces(store)).toEqual([
      { slug: "good", note: "a.md" },
      { slug: "alsogood", note: null },
    ]);
  });

  test("a file that is not a list answers empty rather than guessing", async () => {
    await store.set("context.lc.place.v2.visits", JSON.stringify({ slug: "seyi", note: null }));
    expect(await recallPlaces(store)).toEqual([]);
    expect(await recallPlace(store)).toBeNull();
  });

  test("a store that throws is a device that remembers nothing", async () => {
    const broken: KeyValueStore = {
      ...store,
      get: async () => {
        throw new Error("bridge is wedged");
      },
    };
    expect(await recallPlaces(broken)).toEqual([]);
  });

  test("every entry is still re-validated, not only the head", async () => {
    // The head went through `safeNotePath` before and still does. What is new
    // is that entries *behind* it are now read too — by the strip, on every
    // press — so a traversal path parked in second place is a path that
    // reaches a request to somebody's bucket.
    await store.set(
      "context.lc.place.v2.visits",
      JSON.stringify([
        { slug: "seyi", note: "a.md" },
        { slug: "supa", note: "../../etc/passwd" },
        { slug: "third", note: "/rooted.md" },
      ]),
    );
    expect(await recallPlaces(store)).toEqual([{ slug: "seyi", note: "a.md" }]);
  });
});

describe("where pressing a context sends somebody", () => {
  const PLACES = [
    { slug: "seyi", note: "1-projects/a.md" },
    { slug: "supa", note: null },
  ];

  test("the path they had open there, not that context's root", () => {
    expect(lastPathFor(PLACES, "seyi")).toBe("1-projects/a.md");
    expect(contextHrefFor(PLACES, CONTEXTS, "seyi")).toBe(
      "/console/@seyi?note=1-projects%2Fa.md",
    );
  });

  /**
   * SABOTAGE: dropped the `path === null` guard from `contextHrefFor`, so a
   * context with nothing remembered built `?note=null`. Fails here.
   */
  test("its root when nothing is remembered about it", () => {
    expect(lastPathFor(PLACES, "supa")).toBeNull();
    expect(contextHrefFor(PLACES, CONTEXTS, "supa")).toBe("/console/@supa");
    expect(contextHrefFor([], CONTEXTS, "seyi")).toBe("/console/@seyi");
  });

  /**
   * SABOTAGE: dropped the reachability guard. Fails here only — every other
   * case in this block names a context that is in the list.
   */
  test("its root when the account cannot reach it at all", () => {
    // Belt and braces rather than the boundary — `resolveContextRoute`
    // redirects a dead context and the gateway refuses the read — but it keeps
    // somebody's note name out of the address bar on the way through a
    // redirect they are about to be bounced out of.
    const stale = [{ slug: "gone", note: "1-projects/secret.md" }];
    expect(contextHrefFor(stale, CONTEXTS, "gone")).toBe("/console/@gone");
  });

  /**
   * SABOTAGE, two of them, because this test carries a rule and its negative
   * control. Making the absent predicate default to "does not resolve"
   * (`options.resolves && !options.resolves(path)` → `!options.resolves?.(path)`)
   * fails "the path they had open there" — a caller with no opinion is not a
   * caller saying no. Making `contextHrefFor` ignore the path outright (return
   * `browseHref` at the end) fails *this* test and that one, which is what
   * stops the `resolves: () => false` half from passing by never having worked.
   */
  test("its root when the caller says the path is gone", () => {
    expect(contextHrefFor(PLACES, CONTEXTS, "seyi", { resolves: () => false })).toBe(
      "/console/@seyi",
    );
    expect(contextHrefFor(PLACES, CONTEXTS, "seyi", { resolves: () => true })).toBe(
      "/console/@seyi?note=1-projects%2Fa.md",
    );
  });

  test("a remembered path is a destination, never an authorization", () => {
    // The same rule the landing keeps: this produces a console URL and nothing
    // else. It mints no token, and the URL it produces is gated exactly as a
    // typed one is.
    const href = contextHrefFor(PLACES, CONTEXTS, "seyi");
    expect(href.startsWith("/console/")).toBe(true);
    expect(href).not.toMatch(/token|key|secret|Bearer/i);
  });
});
