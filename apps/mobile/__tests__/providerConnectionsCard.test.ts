/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Settings › Apps Tex uses (`ProviderConnectionsCard`): every app with where
 * the person stands, so connecting needs no text to Tex (Dev2, 2026-10-21:
 * "no way to connect through context and see what I have / manage the
 * connections?").
 *
 * SABOTAGE: show only connected apps again, and the Connect row is gone;
 * start consent with anything but the link the server minted, or leave
 * without keeping the completion secret, and the second test fails.
 */

const left: string[] = [];
const called: unknown[] = [];
let mockRows: unknown[] | undefined = [];
jest.mock("../features/connect/leaveForConsent", () => ({
  leaveForConsent: (url: string) => left.push(url),
}));
jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => mockRows,
  // Minting a link answers a token; starting consent with that token answers the app's address.
  useAction: () => async (args: { token?: string }) => {
    called.push(args);
    return args.token === undefined
      ? { token: "tok-from-server" }
      : { authorizeUrl: "https://mcp.linear.app/authorize?state=s1", completionSecret: "secret-from-server" };
  },
  useMutation: () => async () => null,
}));

const { ProviderConnectionsCard } = require("../features/console/settings/panels/ProviderConnectionsCard") as typeof import("../features/console/settings/panels/ProviderConnectionsCard");

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ProviderConnectionsCard, { workspaceId: "ws1" })));
  return {
    find: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("apps in Settings", () => {
  test("lists every app: Connect where it isn't connected, Disconnect where it is", () => {
    mockRows = [
      { app: "linear", name: "Linear", about: "issues", state: "not_connected" },
      { app: "notion", name: "Notion", about: "pages", state: "connected", account: "Acme", connectionId: "c1" },
      { app: "slack", name: "Slack", about: "messages", state: "reconnect", account: "Acme", connectionId: "c2" },
    ];
    const card = mount();
    expect(card.find("provider-connection-connect-linear")).not.toBeNull();
    expect(card.find("provider-connection-disconnect-linear")).toBeNull();
    expect(card.find("provider-connection-connect-notion")).toBeNull();
    expect(card.find("provider-connection-disconnect-notion")).not.toBeNull();
    expect(card.find("provider-connection-connect-slack")).not.toBeNull();
    expect(card.find("provider-connection-disconnect-slack")).not.toBeNull();
    card.unmount();
  });

  test("Connect mints a link, starts consent with it, keeps the secret, and leaves for the app", async () => {
    mockRows = [{ app: "linear", name: "Linear", about: "issues", state: "not_connected" }];
    const card = mount();
    await act(async () => {
      card.find("provider-connection-connect-linear")!.click();
    });
    expect(called).toEqual([{ workspaceId: "ws1", provider: "linear" }, { token: "tok-from-server" }]);
    expect(Object.values({ ...window.sessionStorage })).toContain("secret-from-server");
    expect(left).toEqual(["https://mcp.linear.app/authorize?state=s1"]);
    card.unmount();
  });

  test("nothing to connect, or still loading, draws nothing", () => {
    for (const rows of [undefined, []]) {
      mockRows = rows;
      const card = mount();
      expect(card.find("provider-connections")).toBeNull();
      card.unmount();
    }
  });
});
