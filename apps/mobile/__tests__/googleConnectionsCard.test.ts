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
const mockDestinationCalls: unknown[] = [];

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
          saveDestination: async () => null,
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
              destinationFolder: "0-inbox/email/seyi-at-supa-media",
              destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
              historyCursorReady: false,
            },
            calendar: {
              destinationFolder: "0-inbox/calendar",
              destinationPath: "0-inbox/calendar/YYYY-MM-DD.md",
              syncCursorReady: false,
            },
            chat: {
              destinationFolder: "2-areas/communications/daily",
              destinationPath: "2-areas/communications/daily/YYYY-MM-DD.md",
              cursorCount: 2,
            },
          },
        ],
      }),
    );

    const text = screen.container.textContent ?? "";
    expect(text).toContain("Email, Calendar, Chat connected");
    expect(text).toContain("Email");
    expect(text).toContain("Ready to backfill");
    expect(text).toContain("Start Email");
    expect(text).toContain("Email destination");
    expect(text).toContain("Calendar");
    expect(text).toContain("Connected grant; calendar sync is not running yet");
    expect(text).toContain("Start Calendar sync");
    expect(text).toContain("Chat");
    expect(text).toContain("Tracking 2 Chat spaces");
    expect(text).toContain("Start Chat sync");
    expect(text).not.toContain("cursor");
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
          saveDestination: async () => null,
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
              destinationFolder: "0-inbox/email/seyi-at-supa-media",
              destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
              historyCursorReady: false,
            },
          },
        ],
      }),
    );

    await screen.click("start-google-gmail-google_1");

    expect(mockBackfillCalls).toEqual([{ connectionId: "google_1", backfillDays: 365 }]);
    screen.unmount();
  });

  test("saving an email destination sends the edited path", async () => {
    mockDestinationCalls.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, {
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          startBackfill: async () => null,
          saveDestination: async (connectionId, service, destinationPath) => {
            mockDestinationCalls.push({ connectionId, service, destinationPath });
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
              destinationFolder: "0-inbox/email/seyi-at-supa-media",
              destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
              historyCursorReady: false,
            },
          },
        ],
      }),
    );

    const input = screen.container.querySelector<HTMLInputElement>(
      '[data-testid="google-gmail-destination-google_1"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "2-areas/communications/email/YYYY-MM-DD.md",
      );
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await screen.click("save-google-gmail-destination-google_1");

    expect(mockDestinationCalls).toEqual([
      {
        connectionId: "google_1",
        service: "gmail",
        destinationPath: "2-areas/communications/email/YYYY-MM-DD.md",
      },
    ]);
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
              destinationFolder: "0-inbox/email/seyi-at-supa-media",
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
    expect(text).toContain("Email connected");
    expect(text).toContain("Scanning Gmail · 15 of 90 days scanned · 237 emails found · 8 days had mail · 2.0 MB saved");
    expect(text).toContain("Email running");
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
              destinationFolder: "0-inbox/email/seyi-at-supa-media",
              destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
              historyCursorReady: true,
            },
            calendar: {
              destinationFolder: "0-inbox/calendar",
              destinationPath: "0-inbox/calendar/YYYY-MM-DD.md",
              syncCursorReady: true,
            },
          },
        ],
      }),
    );

    const text = screen.container.textContent ?? "";
    expect(text).toContain("Email connected");
    expect(text).toContain("Watching for new mail");
    expect(text).not.toContain("Calendar:");
    expect(text).not.toContain("0-inbox/calendar/YYYY-MM-DD.md");
    screen.unmount();
  });
});
