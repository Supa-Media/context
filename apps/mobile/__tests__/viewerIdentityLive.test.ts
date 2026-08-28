/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "@context/convex/_generated/api";
import type { ConsoleData } from "../features/console/types";
import { useLiveConsoleData } from "../features/console/useLiveConsoleData";

/**
 * The signed-in identity, from the real hook, across a change of viewed
 * context.
 *
 * `viewerIdentity.test.ts` proves the resolver; this proves `useLiveConsoleData`
 * actually feeds it the viewer's facts rather than the selection's — which is
 * the bug that shipped: the avatar initial was
 * `(selected?.slug ?? "?").slice(0, 1)` and the account name was the first
 * `kind === "personal"` context in the list. Both pass every test that only
 * ever mounts one owned context, so the fixtures here are built to catch
 * exactly those two reachings-for-the-wrong-fact:
 *
 *  - the *first* context in the list is somebody else's personal context
 *    (shared with the viewer), so "first personal" resolves wrong;
 *  - the *selected* context starts as, and returns to, that shared context,
 *    so anything derived from the selection changes when it must not.
 *
 * The pattern is `liveConsoleFacts.test.ts`'s: the smallest client
 * `useQueries` accepts, answering by function name.
 */

const GUEST_WORKSPACE = {
  workspaceId: "ws_guest",
  slug: "lk",
  displayName: "lk",
  kind: "personal",
  role: "member",
};

const OWN_WORKSPACE = {
  workspaceId: "ws_own",
  slug: "seyi",
  displayName: "seyi",
  kind: "personal",
  role: "owner",
};

const QUERY_RESULTS: Record<string, unknown> = {};

function answer(results: Record<string, unknown>) {
  for (const key of Object.keys(QUERY_RESULTS)) delete QUERY_RESULTS[key];
  Object.assign(QUERY_RESULTS, {
    [getFunctionName(api.functions.storage.getStorageBinding)]: null,
    [getFunctionName(api.functions.grants.listGrants)]: [],
    [getFunctionName(api.functions.workspaces.listMembers)]: [],
    [getFunctionName(api.functions.invitations.listInvitations)]: [],
    [getFunctionName(api.functions.ingestion.getIngestionSettings)]: null,
    ...results,
  });
}

function fakeConvexClient() {
  const watchFor = (query: unknown) => ({
    localQueryResult: () => QUERY_RESULTS[getFunctionName(query as never)],
    onUpdate: () => () => {},
    journal: () => undefined,
  });
  return {
    watchQuery: watchFor,
    watchPaginatedQuery: watchFor,
    mutation: async () => undefined,
    // Never settles, on purpose: the file browser fires `listFiles` on mount,
    // and a resolved `undefined` would send it down a path it has no reason
    // to walk here.
    action: () => new Promise(() => {}),
    connectionState: () => ({ isWebSocketConnected: true }),
  } as never;
}

/** Mounts the live hook and hands back a live view of what it returns. */
function mountHook() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let latest: ConsoleData | null = null;

  function Harness() {
    latest = useLiveConsoleData();
    return null;
  }

  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(
      createElement(ConvexProvider, { client: fakeConvexClient() }, createElement(Harness)),
    );
  });

  return {
    get data(): ConsoleData {
      return latest!;
    },
    select: (id: string) => {
      act(() => latest!.selectContext(id));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the viewer's identity, from the live console hook", () => {
  test("it is the owned personal context, not the first personal one and not the selection", () => {
    // The guest context is first, so it is both the default selection and the
    // first `kind === "personal"` match — the two wrong answers at once.
    answer({
      [getFunctionName(api.functions.workspaces.listMyWorkspaces)]: [
        GUEST_WORKSPACE,
        OWN_WORKSPACE,
      ],
    });
    const hook = mountHook();

    expect(hook.data.selectedContextId).toBe("ws_guest");
    expect(hook.data.viewer.name).toBe("@seyi");
    expect(hook.data.viewer.initial).toBe("S");
    expect(hook.data.viewer.detail).toBe("seyi@context.lc");

    hook.unmount();
  });

  test("it does not move when the viewed context does", () => {
    answer({
      [getFunctionName(api.functions.workspaces.listMyWorkspaces)]: [
        GUEST_WORKSPACE,
        OWN_WORKSPACE,
      ],
    });
    const hook = mountHook();

    const before = { ...hook.data.viewer };
    hook.select("ws_own");
    expect(hook.data.selectedContextId).toBe("ws_own");
    expect(hook.data.viewer).toEqual(before);

    hook.select("ws_guest");
    expect(hook.data.selectedContextId).toBe("ws_guest");
    expect(hook.data.viewer).toEqual(before);

    hook.unmount();
  });

  test("an invited-only viewer is their email, off their own member row", () => {
    answer({
      [getFunctionName(api.functions.workspaces.listMyWorkspaces)]: [GUEST_WORKSPACE],
      [getFunctionName(api.functions.workspaces.listMembers)]: [
        {
          userId: "u_owner",
          role: "owner",
          email: "lk@example.com",
          name: "LK",
          isMe: false,
          joinedAt: 0,
        },
        {
          userId: "u_me",
          role: "member",
          email: "guest@example.com",
          isMe: true,
          joinedAt: 1,
        },
      ],
    });
    const hook = mountHook();

    // Never `@lk` — the viewed context's slug is the one answer this block
    // must not give.
    expect(hook.data.viewer.name).toBe("guest@example.com");
    expect(hook.data.viewer.initial).toBe("G");
    expect(hook.data.viewer.detail).toBeUndefined();

    hook.unmount();
  });

  test("an invited-only viewer whose member row has not landed is 'Signed in', not the viewed slug", () => {
    answer({
      [getFunctionName(api.functions.workspaces.listMyWorkspaces)]: [GUEST_WORKSPACE],
      [getFunctionName(api.functions.workspaces.listMembers)]: undefined,
    });
    const hook = mountHook();

    expect(hook.data.viewer.name).toBe("Signed in");
    expect(hook.data.viewer.initial).toBe("?");

    hook.unmount();
  });
});
