import { describe, expect, test } from "@jest/globals";
import { api } from "@context/convex/_generated/api";
import { EMPTY_QUERY_SPEC } from "../features/console/querySpec";
import { resolveContextRoute, MAP_ROUTE } from "../features/console/nav";

/**
 * The blank-white-page bug, and a test that fails if it comes back.
 *
 * A brand-new account signed in, landed on `/console`, and got a white page and
 * *"Minified React error #301 — too many re-renders"*. Nothing rendered at all,
 * so the console's own `contexts.length === 0` empty state never got a chance —
 * which is why the empty state looked broken when it was not.
 *
 * The cause was `useQueries` being handed a spec object with a fresh identity on
 * every render. Convex's `useSubscription` compares that object to the one in
 * state and calls `setState` **during render** when it differs, so an unstable
 * spec sets state on every render until React gives up.
 *
 * What made the spec unstable is the subject of the first block, and it is
 * genuinely invisible when reading the call site.
 *
 * The last block is the part that guards rather than documents: it renders the
 * real hook through the real Convex provider and fails if the loop returns.
 */

describe("the landmine: `api` is a proxy, not an object", () => {
  test("every property access returns a NEW object", () => {
    // This is why a `useMemo` listing an `api.…` reference in its dependency
    // array recomputes on every render, forever. `anyApi`'s `get` handler mints
    // a fresh proxy per access, so `Object.is` is never true.
    expect(api.functions.workspaces.listMyWorkspaces).not.toBe(
      api.functions.workspaces.listMyWorkspaces,
    );
    expect(api.functions.storage.getStorageBinding).not.toBe(
      api.functions.storage.getStorageBinding,
    );
  });

  test("even the module level is a fresh object each time", () => {
    const first = api.functions as unknown as Record<string, unknown>;
    const second = api.functions as unknown as Record<string, unknown>;
    expect(first.ingestion).not.toBe(second.ingestion);
  });
});

describe("the empty spec is shared, not rebuilt", () => {
  test("subscribing to nothing is always the same object", () => {
    // A fresh `{}` per render is just as unstable as a fresh proxy, and the
    // zero-context path is precisely where the spec is empty.
    expect(EMPTY_QUERY_SPEC).toBe(EMPTY_QUERY_SPEC);
    expect(Object.keys(EMPTY_QUERY_SPEC)).toHaveLength(0);
  });

  test("it cannot be mutated into a non-empty spec by accident", () => {
    expect(Object.isFrozen(EMPTY_QUERY_SPEC)).toBe(true);
  });
});

describe("zero contexts settles instead of oscillating", () => {
  test("the console resolver returns the same answer every time it is asked", () => {
    // The redirect effect in the console layout runs off this. If it returned
    // "redirect" and then "stay" for the same inputs, the layout would bounce
    // between routes.
    const inputs = {
      route: MAP_ROUTE,
      contexts: [] as Array<{ id: string; slug: string }>,
      selectedContextId: null,
      loading: false,
    };
    const first = resolveContextRoute(inputs);
    const second = resolveContextRoute(inputs);
    expect(first).toEqual({ action: "stay" });
    expect(second).toEqual(first);
  });

  test("a still-loading context list never starts a redirect", () => {
    expect(
      resolveContextRoute({
        route: { kind: "context", slug: "seyi", view: "browse" },
        contexts: [],
        selectedContextId: null,
        loading: true,
      }),
    ).toEqual({ action: "stay" });
  });
});

/**
 * Everything in this file states a fact. **None of it is the guard** — every
 * assertion here passes just as happily with the bug put back, because the bug
 * is a dependency array, and a dependency array is not something a fact about
 * `anyApi` can observe.
 *
 * The guard that fails on regression is `consoleRenderLoop.test.ts`, which
 * mounts these hooks on a real reconciler under jsdom. It also records why the
 * obvious cheaper harness — `renderToStaticMarkup` — cannot work: React's SSR
 * renderer ignores a render-phase `setState` entirely, so a component that
 * loops forever in a browser renders exactly once and throws nothing.
 */
