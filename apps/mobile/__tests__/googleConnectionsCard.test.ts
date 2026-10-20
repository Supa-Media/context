/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://context.lc/"}
 */

/**
 * One row per Google account, and nothing on it that is a setting.
 *
 * This card was drawn three times on one page — once under Email, once under
 * Calendar, once under Chats — and each copy carried a destination field per
 * service, a six-button schedule picker and its own Disconnect. Two accounts
 * meant six cards and eighteen interval buttons for two values.
 *
 * What this file pins is the shape that replaced it (the owner's pick, board 2,
 * 2026-10-17), and the claims that are easy to lose while simplifying:
 *
 *  1. **An account is one row**: the address, one sentence and a mark per
 *     service with its own dot. Folders and times are behind its "…" menu.
 *  2. **The account's health is the account's** — a stale grant is on the row,
 *     and so is a service that stopped, by name, rather than "Syncing."
 *  3. **A broken account carries its own Reconnect** on the row, as well as in
 *     the menu, which goes to Google with that address as the login hint.
 *  4. **Disconnect is an account action** and says so before the second press.
 *  5. **The owner gate survived the rewrite**: no `actions`, no controls at
 *     all, rather than controls that are disabled.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider } from "../features/design/theme";
import {
  GoogleConnectionsCard,
  accountStatus,
  type GoogleActions,
  type GoogleConnection,
  type GoogleSyncSchedule,
} from "../features/console/google/GoogleConnectionsCard";

/** A connection that has actually read mail. */
const SYNCING: GoogleSyncSchedule = {
  intervalMinutes: 5,
  everSynced: true,
  cursorReady: true,
  catchingUp: false,
  lastAttemptAt: Date.parse("2026-09-09T09:00:00.000Z"),
  nextDueAt: Date.parse("2026-09-09T09:05:00.000Z"),
};

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

function connection(overrides: Partial<GoogleConnection> = {}): GoogleConnection {
  return {
    connectionId: "google_1",
    email: "person@example.invalid",
    syncServices: { gmail: true, calendar: true, chat: true },
    syncStatus: "active",
    sync: SYNCING,
    gmail: {
      backfillDays: 0,
      folders: ["inbox"],
      destinationFolder: "0-inbox/email/person-at-example-invalid",
      destinationPath: "0-inbox/email/person-at-example-invalid/YYYY/MM/YYYY-MM-DD.md",
      historyCursorReady: true,
    },
    ...overrides,
  };
}

const disconnects: string[] = [];
const actions: GoogleActions = {
  workspaceId: "ws_1",
  disconnect: async (connectionId: string) => {
    disconnects.push(connectionId);
    return null;
  },
};

