/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Row 504, wired: the console's own context list is what takes a removed
 * context's copies off the device.
 *
 * `offlineForget.test.ts` proves what `forgetDepartedContexts` does when it is
 * called. This proves that anything calls it — which is the half that was
 * missing, and the half a refactor silently drops. The whole finding was that
 * membership can end on another machine and nothing here hears about it; a
 * purge nothing invokes would have been the same bug with more code.
 *
 * So the hook is mounted for real, against a Convex client that answers
 * `listMyWorkspaces` with one context, with a second context's note already
 * cached — the shape a device is in the moment after an owner removed somebody
 * from a shared context, or deleted it.
 */

import type { KeyValueStore } from "../features/offline/memory";

/**
 * The store `forget.ts` opens. `mock`-prefixed because the factory below reads
 * it and jest refuses any other out-of-scope name — the same arrangement
 * `offlineForget.test.ts` makes.
 */
let mockOpened: KeyValueStore;

jest.mock("../features/offline/store", () => ({
  openStore: () => mockOpened,
}));

const { act, createElement } = require("react") as typeof import("react");
const { createRoot } = require("react-dom/client") as typeof import("react-dom/client");
const { ConvexProvider } = require("convex/react") as typeof import("convex/react");
const { getFunctionName } = require("convex/server") as typeof import("convex/server");
const { api } = require("@context/convex/_generated/api") as typeof import("@context/convex/_generated/api");
const { useLiveConsoleData } =
  require("../features/console/useLiveConsoleData") as typeof import("../features/console/useLiveConsoleData");
const { keyFor, scopedKeyFor } =
  require("../features/offline/keys") as typeof import("../features/offline/keys");

const HERE = "ws_here";
const GONE = "ws_gone";

const STILL_MINE = scopedKeyFor("note", "private", HERE, "1-projects/pay.md");
const DEPARTED_NOTE = scopedKeyFor("note", "team", GONE, "1-projects/theirs.md");
const DEPARTED_LISTING = scopedKeyFor("listing", "team", GONE, "1-projects");
const DEPARTED_DRAFT = keyFor("draft", GONE, "1-projects/theirs.md");
const DEPARTED_OUTBOX = keyFor("outbox", GONE, "");

/**
 * A `Map`-backed store, seeded with one live context's copies and one departed.
 *
 * `cachedAt` is *now*, not a constant. The console sweeps on mount and
 * `MAX_AGE_MS` is thirty days, so a fixture with `cachedAt: 1` is deleted by
 * the age bound before the purge is reached — which is how the first version of
 * this test passed while proving nothing, and exactly the vacuity this
 * repository keeps finding. Fresh records make the sweep a no-op, so the only
 * thing that can remove a key here is the code under test.
 */
function seededStore(): KeyValueStore {
  const now = Date.now();
  const held = new Map<string, string>([
    [STILL_MINE, JSON.stringify({ value: { text: "mine" }, cachedAt: now })],
    [DEPARTED_NOTE, JSON.stringify({ value: { text: "theirs" }, cachedAt: now })],
    [DEPARTED_LISTING, JSON.stringify({ value: { entries: [] }, cachedAt: now })],
    [DEPARTED_DRAFT, JSON.stringify({ path: "1-projects/theirs.md", text: "typed" })],
    [DEPARTED_OUTBOX, JSON.stringify({ writes: [] })],
  ]);
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
  };
}

const MY_WORKSPACES = [
  {
    workspaceId: HERE,
    slug: "seyi",
    displayName: "seyi",
    kind: "personal",
    role: "owner",
  },
];

/** What every other query the console fans out to answers. None of it matters here. */
const OTHER_RESULTS: Record<string, unknown> = {
  [getFunctionName(api.functions.storage.getStorageBinding)]: null,
  [getFunctionName(api.functions.grants.listGrants)]: [],
  [getFunctionName(api.functions.workspaces.listMembers)]: [],
  [getFunctionName(api.functions.invitations.listInvitations)]: [],
};

/**
 * The smallest client `useQueries` accepts, with the context list as a
 * parameter. `undefined` for it is what an in-flight subscription looks like —
 * the case the purge must not act on.
 */
function fakeConvexClient(workspaces: unknown) {
  const watchFor = (query: unknown) => {
    const name = getFunctionName(query as never);
    const result =
      name === getFunctionName(api.functions.workspaces.listMyWorkspaces)
        ? workspaces
        : OTHER_RESULTS[name];
    return {
      localQueryResult: () => result,
      onUpdate: () => () => {},
      journal: () => undefined,
    };
  };
  return {
    watchQuery: watchFor,
    watchPaginatedQuery: watchFor,
    mutation: async () => undefined,
    // Never settles on purpose: the file browser fires `listFiles` on mount and
    // a resolved `undefined` would send it down a path with no bearing here.
    action: () => new Promise(() => {}),
    connectionState: () => ({ isWebSocketConnected: true }),
  } as never;
}

/** Mounts the live hook, lets its effects and their promises settle, unmounts. */
async function mountConsole(workspaces: unknown): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);

  function Harness() {
    useLiveConsoleData();
    return null;
  }

  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root.render(
      createElement(ConvexProvider, { client: fakeConvexClient(workspaces) }, createElement(Harness)),
    );
  });
  // The purge is fire-and-forget from the effect, so the render pass returning
  // is not the same thing as the removals having landed.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => root.unmount());
  container.remove();
}

beforeEach(() => {
  mockOpened = seededStore();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the console's context list as a revocation signal", () => {
  test("a context that is no longer listed loses its cached bodies on mount", async () => {
    await mountConsole(MY_WORKSPACES);

    expect(await mockOpened.get(DEPARTED_NOTE)).toBeNull();
    expect(await mockOpened.get(DEPARTED_LISTING)).toBeNull();
    // The live context is untouched, and so is everything the departed context's
    // *owner of the typing* — this person — has not sent yet. See `forget.ts`:
    // being wrong in the safe direction costs a cache miss, being wrong in the
    // other costs somebody's unsent work.
    expect(await mockOpened.get(STILL_MINE)).not.toBeNull();
    expect(await mockOpened.get(DEPARTED_DRAFT)).not.toBeNull();
    expect(await mockOpened.get(DEPARTED_OUTBOX)).not.toBeNull();
  });

  test("a list that has not arrived yet purges nothing", async () => {
    /*
      The hazard that decides the whole shape. A slow or failed
      `listMyWorkspaces` reads as `undefined`, which is *also* what an account
      with no contexts would produce one step later — and purging on it would
      blank the cache at the one moment the offline copy is the only thing the
      person has. The anti-vacuity witness is the test above: with a list, the
      same two keys do go.
    */
    await mountConsole(undefined);

    expect(await mockOpened.get(DEPARTED_NOTE)).not.toBeNull();
    expect(await mockOpened.get(DEPARTED_LISTING)).not.toBeNull();
    expect(await mockOpened.get(STILL_MINE)).not.toBeNull();
  });
});
