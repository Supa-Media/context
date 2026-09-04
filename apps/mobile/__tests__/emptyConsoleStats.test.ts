/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useLiveConsoleData } from "../features/console/useLiveConsoleData";
import type { ConsoleData } from "../features/console/types";

/**
 * The first screen a new account sees must not invent their data.
 *
 * The note and byte totals are placeholders — nothing counts a whole bucket
 * yet — and that is a reasonable thing to ship next to real contexts. It is not
 * reasonable next to *no* contexts: a person who has just signed up, connected
 * nothing, and owns no bucket was being told they had **1,284 notes** and
 * **2.4 GB in your own bucket**. That is not a placeholder, it is a false
 * statement about their storage, on a product whose whole promise is that the
 * storage is theirs.
 *
 * These tests mount the real hook against a client whose answers they choose,
 * so that "the list came back empty" and "nothing has come back" are two
 * different fixtures rather than one.
 */

/**
 * The smallest client `useQueries` accepts: it is only ever asked to watch.
 *
 * `answers` is keyed by function name, so a test can say *this query came back
 * empty* rather than only *nothing has come back*. Those were the same thing
 * here once, and they are not: a query that has not answered is a console
 * still loading, and printing "0 in your context" for it is a count of a list
 * nobody fetched. See `ConsoleData.stats`.
 */
function fakeConvexClient(answers: Record<string, unknown> = {}) {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const watch = (value: unknown) => ({
    localQueryResult: () => value,
    onUpdate: () => () => {},
    journal: () => undefined,
  });
  return {
    watchQuery: (query: never) => watch(answers[getFunctionName(query)]),
    watchPaginatedQuery: () => watch(undefined),
    mutation: async () => undefined,
    action: async () => undefined,
    connectionState: () => ({ isWebSocketConnected: false }),
  } as never;
}

/** An account whose workspace list has come back, and is empty. */
const LIST_ARRIVED_EMPTY = { "functions/workspaces:listMyWorkspaces": [] };

function mountConsole(answers: Record<string, unknown> = {}): ConsoleData {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let latest: ConsoleData | null = null;

  function Probe() {
    latest = useLiveConsoleData();
    return null;
  }

  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(
      createElement(ConvexProvider, { client: fakeConvexClient(answers) }, createElement(Probe)),
    );
  });
  act(() => root.unmount());
  container.remove();
  return latest!;
}

describe("an account with no contexts is told nothing it cannot verify", () => {
  test("the note and byte totals are not invented", () => {
    const data = mountConsole(LIST_ARRIVED_EMPTY);
    expect(data.contexts).toHaveLength(0);

    const notes = data.stats.find((s) => s.label === "notes across all");
    const bytes = data.stats.find((s) => s.label === "in your own bucket");

    // These were an em dash here and the mockup's numbers for anybody who had
    // a context — half a fix, and the half that shipped kept lying to every
    // real user.
    //
    // "notes across all" is a measured number now, and this account is exactly
    // why it must still be absent here: no context, no bucket, nothing walked,
    // so there is nothing to total. A `0` would be a claim about storage that
    // does not exist. Bytes are still measured by nothing at all, so that tile
    // is gone outright. `liveConsoleFacts.test.ts` holds the other end — a
    // connected bucket, counted and uncounted.
    expect(notes).toBeUndefined();
    expect(bytes).toBeUndefined();

    // And nothing invented has crept back in under some other label.
    for (const stat of data.stats) {
      expect(stat.value).not.toBe("1,284");
      expect(stat.value).not.toBe("2.4 GB");
    }
  });

  test("the counts it CAN answer are still answered", () => {
    // The fix must not turn the honest stats into em dashes too — zero contexts
    // and zero connected clients are facts, and worth stating.
    const data = mountConsole(LIST_ARRIVED_EMPTY);
    expect(data.stats.find((s) => s.label === "in your context")?.value).toBe("0");
    expect(data.stats.find((s) => s.label === "AI clients connected")?.value).toBe("0");
  });

  test("but a list that has not answered is counted as nothing at all", () => {
    /**
     * **Filmed on a native cold launch.** The Map appeared for one frame on the
     * way to a note, captioned "0 connected", over "0 in your context" and "0
     * AI clients connected" — on an account with several contexts and a
     * connected client. Every number counted a list whose first round trip was
     * still outstanding.
     *
     * This file's own harness had the same confusion written into it: it
     * mounted a client that never resolves a query and called that "exactly the
     * state a brand-new account is in". It is the state a *loading* console is
     * in. The two tests above now say which one they mean.
     */
    expect(mountConsole().stats).toEqual([]);
  });
});
