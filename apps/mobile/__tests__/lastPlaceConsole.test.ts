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
 * `contextHrefFrom`. It cannot reach every arm of the rule, because the layout
 * deliberately passes no `resolves` predicate (it has no opinion about another
 * context's tree). The `resolves` arm and the liveness of the log within a
 * session are asserted against the hooks directly, further down.
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

const { resetPlaceCacheForTests, useContextHref, useContextPlaces } =
  require("../features/console/useLastPlace") as typeof import("../features/console/useLastPlace");

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
