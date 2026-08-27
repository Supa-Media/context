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
 * This test mounts the real hook with a client that never resolves a query,
 * which is exactly the state a brand-new account is in.
 */

/** The smallest client `useQueries` accepts: it is only ever asked to watch. */
function fakeConvexClient() {
  const watch = {
    localQueryResult: () => undefined,
    onUpdate: () => () => {},
    journal: () => undefined,
  };
  return {
    watchQuery: () => watch,
    watchPaginatedQuery: () => watch,
    mutation: async () => undefined,
    action: async () => undefined,
    connectionState: () => ({ isWebSocketConnected: false }),
  } as never;
}

function mountConsole(): ConsoleData {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let latest: ConsoleData | null = null;

  function Probe() {
    latest = useLiveConsoleData();
    return null;
  }

  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(ConvexProvider, { client: fakeConvexClient() }, createElement(Probe)));
  });
  act(() => root.unmount());
  container.remove();
  return latest!;
}

describe("an account with no contexts is told nothing it cannot verify", () => {
  test("the note and byte totals are not invented", () => {
    const data = mountConsole();
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
    const data = mountConsole();
    expect(data.stats.find((s) => s.label === "contexts reachable")?.value).toBe("0");
    expect(data.stats.find((s) => s.label === "AI clients connected")?.value).toBe("0");
  });
});
