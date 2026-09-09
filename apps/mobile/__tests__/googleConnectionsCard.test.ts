/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://context.lc/"}
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "../features/design/theme";
import { GoogleConnectionsCard } from "../features/console/google/GoogleConnectionsCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockStartCalls: unknown[] = [];
const mockNavigations: string[] = [];

jest.mock("convex/react", () => ({
  useAction: () => (args: unknown) => {
    mockStartCalls.push(args);
    return Promise.resolve({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=google-state",
      completionSecret: "completion-secret",
    });
  },
}));

jest.mock("../features/console/google/leaveForGoogle", () => ({
  leaveForGoogle: (url: string) => {
    mockNavigations.push(url);
  },
}));

function render(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onCaughtError: () => {}, onUncaughtError: () => {} });
  act(() => {
    root.render(createElement(ThemeProvider, { scheme: "dark", children: node }));
  });
  return {
    container,
    click: async (testID: string) => {
      const element = container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
      if (!element) throw new Error(`missing ${testID}`);
      await act(async () => {
        element.click();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("GoogleConnectionsCard", () => {
  test("connect sends the selected Gmail backfill window", async () => {
    mockStartCalls.length = 0;
    mockNavigations.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, {
        actions: { workspaceId: "ws_1", disconnect: async () => null },
      }),
    );

    expect(screen.container.textContent).toContain("Gmail Backfill");
    expect(screen.container.textContent).toContain("90 days");
    await screen.click("google-backfill-window-365");
    await screen.click("connect-google");

    expect(mockStartCalls).toHaveLength(1);
    expect(mockStartCalls[0]).toMatchObject({
      workspaceId: "ws_1",
      syncServices: { gmail: true, calendar: true, chat: true },
      backfillDays: 365,
    });
    expect(mockNavigations).toEqual([
      "https://accounts.google.com/o/oauth2/v2/auth?state=google-state",
    ]);
    screen.unmount();
  });

  test("connected accounts show real sync and destination state", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        connections: [
          {
            connectionId: "google_1",
            email: "seyi@supa.media",
            syncServices: { gmail: true, calendar: true, chat: true },
            syncStatus: "backfilling",
            errorCode: "SCOPES_INCOMPLETE",
            lastError: "This Google account's authorization no longer covers chat.",
            gmail: {
              backfillDays: 90,
              folders: ["inbox", "sent"],
              destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
              historyCursorReady: false,
            },
            calendar: {
              destinationPath: "0-inbox/calendar/YYYY-MM-DD.md",
              syncCursorReady: false,
            },
            chat: {
              destinationPath: "0-inbox/google-chat/YYYY-MM-DD.md",
              cursorCount: 2,
            },
          },
        ],
      }),
    );

    const text = screen.container.textContent ?? "";
    expect(text).toContain("Gmail, Calendar, Chat · waiting for first sync");
    expect(text).toContain("Gmail: 90-day backfill");
    expect(text).toContain("waiting for first Gmail cursor");
    expect(text).toContain("Destination: 0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md");
    expect(text).toContain("Calendar: waiting for first Calendar cursor");
    expect(text).toContain("Chat: 2 Chat space cursors");
    expect(text).toContain("SCOPES INCOMPLETE");
    expect(text).toContain("authorization no longer covers chat");
    screen.unmount();
  });

  test("connected accounts do not render stale details for disabled services", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        connections: [
          {
            connectionId: "google_1",
            email: "seyi@supa.media",
            syncServices: { gmail: true, calendar: false, chat: false },
            syncStatus: "active",
            gmail: {
              backfillDays: 365,
              folders: ["inbox"],
              destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
              historyCursorReady: true,
            },
            calendar: {
              destinationPath: "0-inbox/calendar/YYYY-MM-DD.md",
              syncCursorReady: true,
            },
          },
        ],
      }),
    );

    const text = screen.container.textContent ?? "";
    expect(text).toContain("Gmail · active");
    expect(text).toContain("Gmail: 1-year backfill");
    expect(text).not.toContain("Calendar:");
    expect(text).not.toContain("0-inbox/calendar/YYYY-MM-DD.md");
    screen.unmount();
  });
});