function render(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onCaughtError: () => {}, onUncaughtError: () => {} });
  act(() => {
    root.render(
      createElement(SafeAreaProvider, {
        initialMetrics: {
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, left: 0, right: 0, bottom: 0 },
        },
        children: createElement(ThemeProvider, { scheme: "dark", children: node }),
      }),
    );
  });
  return {
    container,
    text: () => container.textContent ?? "",
    click: async (testID: string) => {
      // The "…" menu renders in a portal, outside the card's container.
      const element = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
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

describe("an account is one row", () => {
  test("the row is the address, once, and the folders wait behind its menu", async () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    expect(screen.text().match(/person@example\.invalid/g)).toHaveLength(1);
    expect(screen.text()).not.toContain("0-inbox/email/person-at-example-invalid");
    await screen.click("google-account-google_1");
    await screen.click("menu-folders-google_1");
    expect(screen.text()).toContain("0-inbox/email/person-at-example-invalid");
    screen.unmount();
  });

  test("a mark per granted service, and none for the rest", () => {
    const screen = render(createElement(GoogleConnectionsCard, {
      connections: [connection({ syncServices: { gmail: true, calendar: true, chat: false } })],
      actions,
    }));
    expect(
      screen.container.querySelectorAll('[data-icon="mail"], [data-icon="calendar"], [data-icon="chat"]'),
    ).toHaveLength(2);
    screen.unmount();
  });

  test("each mark says its own health in words, for anybody who cannot see the dot", () => {
    const screen = render(createElement(GoogleConnectionsCard, {
      connections: [connection({
        gmail: {
          backfillDays: 0, folders: ["inbox"], destinationFolder: "0-inbox/email/person",
          destinationPath: "x", historyCursorReady: true, lastSyncedAt: Date.now() - 60_000, lastFailure: "Google rate-limited this mailbox.",
        },
        calendar: { destinationFolder: "0-inbox/calendar", destinationPath: "x", syncCursorReady: true, lastSyncedAt: Date.now() - 60_000 },
      })],
      actions,
    }));
    expect(screen.container.innerHTML).toContain(
      "Email paused, Calendar up to date, Chat waiting for its first sync",
    );
    screen.unmount();
  });
});

describe("where connected data appears", () => {
  test("each service says its own folder and its own delivery state", async () => {
    const screen = render(createElement(GoogleConnectionsCard, {
      connections: [connection({
        calendar: {
          destinationFolder: "0-inbox/calendar", destinationPath: "0-inbox/calendar/YYYY-MM-DD.md",
          syncCursorReady: true, lastSyncedAt: Date.now() - 60_000,
        },
        chat: { destinationFolder: "hidden-chat-folder", destinationPath: "x", cursorCount: 0 },
        syncServices: { gmail: true, calendar: true, chat: false },
      })], actions,
    }));
    await screen.click("google-account-google_1");
    await screen.click("menu-folders-google_1");
    expect(screen.text()).toContain("Up to date · ");
    expect(screen.text()).toContain("Waiting for the first sync.");
    expect(screen.text()).not.toContain("hidden-chat-folder");
    screen.unmount();
  });

  test("a service's own failure is shown on its line, with when it last delivered", async () => {
    const screen = render(createElement(GoogleConnectionsCard, {
      connections: [connection({
        gmail: {
          backfillDays: 0, folders: ["inbox"], destinationFolder: "0-inbox/email/person",
          destinationPath: "0-inbox/email/person/YYYY-MM-DD.md", historyCursorReady: true,
          lastSyncedAt: Date.parse("2026-09-29T12:56:26Z"),
          lastFailure: "Google rate-limited this mailbox. The next scheduled pass will try again.",
        },
      })], actions,
    }));
    await screen.click("google-account-google_1");
    await screen.click("menu-folders-google_1");
    expect(screen.text()).toContain("Last new mail");
    expect(screen.text()).toContain("Google rate-limited this mailbox.");
    screen.unmount();
  });
});

describe("nothing on the row is a setting", () => {
  test("no destination field, no schedule picker", async () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    await screen.click("google-account-google_1");
    await screen.click("menu-folders-google_1");
    expect(screen.text()).not.toContain("Where it lands");
    expect(screen.text()).not.toContain("Sync schedule");
    expect(screen.container.querySelector('[data-testid^="edit-google-"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid^="google-sync-interval-"]')).toBeNull();
    screen.unmount();
  });

  test("and no product toggles on the way in: Google is asked for all three at once", async () => {
    mockStartCalls.length = 0;
    const screen = render(createElement(GoogleConnectionsCard, { connections: [], actions }));
    await screen.click("connect-google");
    expect(mockStartCalls[0]).toMatchObject({
      syncServices: { gmail: true, calendar: true, chat: true },
    });
    expect(mockStartCalls[0]).not.toHaveProperty("loginHint");
    screen.unmount();
  });
});

