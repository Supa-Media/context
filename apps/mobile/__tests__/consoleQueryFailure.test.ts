/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { ConvexError } from "convex/values";
import { getFunctionName } from "convex/server";
import { useLiveConsoleData } from "../features/console/useLiveConsoleData";
import type { ConsoleData } from "../features/console/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A failed query is a screen, not an unmount.
 *
 * ## The bug
 *
 * `useLiveConsoleData` opened `listMyWorkspaces` with `useQuery`, and
 * `useMembers` opened `listMembers` and `listInvitations` the same way. Convex's
 * `useQuery` ends like this:
 *
 * ```js
 * const result = results["query"];
 * if (result instanceof Error) throw result;
 * ```
 *
 * — a **render-phase throw**. One transient failure (an auth blip while a token
 * refreshes, a deploy rolling the backend) therefore threw out of the console
 * layout, past every layout above it, and with no boundary anywhere in `app/`
 * or `features/` React unmounted the whole tree: a blank dark page, no message,
 * no control.
 *
 * Both files carried a `usable()` helper whose comment claimed to handle an
 * `Error` value. It never ran — the throw happened first — so the protection
 * everybody could see in the source did not exist.
 *
 * ## Why this file mounts a reconciler
 *
 * The throw is a *render-phase* event. It cannot be reached by calling the hook,
 * and `renderToStaticMarkup` does not model it usefully either. So this mounts
 * the real hook against a Convex client whose watch throws, which is exactly
 * what the real client does when a query function errors, and asserts the hook
 * *returns* rather than throws.
 *
 * Both tests below have been verified to fail with the fix reverted (put
 * `useQuery` back and the mount throws instead of returning a `failure`).
 */

/** The smallest client `useQueries` accepts, with per-query outcomes. */
function clientWhere(outcomes: Record<string, () => unknown>) {
  const watchFor = (name: string) => ({
    localQueryResult: () => {
      const outcome = Object.entries(outcomes).find(([suffix]) => name.endsWith(suffix));
      return outcome === undefined ? undefined : outcome[1]();
    },
    onUpdate: () => () => {},
    journal: () => undefined,
  });
  return {
    // `getFunctionName` on the generated `api` proxy gives
    // "functions/workspaces:listMyWorkspaces" and friends.
    watchQuery: (query: unknown) => watchFor(getFunctionName(query as never)),
    watchPaginatedQuery: (query: unknown) => watchFor(getFunctionName(query as never)),
    mutation: async () => undefined,
    action: async () => undefined,
    connectionState: () => ({ isWebSocketConnected: false }),
  } as never;
}

/** Mount `useLiveConsoleData` and hand back whatever it returned. */
function mountConsole(client: never): { data: ConsoleData | null; error: Error | null } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let data: ConsoleData | null = null;
  let error: Error | null = null;

  function Probe() {
    data = useLiveConsoleData();
    return null;
  }

  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });

  try {
    act(() => {
      root.render(createElement(ConvexProvider, { client }, createElement(Probe)));
    });
  } catch (thrown) {
    error = thrown as Error;
  }

  try {
    act(() => root.unmount());
  } catch {
    // A root that already failed cannot always be unmounted cleanly.
  }
  container.remove();
  return { data, error };
}

const WORKSPACES = [
  { workspaceId: "w1", slug: "testagent1", displayName: "testagent1", kind: "personal", role: "owner" },
];

describe("a failed console query renders instead of unmounting", () => {
  test("listMyWorkspaces throwing is a failure the console can draw", () => {
    const { data, error } = mountConsole(
      clientWhere({
        "workspaces:listMyWorkspaces": () => {
          throw new Error("connection lost");
        },
      }),
    );

    // The whole point: the hook returned.
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.failure).not.toBeNull();
    expect(data!.failure!.headline).toBe("We couldn't load your contexts");
    // And it is not pretending to still be loading — that is the quiet version
    // of the same bug: a console that spins forever on an answer that arrived.
    expect(data!.loading).toBe(false);
    expect(data!.contexts).toEqual([]);
  });

  test("a session that lapsed says so, rather than shrugging", () => {
    const { data, error } = mountConsole(
      clientWhere({
        "workspaces:listMyWorkspaces": () => {
          throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "no identity" });
        },
      }),
    );
    expect(error).toBeNull();
    expect(data!.failure).toEqual({
      headline: "Your session ended",
      next: "Sign in again and this will come straight back.",
    });
  });

  test("listMembers throwing costs the members card, not the console", () => {
    const { data, error } = mountConsole(
      clientWhere({
        "workspaces:listMyWorkspaces": () => WORKSPACES,
        "workspaces:listMembers": () => {
          throw new Error("boom");
        },
      }),
    );

    expect(error).toBeNull();
    // The console itself is fine and the context is still listed…
    expect(data!.failure).toBeNull();
    expect(data!.contexts).toHaveLength(1);
    // …and the card that could not load says so, rather than reading as an
    // empty context or spinning forever.
    expect(data!.members.failure).not.toBeNull();
    expect(data!.members.failure!.headline).toBe("We couldn't load who can reach this context");
    expect(data!.members.loading).toBe(false);
  });

  test("nothing failing leaves every failure null", () => {
    const { data, error } = mountConsole(
      clientWhere({ "workspaces:listMyWorkspaces": () => WORKSPACES }),
    );
    expect(error).toBeNull();
    expect(data!.failure).toBeNull();
    expect(data!.members.failure).toBeNull();
    expect(data!.contexts).toHaveLength(1);
  });

  test("the premise still holds: these hooks must never reach for useQuery", () => {
    // `usable()` and every `failure` above are live code only because the
    // subscriptions are `useQueries`. One `useQuery` put back here re-opens the
    // whole hole, and it would look like a simplification.
    for (const file of [
      "../features/console/useLiveConsoleData.ts",
      "../features/console/members/useMembers.ts",
    ]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      // A *call*, not the word: both files talk about `useQuery` at length in
      // the comments explaining why they do not use it.
      expect(source).not.toMatch(/\buseQuery\s*\(/);
      expect(source).toMatch(/\buseQueries\s*\(/);
    }
  });
});
