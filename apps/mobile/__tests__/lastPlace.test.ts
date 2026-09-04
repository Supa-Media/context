import { beforeEach, describe, expect, test } from "@jest/globals";
import { memoryStore } from "../features/offline/memory";
import type { KeyValueStore } from "../features/offline/memory";
import {
  forgetPlace,
  landingStep,
  placeFor,
  placeHref,
  placeKeys,
  recallPlace,
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

const CONTEXTS = [
  { slug: "seyi", role: "owner" },
  { slug: "supa", role: "editor" },
];

let store: KeyValueStore;
beforeEach(() => {
  store = memoryStore();
});

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

  test("writing again replaces rather than accumulates", async () => {
    await rememberPlace(store, { slug: "supa", note: "a.md" });
    await rememberPlace(store, { slug: "seyi", note: "b.md" });
    expect(await recallPlace(store)).toEqual({ slug: "seyi", note: "b.md" });
    expect(placeKeys(await store.keys())).toHaveLength(1);
  });

  test("nothing but a slug and a path is stored", async () => {
    /*
      Non-negotiable #1: no credential, and no note content, on a device. The
      assertion is on the serialized record rather than on the interface,
      because the interface is what a future field would be added to.
    */
    await rememberPlace(store, { slug: "supa", note: "1-projects/a.md" });
    const [key] = placeKeys(await store.keys());
    expect(JSON.parse((await store.get(key!))!)).toEqual({
      slug: "supa",
      note: "1-projects/a.md",
    });
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
    expect(landingStep(CONTEXTS, { slug: "gone", note: "a.md" })).toEqual({
      action: "redirect",
      href: "/console/@seyi",
    });
  });

  test("a place is never a substitute for authorization", () => {
    // The whole surface: a record decides *where*, and membership decides
    // *whether*. An account with no contexts goes to the Map, not to the note.
    expect(landingStep([], { slug: "supa", note: "a.md" })).toEqual({ action: "map" });
  });

  test("the default is unchanged when this device knows nothing", () => {
    // `landingHref`'s rule, not a second one: a context you own, before the
    // first of the list.
    expect(landingStep(CONTEXTS, null)).toEqual({
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
    expect(landingStep(CONTEXTS, undefined)).toEqual({ action: "wait" });
  });

  test("but a cold launch draws the Map rather than an empty pane", () => {
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
    expect(landingStep([], undefined)).toEqual({ action: "map" });
  });

  test("a place in a context that is reachable wins over the default", () => {
    expect(landingStep(CONTEXTS, { slug: "supa", note: "1-projects/a.md" })).toEqual({
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
