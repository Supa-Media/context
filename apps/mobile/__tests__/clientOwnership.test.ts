/**
 * @jest-environment jsdom
 */

/**
 * Whose connected client is this?
 *
 * The question arrived from outside: somebody invited into a personal brain
 * opened Settings, found nine clients that were not theirs, and asked whether
 * that was intended. It was not. The fix has two halves and this file holds
 * the console's.
 *
 * The server half is `functions/grants.listGrants`, now owner-only, tested in
 * `apps/convex/__tests__/roles.test.ts` — nobody but a context's owner is shown
 * a grant that is not their own. What that leaves is the case where being shown
 * one is right and saying nothing about it is not: an owner of a shared context
 * genuinely administers their colleagues' clients, and the list they appear in
 * sits under the heading "Your endpoint", one card below a sentence promising
 * that every client *you* add appears below. An unmarked row there is a
 * colleague's laptop with a Revoke button beside it and nothing saying so.
 *
 * Two assertions, because the mark can be lost in two independent places: the
 * row can stop drawing it, and the hook can stop carrying it. The second is
 * the quieter failure — `mine` would simply be `undefined`, which reads as
 * "not mine" nowhere and as a missing pill everywhere.
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { api } from "@context/convex/_generated/api";

import { ClientRow } from "../features/console/panes/ConnectionsPane";
import type { ConsoleClient } from "../features/console/types";
import { useLiveConsoleData } from "../features/console/useLiveConsoleData";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARK = "another member's";

const BASE: ConsoleClient = {
  id: "g1",
  name: "Claude Desktop",
  context: "@seyi",
  detail: "Full access · last used 4 minutes ago",
  mine: true,
  status: "ok",
};

function renderRow(client: ConsoleClient): { text: string; labels: string[] } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(ClientRow as never, { client } as never));
  });
  const text = host.textContent ?? "";
  const labels = Array.from(host.querySelectorAll("[aria-label]")).map(
    (node) => node.getAttribute("aria-label") ?? "",
  );
  act(() => root.unmount());
  host.remove();
  return { text, labels };
}

describe("a connected client says whose it is", () => {
  test("your own row is unmarked", () => {
    const { text, labels } = renderRow(BASE);
    expect(text).toContain("Claude Desktop");
    expect(text).not.toContain(MARK);
    expect(labels.join(" ")).toContain("Revoke Claude Desktop's access to @seyi");
  });

  test("somebody else's row is marked, and its Revoke says so too", () => {
    const { text, labels } = renderRow({ ...BASE, mine: false });
    expect(text).toContain(MARK);
    // The label matters more than the pill: a screen reader gets the button's
    // name and nothing of the row above it, so an unqualified "Revoke Claude
    // Desktop" is the same button with none of the warning.
    expect(labels.join(" ")).toContain("Revoke another member's Claude Desktop");
  });
});

const WORKSPACE_ID = "ws_1";

const GRANTS = [
  {
    grantId: "g_own",
    workspaceId: WORKSPACE_ID,
    userId: "u_me",
    clientId: "claude",
    clientName: "Claude Desktop",
    scopes: ["context:read", "context:write"],
    status: "active",
    isMine: true,
    createdAt: 2,
  },
  {
    grantId: "g_theirs",
    workspaceId: WORKSPACE_ID,
    userId: "u_them",
    clientId: "codex",
    clientName: "Codex",
    scopes: ["context:read"],
    status: "active",
    isMine: false,
    createdAt: 1,
  },
];

const QUERY_RESULTS: Record<string, unknown> = {
  [getFunctionName(api.functions.workspaces.listMyWorkspaces)]: [
    {
      workspaceId: WORKSPACE_ID,
      slug: "team",
      displayName: "Team",
      kind: "shared",
      role: "owner",
    },
  ],
  [getFunctionName(api.functions.storage.getStorageBinding)]: null,
  [getFunctionName(api.functions.grants.listGrants)]: GRANTS,
  [getFunctionName(api.functions.workspaces.listMembers)]: [],
  [getFunctionName(api.functions.invitations.listInvitations)]: [],
  [getFunctionName(api.functions.invitations.listMyInvitations)]: [],
};

/** The smallest client `useQueries` accepts, answering by function name. */
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
    mutation: async () => undefined,
    action: () => new Promise(() => {}),
    connectionState: () => ({ isWebSocketConnected: true }),
  } as never;
}

describe("the live console carries the server's answer", () => {
  test("`isMine` reaches the row as `mine`, per client", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let clients: ConsoleClient[] = [];

    function Harness() {
      clients = useLiveConsoleData().clients;
      return null;
    }

    const root = createRoot(host, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() => {
      root.render(
        createElement(ConvexProvider, { client: fakeConvexClient() }, createElement(Harness)),
      );
    });
    act(() => root.unmount());
    host.remove();

    expect(clients.map((client) => [client.name, client.mine])).toEqual([
      ["Claude Desktop", true],
      ["Codex", false],
    ]);
  });
});
