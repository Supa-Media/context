/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Sign-out, at the press that performs it.
 *
 * `offlineStore.test.ts` already proves `forgetEverything` empties a store, and
 * `offlineSync.test.ts` already pins the words `signOutWarning` returns. Both
 * were green while **nothing in the app called either function**, which is the
 * exact shape `fileErrorCallSites.test.ts` was written about: a well-tested
 * pure module beside an unheld call site manufactures the appearance of
 * coverage, and the screen never consults it.
 *
 * So this file presses the real button in the real layout, and asserts on the
 * real `localStorage` — no store stub, for the reason `offlineStore.test.ts`
 * gives for the same choice: a test that faked the browser's storage would be
 * testing the fake.
 *
 * Two things are being held, and they are different failures:
 *
 *  - **What is left on the device.** A cached note body is the customer's
 *    private content, keyed by workspace and by nothing about *who* read it.
 *    Left behind, the next person to sign in on that machine who is a `team`
 *    member of the same context reads notes their grant never covered — and a
 *    surviving outbox drains the previous person's typing into the bucket
 *    under the new person's session.
 *  - **What the person is told before it goes.** Sign-out discards the queue
 *    deliberately (see `forgetEverything`), so it is the last moment anybody
 *    can be warned that edits which never reached the bucket are about to stop
 *    existing.
 *
 * The ordering assertion is the load-bearing half of the first: the snapshot is
 * taken *inside* the mocked `signOut`, so a clear that merely started is not
 * enough to pass.
 */

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const mockReplaced: string[] = [];

jest.mock("expo-router", () => ({
  Slot: () => null,
  useRouter: () => ({
    replace: (href: string) => {
      mockReplaced.push(href);
    },
    push: () => {},
  }),
  usePathname: () => "/console/@seyi",
}));

/**
 * The auth client, standing in for the end of the session.
 *
 * `signOut` records what this feature still owns *at the moment it is called*,
 * which is what makes "clears on sign-out" a statement about ordering rather
 * than about eventual consistency. A clear that lands after the session has
 * gone is a clear that raced the next person's sign-in.
 */
let signOutCalls = 0;
let ownedAtSignOut: string[] | null = null;

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signOut: async () => {
      signOutCalls += 1;
      ownedAtSignOut = mockOwnedNow();
    },
  }),
}));

jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");
const keys = require("../features/offline/keys") as typeof import("../features/offline/keys");
const cache = require("../features/offline/cache") as typeof import("../features/offline/cache");
const { emptyOutbox, enqueue } =
  require("../features/offline/outbox") as typeof import("../features/offline/outbox");

type OutboxCounts = import("../features/offline/outbox").OutboxCounts;
type OpenNote = import("../features/console/files/types").OpenNote;

const NO_WRITES: OutboxCounts = { pending: 0, conflicted: 0, rejected: 0 };

let counts: OutboxCounts = NO_WRITES;

function mockConsoleData(): never {
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {},
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: null,
    select: () => {},
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
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
    sync: { reachability: "online", counts, durable: true },
  };

  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    contexts: [
      {
        id: "w1",
        slug: "seyi",
        displayName: "Seyi",
        role: "owner",
        kind: "personal",
        status: "ok",
      },
    ],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: null,
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files,
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/* -------------------------------------------------------------------------- */

function allKeys(): string[] {
  const found: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) found.push(key);
  }
  return found;
}

/**
 * Only the keys this feature owns — the set `forgetEverything` answers for.
 *
 * `mock`-prefixed because the `signOut` factory above calls it, and jest
 * refuses any other out-of-scope name inside a `jest.mock` factory. `ownedNow`
 * is the name the assertions read with.
 */
function mockOwnedNow(): string[] {
  return keys.ownedKeys(allKeys());
}

const ownedNow = mockOwnedNow;

