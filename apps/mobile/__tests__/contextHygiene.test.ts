/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { useLiveConsoleData } from "../features/console/useLiveConsoleData";
import * as cache from "../features/offline/cache";
import { ownedKeys, parseKey } from "../features/offline/keys";
import { openStore } from "../features/offline/store.web";
import type { ConsoleData } from "../features/console/types";
import type { OpenNote } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Leaving a context, and deleting an account, at the two hooks that do it.
 *
 * `forgetWorkspace`'s own comment says it is "for a context that was left,
 * revoked, or whose bucket was rebound", and nothing called it. So walking out
 * of somebody else's context left their notes — the ones they shared with you,
 * cached in your browser — readable on your machine indefinitely, with the
 * membership that justified holding them already gone. Deleting an account was
 * worse: every trace on the control plane, and a full copy of the notes still
 * in `localStorage`.
 *
 * Two properties are held here rather than one, and the second is the reason
 * this is not simply "clear on the way out":
 *
 *  - **A context that was left is forgotten**, and the contexts that were not
 *    are untouched. A leave that cleared everything would be a person losing
 *    their own offline copy because they walked out of a colleague's context.
 *  - **A leave the server refused clears nothing.** `leaveWorkspace` answers
 *    `{ left: false }` for a membership it did not delete — an owner cannot
 *    leave their own context (`OWNER_CANNOT_LEAVE`) — and wiping a cache on
 *    the strength of a request rather than an answer would throw away the
 *    offline copy of a context the person still has.
 */

const WORKSPACES = [
  { workspaceId: "w1", slug: "seyi", displayName: "seyi", kind: "personal", role: "owner" },
  { workspaceId: "w2", slug: "lk", displayName: "LK", kind: "personal", role: "member" },
];

const QUERY_RESULTS: Record<string, unknown> = {
  [getFunctionName(api.functions.workspaces.listMyWorkspaces)]: WORKSPACES,
  [getFunctionName(api.functions.storage.getStorageBinding)]: null,
  [getFunctionName(api.functions.grants.listGrants)]: [],
  [getFunctionName(api.functions.workspaces.listMembers)]: [],
  [getFunctionName(api.functions.invitations.listInvitations)]: [],
};

/** What the control plane answered, and what it was asked. */
let leaveAnswer: { left: boolean } = { left: true };
let mutationsCalled: string[] = [];

function fakeConvexClient() {
  const watchFor = (query: unknown) => {
    const result = QUERY_RESULTS[getFunctionName(query as never)];
    return {
      localQueryResult: () => result,
      onUpdate: () => () => {},
      journal: () => undefined,
    };
  };
  return {
    watchQuery: watchFor,
    watchPaginatedQuery: watchFor,
    mutation: async (ref: unknown) => {
      const name = getFunctionName(ref as never);
      mutationsCalled.push(name);
      if (name === getFunctionName(api.functions.workspaces.leaveWorkspace)) return leaveAnswer;
      return undefined;
    },
    // Never settles: `useFileBrowser` fires `listFiles` on mount and a
    // resolved `undefined` would send it down a path this file is not about.
    action: () => new Promise(() => {}),
    connectionState: () => ({ isWebSocketConnected: true }),
  } as never;
}

function note(path: string): OpenNote {
  return {
    path,
    text: "shared with you, and cached here",
    etag: "e1",
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
  };
}

/**
 * Two contexts' worth of records on the device.
 *
 * Stamped `Date.now()` rather than a literal: `useOfflineNotes` runs `sweep`
 * once the queue has hydrated, and a record seeded at time 0 would be dropped
 * by the age bound before any assertion could tell the difference between that
 * and a leave.
 */
async function seedBothContexts() {
  const store = openStore();
  const now = Date.now();
  await cache.putNote(store, "w1", note("1-projects/mine.md"), now);
  await cache.putNote(store, "w2", note("1-projects/theirs.md"), now);
  await cache.putListing(
    store,
    "w2",
    { path: "", folderDefault: "team", entries: [], truncated: false, manifestUsable: true },
    now,
  );
  await cache.putDraft(store, "w2", {
    path: "1-projects/theirs.md",
    text: "typed into somebody else's context",
    baseEtag: "e1",
    savedAt: now,
  });
}

function allKeys(): string[] {
  const found: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) found.push(key);
  }
  return found;
}

const keysFor = (workspaceId: string) =>
  allKeys().filter((key) => parseKey(key)?.workspaceId === workspaceId);

/** Mount the live hook and hand back the console data plus a way to act on it. */
function mountConsole(): { data: () => ConsoleData; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  let latest: ConsoleData | null = null;

  function Probe() {
    latest = useLiveConsoleData();
    return null;
  }

  act(() => {
    root.render(
      createElement(ConvexProvider, { client: fakeConvexClient() }, createElement(Probe)),
    );
  });

  return {
    data: () => latest!,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  window.localStorage.clear();
  leaveAnswer = { left: true };
  mutationsCalled = [];
});

/* -------------------------------------------------------------------------- */

describe("leaving a context", () => {
  test("takes that context's copies off the device", async () => {
    await seedBothContexts();
    expect(keysFor("w2").length).toBeGreaterThan(0);

    const app = mountConsole();
    await act(async () => {
      await app.data().leaveContext?.("w2");
    });
    await settle();

    expect(keysFor("w2")).toEqual([]);
    app.unmount();
  });

  test("and leaves every other context alone", async () => {
    await seedBothContexts();

    const app = mountConsole();
    await act(async () => {
      await app.data().leaveContext?.("w2");
    });
    await settle();

    expect(keysFor("w1").length).toBeGreaterThan(0);
    app.unmount();
  });

  test("a leave the server refused clears nothing", async () => {
    /*
      `{ left: false }` is what `leaveWorkspace` answers for a membership it did
      not delete. Clearing on the request rather than on the answer would throw
      away the offline copy of a context the person still has — and the case
      that produces it is an owner pressing Leave on their own context, which
      is the person with the most in there.
    */
    leaveAnswer = { left: false };
    await seedBothContexts();
    const before = keysFor("w2").sort();

    const app = mountConsole();
    await act(async () => {
      await app.data().leaveContext?.("w2");
    });
    await settle();

    expect(keysFor("w2").sort()).toEqual(before);
    app.unmount();
  });

  test("the answer the caller gets is still the server's", async () => {
    // The rail navigates on this. A clear that swallowed or reshaped the
    // result would be a hygiene step deciding what the console does next.
    await seedBothContexts();
    const app = mountConsole();
    let answer: { left: boolean } | undefined;
    await act(async () => {
      answer = await app.data().leaveContext?.("w2");
    });
    expect(answer).toEqual({ left: true });
    app.unmount();
  });
});

/* -------------------------------------------------------------------------- */

describe("deleting an account", () => {
  test("leaves nothing of any context on the device", async () => {
    await seedBothContexts();

    const app = mountConsole();
    await act(async () => {
      await app.data().deleteAccount?.();
    });
    await settle();

    expect(ownedKeys(allKeys())).toEqual([]);
    app.unmount();
  });

  test("and the control plane is still asked first", async () => {
    // Anti-vacuity: an empty store would satisfy the assertion above whether or
    // not the deletion ran at all.
    await seedBothContexts();

    const app = mountConsole();
    await act(async () => {
      await app.data().deleteAccount?.();
    });

    expect(mutationsCalled).toContain(getFunctionName(api.functions.account.deleteAccount));
    app.unmount();
  });
});
