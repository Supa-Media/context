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
const mockBackfillCalls: unknown[] = [];

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
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          startBackfill: async () => null,
        },
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
            syncStatus: "connected",
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
    expect(text).toContain("Gmail, Calendar, Chat · connected, not synced yet");
    expect(text).toContain("Gmail: seyi@supa.media · 90-day backfill");
    expect(text).toContain("ready to start");
    expect(text).toContain("Start Gmail backfill");
    expect(text).toContain("Destination: Email inbox for seyi@supa.media");
    expect(text).toContain("Calendar: seyi@supa.media · sync controls coming next");
    expect(text).toContain("Destination: Calendar inbox");
    expect(text).toContain("Chat: seyi@supa.media · tracking 2 Chat spaces");
    expect(text).toContain("Destination: Google Chat inbox");
    expect(text).not.toContain("cursor");
    expect(text).not.toContain("seyi-at-supa-media");
    expect(text).not.toContain("YYYY-MM-DD.md");
    expect(text).toContain("SCOPES INCOMPLETE");
    expect(text).toContain("authorization no longer covers chat");
    screen.unmount();
  });

  test("the Gmail backfill button starts the account's recorded window", async () => {
    mockBackfillCalls.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, {
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          startBackfill: async (connectionId: string, backfillDays: number) => {
            mockBackfillCalls.push({ connectionId, backfillDays });
            return null;
          },
        },
        connections: [
          {
            connectionId: "google_1",
            email: "seyi@supa.media",
            syncServices: { gmail: true, calendar: false, chat: false },
            syncStatus: "connected",
            gmail: {
              backfillDays: 365,
              folders: ["inbox", "sent"],
              destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
              historyCursorReady: false,
            },
          },
        ],
      }),
    );

    await screen.click("start-google-backfill-google_1");

    expect(mockBackfillCalls).toEqual([{ connectionId: "google_1", backfillDays: 365 }]);
    screen.unmount();
  });

  test("a running Gmail backfill shows day progress instead of cursor state", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        connections: [
          {
            connectionId: "google_1",
            email: "seyi@supa.media",
            syncServices: { gmail: true, calendar: false, chat: false },
            syncStatus: "backfilling",
            gmail: {
              backfillDays: 90,
              folders: ["inbox", "sent"],
              destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
              historyCursorReady: false,
            },
            syncRun: {
              runId: "run_1",
              mode: "backfill",
              services: ["gmail"],
              status: "running",
              requestedBackfillDays: 90,
              totalUnits: 90,
              completedUnits: 15,
              itemsFound: 237,
              daysWithMail: 8,
              bytesWritten: 2_100_000,
            },
          },
        ],
      }),
    );

    const text = screen.container.textContent ?? "";
    expect(text).toContain("Gmail · syncing");
    expect(text).toContain("Scanning Gmail · 15 of 90 days scanned · 237 emails found · 8 days had mail · 2.0 MB saved");
    expect(text).toContain("Backfill running");
    expect(text).not.toContain("cursor");
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
    expect(text).toContain("Gmail · watching for new changes");
    expect(text).toContain("Gmail: seyi@supa.media · 1-year backfill");
    expect(text).not.toContain("Calendar:");
    expect(text).not.toContain("0-inbox/calendar/YYYY-MM-DD.md");
    screen.unmount();
  });
});