describe("the account's health belongs to the account", () => {
  test("a healthy account says so in one line", () => {
    expect(accountStatus(connection())).toEqual({ tone: "ok", text: "Up to date." });
  });

  test("a grant that needs reconnecting is critical, and says it in one short line", () => {
    const stale = connection({
      syncStatus: "reconnect_required",
      lastError: "Google needs to be reconnected before this mailbox can sync.",
    });
    expect(accountStatus(stale)).toEqual({ tone: "crit", text: "Google wants you to sign in again." });
  });

  test("...and any other failure keeps the server's own sentence, and retries without them", () => {
    const failed = connection({ syncStatus: "error", lastError: "Google refused this mailbox." });
    expect(accountStatus(failed)).toEqual({ tone: "warn", text: "Google refused this mailbox. Retrying on its own." });
    expect(accountStatus(connection({ syncStatus: "error" }))).toEqual({
      tone: "warn",
      text: "Not syncing right now; retrying on its own.",
    });
  });

  test("a full mailbox is the person's to fix, and says so without offering a reconnect", () => {
    const full = connection({ syncStatus: "error", errorCode: "MAIL_QUOTA_EXCEEDED", lastError: "This connection reached its storage quota." });
    expect(accountStatus(full)).toEqual({ tone: "crit", text: "Email storage is full, so new mail isn't being saved." });
    const screen = render(createElement(GoogleConnectionsCard, { connections: [full], actions }));
    expect(screen.container.querySelector('[data-testid^="reconnect-google-"]')).toBeNull();
    screen.unmount();
  });

  test("an account with no successful pass for hours says when it last synced, never 'Up to date'", () => {
    const now = Date.parse("2026-10-20T18:00:00Z");
    const at = now - 9 * 60 * 60 * 1000;
    const quiet = connection({
      syncServices: { gmail: true, calendar: false, chat: false },
      gmail: {
        backfillDays: 0, folders: ["inbox"], destinationFolder: "0-inbox/email/person",
        destinationPath: "x", historyCursorReady: true, lastSyncedAt: at,
      },
    });
    expect(accountStatus(quiet, now)).toEqual({ tone: "warn", text: "Not synced since 9 hours ago." });
    // Five hours is not yet stale: a slow afternoon of mail, not a broken sync.
    expect(accountStatus({ ...quiet, gmail: { ...quiet.gmail!, lastSyncedAt: now - 5 * 60 * 60 * 1000 } }, now).tone).toBe("ok");
  });

  test("...naming the service when only one of them stopped, even while it is failing", () => {
    const now = Date.parse("2026-10-20T18:00:00Z");
    const stale = connection({
      syncStatus: "error",
      lastError: "Google is briefly unavailable.",
      syncServices: { gmail: true, calendar: true, chat: false },
      gmail: {
        backfillDays: 0, folders: ["inbox"], destinationFolder: "0-inbox/email/person",
        destinationPath: "x", historyCursorReady: true, lastSyncedAt: now - 3 * 24 * 60 * 60 * 1000,
      },
      calendar: { destinationFolder: "0-inbox/calendar", destinationPath: "x", syncCursorReady: true, lastSyncedAt: now - 60_000 },
    });
    expect(accountStatus(stale, now)).toEqual({ tone: "warn", text: "Email not synced since 3 days ago." });
  });

  test("a stale account's row has no Reconnect: only Google refusing the grant offers one", () => {
    const screen = render(createElement(GoogleConnectionsCard, {
      connections: [connection({
        syncStatus: "error",
        gmail: {
          backfillDays: 0, folders: ["inbox"], destinationFolder: "0-inbox/email/person",
          destinationPath: "x", historyCursorReady: true, lastSyncedAt: Date.now() - 10 * 60 * 60 * 1000,
        },
      })],
      actions,
    }));
    expect(screen.text()).toContain("Email not synced since 10 hours ago.");
    expect(screen.text()).not.toContain("Up to date");
    expect(screen.container.querySelector('[data-testid^="reconnect-google-"]')).toBeNull();
    screen.unmount();
  });

  test("a service that stopped reaches the row by name, never as green 'Syncing'", () => {
    const status = accountStatus(connection({
      gmail: {
        backfillDays: 0, folders: ["inbox"], destinationFolder: "0-inbox/email/person",
        destinationPath: "0-inbox/email/person/YYYY-MM-DD.md", historyCursorReady: true,
        lastFailure: "Google rate-limited this mailbox.",
      },
      calendar: { destinationFolder: "0-inbox/calendar", destinationPath: "x", syncCursorReady: true },
      chat: { destinationFolder: "0-inbox/google-chat", destinationPath: "x", cursorCount: 1 },
    }));
    expect(status).toEqual({
      tone: "warn",
      text: "Email paused, retrying on its own.",
    });
  });

  test("connected and never synced is a state of its own, not an error", () => {
    const fresh = connection({ sync: { ...SYNCING, everSynced: false, cursorReady: false } });
    expect(accountStatus(fresh)).toEqual({
      tone: "warn",
      text: "Connected; waiting for the first pass.",
    });
  });

  test("the reason reaches the row itself rather than a panel somebody has to open", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        connections: [connection({ syncStatus: "reconnect_required" })],
        actions,
      }),
    );
    expect(screen.text()).toContain("Google wants you to sign in again.");
    screen.unmount();
  });
});

