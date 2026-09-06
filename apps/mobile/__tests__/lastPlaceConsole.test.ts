/**
 * @jest-environment jsdom
 */

/**
 * **SWITCHING CONTEXT COMES BACK TO WHERE YOU WERE.**
 *
 * That sentence is the whole user-visible payoff of the per-context last-path
 * work, and until this file it had **no test anywhere**. `lastPlace.test.ts`
 * proves the *rules* — `contextHrefFor` picks the remembered path, falls back
 * three ways, and a record is a destination rather than a claim — and it proves
 * them about a pure function nothing in the app had to be wired to.
 *
 * The wiring is one line in `app/(app)/console/_layout.tsx`:
 *
 *     onOpen={(slug) => router.replace(contextHrefFrom(slug))}
 *
 * Replace `contextHrefFrom` there with `browseHref` — a one-word edit, and the
 * tidy-looking one, since `browseHref` is already imported and a reader who has
 * not met the log would call it the obvious answer — and every pill on the
 * strip drops you at the root of the context it names. The feature is gone.
 * Before this file, **the suite stayed green**: `useContextPlaces` and
 * `useContextHref` had zero hits in `__tests__`, and the one test that mounts
 * this layout at a phone width (`consoleChrome.test.ts`) stubs the router as
 * `{ replace: () => {}, push: () => {} }`, which records nothing and can
 * therefore observe nothing about where a press sends you.
 *
 * So the router here **records**, and the assertions are about the strings it
 * was handed.
 *
 * ## Two rooms, and both are needed
 *
 * The console mount below is the room the mutant lives in — it is the only
 * place that knows a pill press becomes a `router.replace` of a
 * `contextHrefFrom`, and the only place that knows the strip's order comes from
 * `recent={places}`. It cannot reach every arm of the rule, because the layout
 * deliberately passes no `resolves` predicate (it has no opinion about another
 * context's tree). The `resolves` arm, and everything the log does *within* a
 * session — a navigation moves it now rather than on the next launch, it is
 * read once per session rather than once per mount, and a sign-out takes it out
 * of module memory — are asserted against the hooks directly, further down.
 *
 * **That last sentence used to be a claim rather than a description.** It said
 * the liveness of the log within a session was asserted against the hooks
 * "further down"; it was not. `useRememberPlace` had no test anywhere, so
 * deleting the `publishPlaces` call inside it — which is the whole of "the
 * screen is updated first and the device catches up" — left all 3343 tests
 * green while the strip stopped reordering. The five tests under `the log is
 * live within a session, and only within one` are what make the sentence true.
 *
 * ## What is not asserted here
 *
 * That the destination *renders*. `router.replace` is a stub; nothing navigates.
 * What a real navigation then does with the URL — gate it, refuse it, redirect a
 * context the account cannot reach — is `resolveContextRoute`'s and is covered
 * where that lives. A record is a destination, never an authorization, and
 * `lastPlace.test.ts` is where that is held.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
/** Every href the layout asked the router to go to, in order. */
const mockReplaced: string[] = [];
const mockPushed: string[] = [];

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock("expo-router", () => ({
  Slot: () => null,
  useRouter: () => ({
    replace: (href: string) => mockReplaced.push(href),
    push: (href: string) => mockPushed.push(href),
  }),
  usePathname: () => "/console/@seyi",
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

/**
 * One store for the whole file, so a test can seed the device before mounting.
 *
 * `memoryStore()` through the same `KeyValueStore` port everything in
 * `features/offline` is written against — the platform halves are delegations
 * by design and this suite has no native mocks (`lastPlaceDeadline.test.ts`
 * takes the same route for the same reason).
 */
const mockStore = (
  require("../features/offline/memory") as typeof import("../features/offline/memory")
).memoryStore();

jest.mock("../features/offline/store", () => ({ openStore: () => mockStore }));

// The layout is what is under test; its data source is not.
jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

/**
 * Three contexts, because one cannot show that two keep separate paths.
 *
 * `@acme` is deliberately never written to the log: it is the "first visit"
 * case, and a strip with only remembered contexts on it could not tell a
 * working fallback from a fallback that fires for everybody.
 */
function mockConsoleData(): never {
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: null,
    select: () => {},
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    conflict: null,
    resolveWith: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    toasts: [],
    dismissToast: () => {},
    clipboard: null,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    createNote: () => {},
    createFolder: () => {},
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
  };

  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@example.invalid", initial: "S" },
    contexts: [
      { id: "w1", slug: "seyi", displayName: "Seyi", role: "owner", kind: "personal", status: "ok" },
      { id: "w2", slug: "supa", displayName: "Supa", role: "editor", kind: "shared", status: "ok" },
      { id: "w3", slug: "acme", displayName: "Acme", role: "member", kind: "shared", status: "ok" },
    ],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: {
      connected: true,
      status: "connected",
      provider: "Cloudflare R2",
      bucket: "example-bucket",
      endpoint: "https://example.invalid",
      region: "auto",
      accessKey: "EXAMPLEKEY",
      conditionalWrite: true,
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@example.invalid",
    ingestion: { settings: null, loading: false },
    files,
    fastSearch: { status: null, loading: false },
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

const { resetPlaceCacheForTests, useContextHref, useContextPlaces, useRememberPlace } =
  require("../features/console/useLastPlace") as typeof import("../features/console/useLastPlace");

/**
 * The real sign-out, not a hand-bumped counter.
 *
 * `forgetLocalCopies` is what production calls, and the ordering claim under
 * test — the epoch is ended *before* anything is removed — is a fact about that
 * function rather than about `endSession`. Driving the real one is the same
 * choice `offlineForget.test.ts` makes and for the same reason.
 */
const { forgetLocalCopies } =
  require("../features/offline/forget") as typeof import("../features/offline/forget");
const { recallPlaces } =
  require("../features/console/lastPlace") as typeof import("../features/console/lastPlace");

const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/* -------------------------------------------------------------------------- */
/*                                  harness                                   */
/* -------------------------------------------------------------------------- */

const live: Array<() => void> = [];

beforeEach(async () => {
  mockReplaced.length = 0;
  mockPushed.length = 0;
  // The log is module state that outlives one test's mount, and it is read once
  // per *session* rather than once per mount — so without this the second case
  // in this file would be answering with the first case's device.
  resetPlaceCacheForTests();
  for (const key of await mockStore.keys()) await mockStore.remove(key);
});

afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

/** Write the device's log directly, as `rememberPlace` would have left it. */
async function seedLog(places: ReadonlyArray<{ slug: string; note: string | null }>) {
  await mockStore.set("context.lc.place.v2.visits", JSON.stringify(places));
}

interface Mounted {
  find: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  /** The context pills, in the order the strip drew them. */
  pills: () => string[];
}

/**
 * The console at a phone width, with the log already read.
 *
 * 390pt, because the context strip is compact-only — a pointer layout reaches
 * other contexts through the rail, which is a different control with a
 * different handler (`onSelect`). Awaited past the store read, because
 * `useContextPlaces` is async on every platform and a strip pressed before the
 * device has answered is a strip whose hrefs are all roots — which is the
 * mutant's answer, arrived at honestly.
 */
async function mountConsole(): Promise<Mounted> {
  // react-native-web measures `document.documentElement.clientWidth`, which
  // jsdom reports as 0 — see `appFrameRender.test.ts` for the full trap.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 390,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 844,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });

  await act(async () => {
    root.render(createElement(ConsoleLayout as never));
  });
  await settle();

  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  const find = (testID: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);

  return {
    find,
    pills: () =>
      [...container.querySelectorAll<HTMLElement>('[data-testid^="context-strip-"]')]
        .map((node) => node.dataset.testid!.slice("context-strip-".length))
        // The scroller, the claim and create verbs, and the fade share the
        // prefix and are not contexts.
        .filter((slug) => ["seyi", "supa", "acme"].includes(slug)),
    press: (testID) => {
      const node = find(testID);
      if (node === null) throw new Error(`no element with testID ${testID}`);
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

/** Let the store's promise chain and the render it causes both finish. */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/* -------------------------------------------------------------------------- */
/*        the wiring: a press on the strip, and where the router is sent       */
/* -------------------------------------------------------------------------- */

describe("pressing a context in the strip goes back to where you were in it", () => {
  /**
   * The one the mutant deletes.
   *
   * SABOTAGE: `router.replace(contextHrefFrom(slug))` →
   * `router.replace(browseHref(slug))` in `_layout.tsx`. MEASURED: fails this
   * test and `two contexts are two places, not one shared cursor`; before this
   * file it failed nothing in the suite.
   */
  test("a remembered context opens at the note that was open in it", async () => {
    await seedLog([
      { slug: "supa", note: "1-projects/gateway.md" },
      { slug: "seyi", note: "2-areas/reading.md" },
    ]);

    const app = await mountConsole();
    app.press("context-strip-supa");

    expect(mockReplaced).toEqual(["/console/@supa?note=1-projects%2Fgateway.md"]);
  });

  /**
   * The negative control, and it is what stops the test above passing on an
   * implementation that simply appends `?note=` to everything.
   */
  test("a context this device has never been in opens at its root", async () => {
    await seedLog([{ slug: "supa", note: "1-projects/gateway.md" }]);

    const app = await mountConsole();
    app.press("context-strip-acme");

    expect(mockReplaced).toEqual(["/console/@acme"]);
  });

  /**
   * The reason the record is a *log* rather than one entry.
   *
   * A single stored place would pass "a remembered context opens at the note
   * that was open in it" and then hand `@supa`'s note to `@acme`, which is
   * somebody's private path leaking into a URL for a context it does not belong
   * to. Two presses, two different answers, in one mount.
   */
  test("two contexts are two places, not one shared cursor", async () => {
    await seedLog([
      { slug: "supa", note: "1-projects/gateway.md" },
      { slug: "acme", note: "3-resources/onboarding.md" },
    ]);

    const app = await mountConsole();
    app.press("context-strip-supa");
    app.press("context-strip-acme");

    expect(mockReplaced).toEqual([
      "/console/@supa?note=1-projects%2Fgateway.md",
      "/console/@acme?note=3-resources%2Fonboarding.md",
    ]);
  });

  /**
   * A device that has been rooted, restored from a backup, or shared with
   * another app is a device whose log is *input*.
   *
   * `recallPlaces` re-validates every entry through `safeNotePath` on the way
   * out, and this is that rule reaching the URL the console actually navigates
   * to: a traversal in the record must never become a traversal in a request to
   * somebody's bucket. The entry is dropped, not repaired, so the press lands
   * on the root — which is a working switch rather than a refusal.
   */
  /**
   * **The log is what the strip is ordered by, and nothing was holding that.**
   *
   * SABOTAGE: `recent={places}` → `recent={[]}` in `_layout.tsx` — a one-word
   * edit that reads as a tidy-up, since the strip is perfectly happy with an
   * empty list and the pills all still work. MEASURED: this test fails; before
   * it, all 3343 passed. `contextStrip.test.ts` proves `stripOrder` sorts by
   * `recent`, about a pure function nothing had to be wired to, which is the
   * same shape of hole this file was written for.
   *
   * The order is `stripOrder`'s: the context on screen is pinned first, then
   * the visited ones most-recent-first, then the ones this device has never
   * been in, keeping the control plane's order among themselves. So a log that
   * puts `@acme` in front of `@supa` has to reverse the two, and only the log
   * can do that — the control plane's list has them the other way round.
   */
  test("the strip is ordered by the log, not by the order the contexts arrived", async () => {
    await seedLog([
      { slug: "acme", note: "3-resources/onboarding.md" },
      { slug: "supa", note: "1-projects/gateway.md" },
    ]);

    const app = await mountConsole();

    expect(app.pills()).toEqual(["seyi", "acme", "supa"]);
  });

  test("a context this device has never been in sorts behind every one it has", async () => {
    // The negative control for the test above: with only `@supa` remembered,
    // `@acme` falls in behind it rather than staying where it was.
    await seedLog([{ slug: "supa", note: "1-projects/gateway.md" }]);

    const app = await mountConsole();

    expect(app.pills()).toEqual(["seyi", "supa", "acme"]);
  });

  test("a path the device should not have been holding does not reach the URL", async () => {
    await seedLog([{ slug: "supa", note: "../../etc/passwd" }]);

    const app = await mountConsole();
    app.press("context-strip-supa");

    expect(mockReplaced).toEqual(["/console/@supa"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                      the hooks the layout is holding                       */
/* -------------------------------------------------------------------------- */

/**
 * Mount a bare probe over the hooks, with no console around it.
 *
 * The arms below are ones the console cannot reach: the layout passes no
 * `resolves` predicate, and there is no way to press a pill for a context the
 * strip does not draw.
 */
function probe<T>(use: () => T): { seen: T[] } {
  const seen: T[] = [];
  function Probe() {
    seen.push(use());
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(Probe)));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { seen };
}

describe("the hooks behind it", () => {
  const CONTEXTS = [{ slug: "seyi" }, { slug: "supa" }];

  test("the log the strip is ordered by is what the device holds", async () => {
    await seedLog([{ slug: "supa", note: "a.md" }, { slug: "seyi", note: null }]);
    const { seen } = probe(useContextPlaces);
    // Empty for the tick the read takes — the strip draws the control plane's
    // order rather than nothing, which is why this is not an error state.
    expect(seen[0]).toEqual([]);
    await settle();
    expect(seen[seen.length - 1]).toEqual([
      { slug: "supa", note: "a.md" },
      { slug: "seyi", note: null },
    ]);
  });

  /**
   * The third fallback, which only a caller with its own tree can trigger.
   *
   * `resolves` is optional on purpose — a caller with no opinion is not a
   * caller saying no, and defaulting to "gone" would send every switch to the
   * root, which is the behaviour the whole log exists to end. So both answers
   * are asserted from one mount: the same slug, once with a predicate that says
   * yes and once with one that says no.
   */
  test("a path the caller can no longer see falls back to the root", async () => {
    await seedLog([{ slug: "supa", note: "1-projects/gateway.md" }]);
    const { seen } = probe(() => useContextHref(CONTEXTS));
    await settle();
    const hrefFor = seen[seen.length - 1]!;

    expect(hrefFor("supa")).toBe("/console/@supa?note=1-projects%2Fgateway.md");
    expect(hrefFor("supa", { resolves: () => true })).toBe(
      "/console/@supa?note=1-projects%2Fgateway.md",
    );
    expect(hrefFor("supa", { resolves: () => false })).toBe("/console/@supa");
  });

  /**
   * A slug the account cannot reach answers the root, and does not put the
   * remembered note name into the address bar on the way through the redirect.
   *
   * Belt and braces rather than the boundary — `resolveContextRoute` bounces
   * the URL either way — and it is the same reason `landingStep` ignores such a
   * record rather than following it.
   */
  test("a context that is no longer in the list is a root, not a note", async () => {
    await seedLog([{ slug: "gone", note: "1-projects/secret.md" }]);
    const { seen } = probe(() => useContextHref(CONTEXTS));
    await settle();
    expect(seen[seen.length - 1]!("gone")).toBe("/console/@gone");
  });
});

/* -------------------------------------------------------------------------- */
/*              the log within a session, which nothing was holding            */
/* -------------------------------------------------------------------------- */

/**
 * **Three guards that were true of the code and asserted by nothing.**
 *
 * `useLastPlace.ts` argues each of them at length in prose. Each was deletable
 * with the whole suite green, which is what `docs/decisions/testing.md` means
 * by "a guard nobody has checked is not a guard".
 *
 *  1. `publishPlaces(...)` inside `useRememberPlace`. Delete it and the
 *     per-context memory stops updating on screen — the strip keeps whatever
 *     order it read at launch and the switcher sends you to the note you had
 *     open two navigations ago. Nothing noticed. This is the owner's own
 *     feature.
 *  2. The `snapshot.epoch === currentEpoch()` half of `currentPlaces`. Drop it
 *     and one account's context slugs and note names survive a sign-out in
 *     module memory, to be handed to whoever signs in next on that process.
 *  3. The once-per-session guards in `useContextPlaces`, of which there are
 *     two: the early return that stops a second mount asking the device at
 *     all, and the condition around `publishPlaces` that stops a late answer
 *     landing on top of what this session has since recorded. Drop the second
 *     and a second mount overwrites the session's own log with the device's
 *     older copy. Drop the first and nothing observable changes — the inner
 *     condition still refuses the publish — which is why the third test counts
 *     the reads as well as asserting the value: what the early return buys is
 *     the read, and a guard with nothing measuring it is not a guard.
 */
describe("the log is live within a session, and only within one", () => {
  /**
   * Record a visit, the way `console/[slug]/index.tsx` does.
   *
   * Mounted *after* the strip's own read has landed, which is the order the
   * console produces: the layout mounts, the device answers, and only then does
   * anybody navigate. Mounting the two together instead races the write against
   * the read — the write wins, publishes over an empty log, and the device's
   * answer is then discarded by the once-per-session guard. That is real
   * behaviour on a cold launch and it is not what this test is about.
   */
  function visit(place: { slug: string; note: string | null }) {
    function Writer() {
      useRememberPlace(place);
      return null;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Writer)));
    live.push(() => {
      act(() => root.unmount());
      container.remove();
    });
  }

  /**
   * SABOTAGE: delete the `publishPlaces([...])` call in `useRememberPlace`,
   * keeping the `rememberPlace` write. MEASURED: this test fails on the screen
   * assertion and passes on the device one, which is exactly the split the
   * hook's own comment claims — and before this test, nothing failed at all.
   */
  test("a navigation moves the strip's log now, not on the next launch", async () => {
    await seedLog([
      { slug: "supa", note: "1-projects/gateway.md" },
      { slug: "seyi", note: null },
    ]);
    const { seen } = probe(useContextPlaces);
    await settle();

    visit({ slug: "acme", note: "3-resources/onboarding.md" });
    await settle();

    // The screen: the context just visited is first, and the rest keep their
    // order behind it. `rememberPlace`'s rule, applied to the copy on screen.
    expect(seen[seen.length - 1]).toEqual([
      { slug: "acme", note: "3-resources/onboarding.md" },
      { slug: "supa", note: "1-projects/gateway.md" },
      { slug: "seyi", note: null },
    ]);

    // And the device caught up, which is the copy that survives the process.
    expect(await recallPlaces(mockStore)).toEqual([
      { slug: "acme", note: "3-resources/onboarding.md" },
      { slug: "supa", note: "1-projects/gateway.md" },
      { slug: "seyi", note: null },
    ]);
  });

  /**
   * SABOTAGE: `currentPlaces` returns `snapshot.places` whenever `snapshot` is
   * not `null`, dropping the epoch comparison. MEASURED: this test fails with
   * the previous account's slug and note name in the received value.
   *
   * The mount after the sign-out is the whole point: `useSyncExternalStore`
   * calls `currentPlaces` for its first render, so a stale snapshot is not a
   * frame of wrong ordering — it is one person's private path names handed
   * straight to the next person's strip.
   */
  test("a sign-out takes the log out of module memory, not only off the device", async () => {
    await seedLog([{ slug: "supa", note: "1-projects/gateway.md" }]);
    const first = probe(useContextPlaces);
    await settle();
    expect(first.seen[first.seen.length - 1]).toEqual([
      { slug: "supa", note: "1-projects/gateway.md" },
    ]);

    await forgetLocalCopies();

    const next = probe(useContextPlaces);
    // The *first* value, before any effect has run.
    expect(next.seen[0]).toEqual([]);
    await settle();
    expect(next.seen[next.seen.length - 1]).toEqual([]);
  });

  /**
   * SABOTAGE, both arms:
   *
   *  - delete the `if (snapshot !== null && snapshot.epoch === currentEpoch())
   *    return;` early return. MEASURED: the read count fails — two mounts, two
   *    reads. Nothing else moves, because the inner condition still refuses the
   *    publish; that is the whole reason the count is here.
   *  - widen the publish to `if (live) publishPlaces(answer)`. MEASURED: the
   *    value fails — the second mount replaces the session's log with the
   *    device's.
   *
   * The device is made to disagree here rather than raced into disagreeing.
   * The real shape is a fire-and-forget write that has not landed yet, which no
   * test can pin deterministically; what both have in common, and what this
   * asserts, is that a second mount inside one session answers with what the
   * session knows rather than going back to the device for it.
   */
  test("the device is read once per session, not once per mount", async () => {
    await seedLog([
      { slug: "supa", note: "1-projects/gateway.md" },
      { slug: "seyi", note: null },
    ]);

    const read: string[] = [];
    const get = mockStore.get.bind(mockStore);
    const spy = jest
      .spyOn(mockStore, "get")
      .mockImplementation(async (key: string) => {
        read.push(key);
        return get(key);
      });
    live.push(() => spy.mockRestore());

    const first = probe(useContextPlaces);
    await settle();
    expect(read).toHaveLength(1);

    // The device is made to say something else, standing in for the copy this
    // session has already moved past.
    await seedLog([{ slug: "acme", note: "3-resources/onboarding.md" }]);

    const second = probe(useContextPlaces);
    await settle();

    expect(second.seen[second.seen.length - 1]).toEqual([
      { slug: "supa", note: "1-projects/gateway.md" },
      { slug: "seyi", note: null },
    ]);
    // Both mounts are looking at one list, which is what makes it a session's
    // answer rather than a component's.
    expect(first.seen[first.seen.length - 1]).toEqual(second.seen[second.seen.length - 1]);
    // And the second mount never asked. `seedLog` writes rather than reads, so
    // every entry here is `useContextPlaces` going to the device.
    expect(read).toHaveLength(1);
  });

  /**
   * **An answer that arrives after the session ended does not land.**
   *
   * The read is a bridge call on a device and nothing cancels it, which is
   * `epoch.ts`'s whole argument: a store handle stays perfectly usable after a
   * sign-out, so a read started before the press can resolve arbitrarily long
   * after it. Here that answer would be published into module memory *behind*
   * the clear — one person's context slugs and note names, handed to the strip
   * the next person sees.
   *
   * This is the arm the two tests above cannot reach. Deleting the early return
   * fails the read count; deleting the epoch comparison in `currentPlaces`
   * fails the sign-out test; widening the `publishPlaces` condition to
   * `if (live)` breaks neither, because the early return means the read never
   * happens on the second mount at all. The only way to reach it is to hold the
   * device's answer open across the sign-out, which is what the deferred below
   * does — and it is the real shape rather than a contrivance.
   *
   * SABOTAGE: `if (live) publishPlaces(answer)`. MEASURED: this test fails with
   * the ended session's log in the received value.
   */
  test("a device answer that resolves after a sign-out is dropped, not published", async () => {
    await seedLog([{ slug: "supa", note: "1-projects/gateway.md" }]);

    let release: (() => void) | null = null;
    const get = mockStore.get.bind(mockStore);
    const spy = jest.spyOn(mockStore, "get").mockImplementation((key: string) => {
      // Only the first read is held; see the test below for what holding every
      // read costs. And the answer is taken *now*, while the session is still
      // live: a read issued after the clear would answer `null`, and this test
      // would then pass on an empty log rather than on a dropped one.
      if (release !== null) return get(key);
      const answered = get(key);
      return new Promise<string | null>((resolve) => {
        release = () => void answered.then(resolve);
      });
    });
    live.push(() => spy.mockRestore());

    const { seen } = probe(useContextPlaces);
    await settle();
    // Still in flight: nothing has been published, and the strip is empty.
    expect(seen[seen.length - 1]).toEqual([]);

    await forgetLocalCopies();
    spy.mockRestore();

    // ...and now the device answers, with the log of the session that ended.
    act(() => release!());
    await settle();

    expect(seen[seen.length - 1]).toEqual([]);
  });

  /**
   * **A read still in flight does not undo a navigation made while it flew.**
   *
   * The third arm, and the one the early return cannot cover: it only fires
   * once there *is* a snapshot, and on a cold console there is not one until
   * the first read lands. So a navigation recorded in between — which publishes
   * immediately, by design — would be overwritten by the device's older answer
   * arriving a moment later, and the strip would put the context somebody is
   * standing in third.
   *
   * SABOTAGE: delete `if (snapshot !== null && snapshot.epoch === epoch)
   * return;`. MEASURED: this test fails; the visit is gone from the log.
   */
  test("a navigation made while the device is still answering is not overwritten", async () => {
    await seedLog([{ slug: "supa", note: "1-projects/gateway.md" }]);

    /*
      Only the *first* read is held. `rememberPlace` reads the log too, on its
      way to prepending to it, so a spy that held every read would hand the
      handle to that one instead and the read under test would never be
      released — a test that passed because nothing happened.
    */
    let release: (() => void) | null = null;
    const get = mockStore.get.bind(mockStore);
    const spy = jest.spyOn(mockStore, "get").mockImplementation((key: string) => {
      if (release !== null) return get(key);
      const answered = get(key);
      return new Promise<string | null>((resolve) => {
        release = () => void answered.then(resolve);
      });
    });
    live.push(() => spy.mockRestore());

    const { seen } = probe(useContextPlaces);
    await settle();

    // Somebody navigates while the read is still out.
    visit({ slug: "acme", note: "3-resources/onboarding.md" });
    await settle();
    expect(seen[seen.length - 1]).toEqual([{ slug: "acme", note: "3-resources/onboarding.md" }]);

    spy.mockRestore();
    act(() => release!());
    await settle();

    expect(seen[seen.length - 1]).toEqual([{ slug: "acme", note: "3-resources/onboarding.md" }]);
  });
});
