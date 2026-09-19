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
 * What this file pins is the shape that replaced it, and the two claims that
 * are easy to lose while simplifying:
 *
 *  1. **An account is one row**, whatever it carries, with a mark per service.
 *  2. **The account's health is the account's** — a stale grant is on the row,
 *     not hidden under whichever of three headings somebody opened.
 *  3. **Disconnect is an account action** and says so before the second press.
 *  4. **The owner gate survived the rewrite**: no `actions`, no controls at
 *     all, rather than controls that are disabled.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

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
    root.render(createElement(ThemeProvider, { scheme: "dark", children: node }));
  });
  return {
    container,
    text: () => container.textContent ?? "",
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

describe("an account is one row", () => {
  test("the row is the address, and the card is drawn once however many services it carries", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    const text = screen.text();
    expect(text).toContain("person@example.invalid");
    // Once. Three copies of the address is the page this rewrite replaced.
    expect(text.match(/person@example\.invalid/g)).toHaveLength(1);
    screen.unmount();
  });

  test("the services are marks, one per granted product", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    const marks = screen.container.querySelectorAll('[data-icon="mail"], [data-icon="calendar"], [data-icon="chat"]');
    expect(marks).toHaveLength(3);
    screen.unmount();
  });

  test("...and an account that granted two carries two", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        connections: [connection({ syncServices: { gmail: true, calendar: true, chat: false } })],
        actions,
      }),
    );
    expect(
      screen.container.querySelectorAll('[data-icon="mail"], [data-icon="calendar"], [data-icon="chat"]'),
    ).toHaveLength(2);
    screen.unmount();
  });

  test("the marks are named in words for anybody who cannot see them", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    expect(screen.container.innerHTML).toContain("Syncing Email, Calendar and Chat");
    screen.unmount();
  });
});

describe("nothing on the row is a setting", () => {
  test("no destination field, and no path to edit", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    expect(screen.text()).not.toContain("Where it lands");
    expect(screen.container.querySelector('[data-testid^="edit-google-"]')).toBeNull();
    screen.unmount();
  });

  test("no schedule picker — the interval is a fact the page states once, not a choice per account", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    expect(screen.text()).not.toContain("Sync schedule");
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
    screen.unmount();
  });
});

describe("the account's health belongs to the account", () => {
  test("a healthy account says so in one line", () => {
    expect(accountStatus(connection())).toEqual({ tone: "ok", text: "Syncing." });
  });

  test("a grant that needs reconnecting is critical, and says what to do", () => {
    const stale = connection({ syncStatus: "reconnect_required" });
    expect(accountStatus(stale).tone).toBe("crit");
    expect(accountStatus(stale).text).toContain("Reconnect");
  });

  test("...and the server's own sentence wins, because it names the reason", () => {
    const stale = connection({
      syncStatus: "reconnect_required",
      lastError: "Google needs to be reconnected before this mailbox can sync.",
    });
    expect(accountStatus(stale).text).toBe(
      "Google needs to be reconnected before this mailbox can sync.",
    );
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
    expect(screen.text()).toContain("Reconnect this account");
    screen.unmount();
  });
});

describe("disconnect is an account action", () => {
  test("it arms before it acts", async () => {
    disconnects.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    await screen.click("disconnect-google-google_1");
    expect(disconnects).toEqual([]);
    expect(screen.text()).toContain("Press again");
    screen.unmount();
  });

  test("...and says which services stop, between the two presses", async () => {
    disconnects.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    await screen.click("disconnect-google-google_1");
    expect(screen.text()).toContain("Email, Calendar and Chat stop");
    await screen.click("disconnect-google-google_1");
    expect(disconnects).toEqual(["google_1"]);
    screen.unmount();
  });

  test("the spoken label carries the same consequence the sighted reader gets", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, { connections: [connection()], actions }),
    );
    const button = screen.container.querySelector('[data-testid="disconnect-google-google_1"]');
    expect(button?.getAttribute("aria-label")).toContain("stops Email, Calendar and Chat");
    screen.unmount();
  });
});

describe("the owner gate", () => {
  test("no actions means no Add and no Disconnect at all, rather than disabled ones", () => {
    const screen = render(createElement(GoogleConnectionsCard, { connections: [connection()] }));
    expect(screen.container.querySelector('[data-testid="connect-google"]')).toBeNull();
    expect(screen.container.querySelector('[data-testid="disconnect-google-google_1"]')).toBeNull();
    expect(screen.text()).toContain("Only an owner can connect or remove Google accounts");
    screen.unmount();
  });

  test("an empty list still says what connecting one would do", () => {
    const screen = render(createElement(GoogleConnectionsCard, { connections: [], actions }));
    expect(screen.text()).toContain("No Google account connected yet");
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
