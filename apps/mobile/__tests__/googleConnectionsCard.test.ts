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

import { afterEach, describe, expect, jest, test } from "@jest/globals";
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
let mockAiAccess: Array<{ connectionId: string; address: string; aiAccess: string }> = [];

jest.mock("convex/react", () => ({
  useAction: () => (args: unknown) => {
    mockStartCalls.push(args);
    return Promise.resolve({
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=google-state",
      completionSecret: "completion-secret",
    });
  },
  useQuery: () => mockAiAccess,
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
  test("the row is the address, once, and names no folder: nothing lands in one", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    expect(screen.text().match(/person@example\.invalid/g)).toHaveLength(1);
    expect(screen.text()).not.toContain("0-inbox/email/person-at-example-invalid");
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

  test("each mark says it is connected in words, for anybody who cannot see the dot", () => {
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
      "Email connected, Calendar connected, Chat connected",
    );
    screen.unmount();
  });
});

describe("nothing is copied, so nothing is behind", () => {
  /*
    Mail, calendar and chat are read from Google when asked and never copied
    into notes (owner, 2026-10-21). The row says "Connected" where it said
    "Up to date · 3:57 PM", and the card says what Context does now.
  */
  test("a connected account says Connected, however long ago its last copy ran", () => {
    const old = connection({
      syncStatus: "error",
      lastError: "Google is briefly unavailable.",
      gmail: {
        backfillDays: 0, folders: ["inbox"], destinationFolder: "0-inbox/email/person",
        destinationPath: "x", historyCursorReady: true, lastSyncedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
        lastFailure: "Google rate-limited this mailbox.",
      },
    });
    const screen = render(createElement(GoogleConnectionsCard, { connections: [old], actions }));
    expect(screen.text()).toContain("Connected");
    expect(screen.text()).not.toContain("Up to date");
    expect(screen.text()).not.toContain("not synced");
    expect(screen.text()).not.toContain("retrying");
    expect(screen.container.querySelector('[data-testid^="reconnect-google-"]')).toBeNull();
    screen.unmount();
  });

  // The card's promise matches the privacy policy (#2427): Google content is
  // read live and never copied in automatically, but what Tex says back, the
  // quotes it uses and notes the person keeps do stay.
  test("the card says nothing is copied in automatically, and what is kept", () => {
    const screen = render(createElement(GoogleConnectionsCard, { connections: [connection()], actions }));
    expect(screen.text()).toContain("Your AI reads mail, calendar and chat from Google when you ask, and during check-ins and routines you allow. Nothing is copied into your notes in bulk; Tex's replies, the quotes and sources they use, check-in records and any note you save stay until you delete them.");
    expect(screen.text()).not.toContain("Nothing is copied into your notes.");
    expect(screen.text()).not.toContain("land in your inbox folder");
    screen.unmount();
  });
});

describe("nothing on the row is a setting", () => {
  test("no destination field, no schedule picker", async () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
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
  test("a healthy account says Connected", () => {
    expect(accountStatus(connection())).toEqual({ tone: "ok", text: "Connected" });
  });

  test("a grant that needs reconnecting is critical, and says it in one short line", () => {
    const stale = connection({
      syncStatus: "reconnect_required",
      lastError: "Google needs to be reconnected before this mailbox can sync.",
    });
    expect(accountStatus(stale)).toEqual({ tone: "crit", text: "Google wants you to sign in again." });
  });

  // @blessing, 2026-10-23: Settings said Connected while Tex could only read her calendar.
  test("a service Context can only read is said on the row, with a Reconnect, never just Connected", () => {
    const readOnly = connection({ readOnly: ["calendar"] });
    expect(accountStatus(readOnly)).toEqual({ tone: "warn", text: "Calendar read only. Reconnect and tick Select all." });
    expect(accountStatus(connection({ readOnly: [] }))).toEqual({ tone: "ok", text: "Connected" });
    const screen = render(createElement(GoogleConnectionsCard, { connections: [readOnly], actions }));
    expect(screen.text()).toContain("Calendar read only.");
    screen.unmount();
  });

  test("a failure left by the last copying pass is not news: nothing is copied any more", () => {
    expect(accountStatus(connection({ syncStatus: "error", lastError: "Google refused this mailbox." }))).toEqual({
      tone: "ok",
      text: "Connected",
    });
    const full = connection({ syncStatus: "error", errorCode: "MAIL_QUOTA_EXCEEDED" });
    expect(accountStatus(full)).toEqual({ tone: "ok", text: "Connected" });
    const fresh = connection({ sync: { ...SYNCING, everSynced: false, cursorReady: false } });
    expect(accountStatus(fresh)).toEqual({ tone: "ok", text: "Connected" });
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

describe("allowing AI access", () => {
  /*
    Once AI reads Google through its own client, an account the person
    connected for themselves still needs that second yes before Tex or any AI
    can read it (functions/googleClients.ts). The row says so and carries it.
  */
  afterEach(() => {
    mockAiAccess = [];
  });

  test("an account AI cannot read yet says so, and its Allow goes to the agent consent for that account", async () => {
    mockAiAccess = [{ connectionId: "google_1", address: "person@example.invalid", aiAccess: "needed" }];
    mockStartCalls.length = 0;
    const screen = render(createElement(GoogleConnectionsCard, { connections: [connection()], actions }));
    expect(screen.text()).toContain("Your AI can't read it until you allow it.");
    await screen.click("allow-ai-google-google_1");
    expect(mockStartCalls).toEqual([
      { workspaceId: "ws_1", connectionId: "google_1", redirectUri: "https://context.lc/connect/google" },
    ]);
    screen.unmount();
  });

  test("before the switch, allowing AI access is offered in the menu, not as a problem on the row", async () => {
    mockAiAccess = [{ connectionId: "google_1", address: "person@example.invalid", aiAccess: "available" }];
    const screen = render(createElement(GoogleConnectionsCard, { connections: [connection()], actions }));
    expect(screen.text()).not.toContain("allow it");
    await screen.click("google-account-google_1");
    expect(document.querySelector('[data-testid="menu-allow-ai-google_1"]')).not.toBeNull();
    screen.unmount();
  });

  test("disconnecting says Google ends Context's access to the account", async () => {
    const screen = render(createElement(GoogleConnectionsCard, { connections: [connection()], actions }));
    await screen.click("google-account-google_1");
    await screen.click("menu-disconnect-google_1");
    expect(screen.text()).toContain("Google ends Context's access to this account, for you and your AI.");
    screen.unmount();
  });

  test("an account AI already reads, or with no agent client, says nothing about it", () => {
    for (const aiAccess of ["granted", "not_needed"]) {
      mockAiAccess = [{ connectionId: "google_1", address: "person@example.invalid", aiAccess }];
      const screen = render(createElement(GoogleConnectionsCard, { connections: [connection()], actions }));
      expect(screen.text()).not.toContain("allow it");
      expect(screen.container.querySelector('[data-testid^="allow-ai-google-"]')).toBeNull();
      screen.unmount();
    }
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
    expect(document.querySelector('[data-testid="connect-google"]')).toBeNull();
    expect(document.querySelector('[data-testid*="reconnect-google_1"], [data-testid^="reconnect-google-"]')).toBeNull();
    // Nothing left in the menu for them, so no menu.
    expect(document.querySelector('[data-testid="google-account-google_1"]')).toBeNull();
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