describe("reconnect is on the broken row", () => {
  test("it goes to Google for all three products with that account's address as the hint", async () => {
    mockStartCalls.length = 0;
    const screen = render(createElement(GoogleConnectionsCard, {
      connections: [connection(), connection({
        connectionId: "google_2", email: "stale@example.invalid", syncStatus: "reconnect_required",
      })],
      actions,
    }));
    await screen.click("reconnect-google-google_2");
    await act(async () => {});
    expect(mockStartCalls[0]).toMatchObject({
      workspaceId: "ws_1",
      syncServices: { gmail: true, calendar: true, chat: true },
      loginHint: "stale@example.invalid",
    });
    screen.unmount();
  });

  test("...and the menu offers the same reconnect on any account", async () => {
    mockStartCalls.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    await screen.click("google-account-google_1");
    await screen.click("menu-reconnect-google_1");
    await act(async () => {});
    expect(mockStartCalls[0]).toMatchObject({ loginHint: "person@example.invalid" });
    screen.unmount();
  });

  test("a healthy account has no Reconnect on its row", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    expect(screen.container.querySelector('[data-testid^="reconnect-google-"]')).toBeNull();
    screen.unmount();
  });

  test("a rate-limited service is not a reason to put Reconnect on the row", () => {
    const screen = render(createElement(GoogleConnectionsCard, {
      connections: [connection({
        gmail: {
          backfillDays: 0, folders: ["inbox"], destinationFolder: "0-inbox/email/person",
          destinationPath: "x", historyCursorReady: true, lastFailure: "Google rate-limited this mailbox.",
        },
      })],
      actions,
    }));
    expect(screen.container.querySelector('[data-testid^="reconnect-google-"]')).toBeNull();
    screen.unmount();
  });
});

describe("disconnect is an account action", () => {
  test("it lives in the menu, and asks before it acts", async () => {
    disconnects.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    expect(screen.container.querySelector('[data-testid="disconnect-google-google_1"]')).toBeNull();
    await screen.click("google-account-google_1");
    await screen.click("menu-disconnect-google_1");
    expect(disconnects).toEqual([]);
    expect(screen.text()).toContain("Email, Calendar and Chat stop for person@example.invalid");
    await screen.click("disconnect-google-google_1");
    expect(disconnects).toEqual(["google_1"]);
    screen.unmount();
  });

  test("...and Keep it backs out without disconnecting", async () => {
    disconnects.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    await screen.click("google-account-google_1");
    await screen.click("menu-disconnect-google_1");
    await screen.click("keep-google-google_1");
    expect(disconnects).toEqual([]);
    expect(screen.container.querySelector('[data-testid="disconnect-google-google_1"]')).toBeNull();
    screen.unmount();
  });

  test("the spoken label carries the same consequence the sighted reader gets", async () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    await screen.click("google-account-google_1");
    await screen.click("menu-disconnect-google_1");
    const button = screen.container.querySelector('[data-testid="disconnect-google-google_1"]');
    expect(button?.getAttribute("aria-label")).toContain("stops Email, Calendar and Chat");
    screen.unmount();
  });
});

describe("the owner gate", () => {
  test("no actions means no Add, Reconnect or Disconnect at all, rather than disabled ones", async () => {
    const screen = render(createElement(GoogleConnectionsCard, {
      connections: [connection({ syncStatus: "reconnect_required" })],
    }));
    await screen.click("google-account-google_1");
    expect(document.querySelector('[data-testid="connect-google"]')).toBeNull();
    expect(document.querySelector('[data-testid*="reconnect-google_1"], [data-testid^="reconnect-google-"]')).toBeNull();
    expect(document.querySelector('[data-testid^="menu-disconnect-"]')).toBeNull();
    expect(document.querySelector('[data-testid="menu-folders-google_1"]')).not.toBeNull();
    expect(screen.text()).toContain("Only an owner can connect or remove Google accounts");
    screen.unmount();
  });

  test("an empty list offers Connect Google rather than a sentence about having none", () => {
    const screen = render(createElement(GoogleConnectionsCard, { connections: [], actions }));
    expect(screen.container.querySelector('[data-testid="connect-google"]')?.textContent).toContain(
      "Connect Google",
    );
    expect(screen.text()).not.toContain("No Google account connected yet");
    screen.unmount();
  });

  test("loading says so rather than claiming there is nothing", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [], actions, loading: true }),
    );
    expect(screen.text()).toContain("Loading Google accounts");
    expect(screen.text()).not.toContain("No Google account connected yet");
    screen.unmount();
  });
});