function note(path: string, text: string): OpenNote {
  return {
    path,
    text,
    etag: "e1",
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

/**
 * A device holding what a signed-in session leaves behind.
 *
 * `cached` is the half that is nobody's typing — a note body read at
 * **private** tier by its owner, and a folder listing. `typed` is the half that
 * is: a draft, and a queue in a context that is *not* the one on screen. They
 * are seeded separately because they are two different questions — what has to
 * be deleted, and what has to be mentioned before it is.
 */
async function seedDevice(what: { cached?: boolean; typed?: boolean } = {}) {
  const store =
    require("../features/offline/store.web") as typeof import("../features/offline/store.web");
  const opened = store.openStore();

  if (what.cached !== false) {
    await cache.putNote(opened, "w1", note("1-projects/pay.md", "salary numbers"), 1);
    await cache.putListing(
      opened,
      "w1",
      { path: "", folderDefault: "private", entries: [], truncated: false, manifestUsable: true },
      1,
    );
  }

  if (what.typed === true) {
    await cache.putDraft(opened, "w1", {
      path: "1-projects/pay.md",
      text: "half typed",
      baseEtag: "e1",
      savedAt: 1,
    });
    await cache.putOutbox(
      opened,
      enqueue(emptyOutbox("w2"), {
        path: "2-areas/other.md",
        text: "queued in a context that is not on screen",
        baseEtag: null,
        now: 1,
      }),
    );
  }

  window.localStorage.setItem("some.other.feature key", "not ours");
}

function mountConsole(width = 1440) {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(createElement(ConsoleLayout as never));
  });

  const press = async (node: HTMLElement | null) => {
    if (node === null) throw new Error("nothing to press");
    await act(async () => {
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    /*
      The handler is a chain of awaits over an asynchronous store, so a fixed
      number of microtask flushes is a guess that will be wrong the day one more
      `await` is added. A macrotask turn drains the whole queue, and the loop is
      there so a render scheduled by the last resolution gets its own turn.
    */
    for (let turn = 0; turn < 4; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };

  return {
    /*
      `document.body`, not the container: `Confirm` is a `Modal`, and
      react-native-web renders one through a portal outside the tree it was
      declared in. Asserting on the container's text would report every dialog
      in this app as absent — which is what the first draft of this file did.
    */
    text: () => document.body.textContent ?? "",
    find: (testId: string) =>
      document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    byLabel: (label: string) =>
      document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`),
    press,
    signOut: () =>
      press(document.body.querySelector<HTMLElement>('[data-testid="rail-sign-out"]')),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  signOutCalls = 0;
  ownedAtSignOut = null;
  mockReplaced.length = 0;
  counts = NO_WRITES;
});

/* -------------------------------------------------------------------------- */

describe("signing out takes the notes off the device", () => {
  test("nothing this feature owns survives the press", async () => {
    await seedDevice();
    expect(ownedNow().length).toBeGreaterThan(0);

    const app = mountConsole();
    await app.signOut();

    expect(signOutCalls).toBe(1);
    expect(ownedNow()).toEqual([]);
    app.unmount();
  });

  test("and it is gone before the session ends, not after", async () => {
    /*
      The half that matters on a shared machine. A clear that merely *started*
      before `signOut` leaves a window in which the next person's sign-in races
      the previous person's note bodies — and the drain effect in
      `useOfflineNotes` fires the moment a queue and a connection exist, with
      no idea whose session it is writing under.
    */
    await seedDevice();

    const app = mountConsole();
    await app.signOut();

    expect(ownedAtSignOut).toEqual([]);
    app.unmount();
  });

  test("another feature's keys on the same origin are not ours to delete", async () => {
    await seedDevice();

    const app = mountConsole();
    await app.signOut();

    expect(window.localStorage.getItem("some.other.feature key")).toBe("not ours");
    app.unmount();
  });

  test("a device with nothing on it signs out without a question", async () => {
    // The anti-vacuity witness for the block below: the dialog has to be
    // absent when there is nothing waiting, or "it asked first" proves nothing.
    await seedDevice({ cached: false });

    const app = mountConsole();
    await app.signOut();

    expect(signOutCalls).toBe(1);
    expect(app.text()).not.toContain("edits that have not reached your bucket");
    app.unmount();
  });
});

/* -------------------------------------------------------------------------- */

describe("signing out with work that never reached the bucket", () => {
  test("asks first, and does not end the session behind the question", async () => {
    counts = { pending: 2, conflicted: 0, rejected: 0 };
    await seedDevice();

    const app = mountConsole();
    await app.signOut();

    expect(signOutCalls).toBe(0);
    expect(app.text()).toContain("2 notes have edits that have not reached your bucket");
    // Nothing has been discarded while the question is open, either.
    expect(ownedNow().length).toBeGreaterThan(0);
    app.unmount();
  });

  test("cancelling leaves the session and the device exactly as they were", async () => {
    counts = { pending: 1, conflicted: 0, rejected: 0 };
    await seedDevice();
    const before = ownedNow().sort();

    const app = mountConsole();
    await app.signOut();
    await app.press(app.byLabel("Cancel"));

    expect(signOutCalls).toBe(0);
    expect(ownedNow().sort()).toEqual(before);
    app.unmount();
  });

  test("confirming signs out, and the queue goes with it", async () => {
    counts = { pending: 1, conflicted: 1, rejected: 0 };
    await seedDevice({ typed: true });

    const app = mountConsole();
    await app.signOut();
    await app.press(app.byLabel("Sign out and discard"));

    expect(signOutCalls).toBe(1);
    expect(ownedAtSignOut).toEqual([]);
    app.unmount();
  });

  test("a queue in a context that is not on screen is still worth a sentence", async () => {
    /*
      `forgetEverything` takes every context's queue and every draft, not the
      open context's, so a warning built only from `files.sync.counts` would
      discard work it never mentioned — silently, and for exactly the context
      nobody has looked at this session. The seed puts a queue in `w2` and a
      draft in `w1`; the console's own queue is empty.
    */
    counts = NO_WRITES;
    await seedDevice({ typed: true });

    const app = mountConsole();
    await app.signOut();

    expect(signOutCalls).toBe(0);
    expect(app.text()).toContain("2 notes have edits that have not reached your bucket");
    app.unmount();
  });
});
