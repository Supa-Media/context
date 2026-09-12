/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://context.lc/"}
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ThemeProvider } from "../features/design/theme";
import {
  GoogleConnectionsCard,
  type GoogleConnection,
  type GoogleSyncSchedule,
} from "../features/console/google/GoogleConnectionsCard";

/** A connection that is polled hourly and has actually read mail. */
const SYNCING_HOURLY: GoogleSyncSchedule = {
  intervalMinutes: 60,
  everSynced: true,
  cursorReady: true,
  catchingUp: false,
  lastAttemptAt: Date.parse("2026-09-09T09:00:00.000Z"),
  nextDueAt: Date.parse("2026-09-09T10:00:00.000Z"),
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockStartCalls: unknown[] = [];
const mockNavigations: string[] = [];
const mockDestinationCalls: unknown[] = [];
const mockIntervalCalls: { connectionId: string; syncIntervalMinutes: number }[] = [];

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
  test("connect sends the selected Google services without a history window", async () => {
    mockStartCalls.length = 0;
    mockNavigations.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, {
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          saveDestination: async () => null,
          saveSyncInterval: async () => null,
        },
      }),
    );

    expect(screen.container.textContent).not.toContain("Gmail Backfill");
    expect(screen.container.textContent).not.toContain("90 days");
    await screen.click("connect-google");

    expect(mockStartCalls).toHaveLength(1);
    expect(mockStartCalls[0]).toMatchObject({
      workspaceId: "ws_1",
      syncServices: { gmail: true, calendar: true, chat: true },
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
            sync: SYNCING_HOURLY,
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
    /*
      The per-account summary line ("Email, Calendar, Chat connected") is gone
      from the whole-account card, and what replaced it is stronger: each
      service states its own status and its own destination directly below,
      so the three assertions here are about the three blocks rather than
      about a sentence summarising them. On a *narrowed* panel the same list
      survives as the sentence qualifying Disconnect, which is where it is
      load-bearing — see `communicationsPanels.test.ts`.
    */
    expect(text).not.toContain("Email, Calendar, Chat connected");
    expect(text).toContain("Email");
    expect(text).toContain("Connected; forward sync setup is pending");
    expect(text).not.toContain("Start Email");
    // Where each one writes, stated at rest rather than only inside a field.
    expect(text).toContain("0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md");
    expect(text).toContain("0-inbox/calendar/YYYY-MM-DD.md");
    expect(text).toContain("2-areas/communications/daily/YYYY-MM-DD.md");
    expect(text).toContain("Calendar");
    expect(text).toContain("Connected; upcoming event sync setup is pending");
    expect(text).not.toContain("Start Calendar sync");
    expect(text).toContain("Chat");
    expect(text).toContain("Ready for 2 Chat spaces");
    expect(text).not.toContain("Start Chat sync");
    expect(text).not.toContain("cursor");
    expect(text).toContain("SCOPES INCOMPLETE");
    expect(text).toContain("authorization no longer covers chat");
    screen.unmount();
  });

  test("saving an email destination sends the edited path", async () => {
    mockDestinationCalls.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, {
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          saveDestination: async (connectionId, service, destinationPath) => {
            mockDestinationCalls.push({ connectionId, service, destinationPath });
            return null;
          },
          saveSyncInterval: async (connectionId, syncIntervalMinutes) => {
            mockIntervalCalls.push({ connectionId, syncIntervalMinutes });
            return null;
          },
        },
        connections: [
          {
            connectionId: "google_1",
            email: "seyi@supa.media",
            syncServices: { gmail: true, calendar: false, chat: false },
            syncStatus: "connected",
            sync: SYNCING_HOURLY,
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

    /*
      The field is behind Change now. Three destinations drawn as open forms is
      what the account card used to be, and nobody edits three paths at once —
      so the resting state states the path and Change opens the editor.
    */
    expect(
      screen.container.querySelector('[data-testid="google-gmail-destination-google_1"]'),
    ).toBeNull();
    await screen.click("edit-google-gmail-destination-google_1");

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

  /*
    The editor, which is the whole of the P8 fix: the field used to be a plain
    TextField with a hint sentence, no completion, no validation and no
    preview, and the mutation was the first thing that checked. These four
    assert the three things that replaced that — and each is a claim about
    where somebody's mail is about to be written.
  */
  describe("the destination editor", () => {
    function editorScreen(saver = true) {
      return render(
        createElement(GoogleConnectionsCard, {
          folders: ["2-areas", "2-areas/communications", "2-areas/comms-archive", ".audit"],
          actions: saver
            ? {
                workspaceId: "ws_1",
                disconnect: async () => null,
                saveDestination: async (connectionId, service, destinationPath) => {
                  mockDestinationCalls.push({ connectionId, service, destinationPath });
                  return null;
                },
                saveSyncInterval: async () => null,
              }
            : undefined,
          connections: [
            {
              connectionId: "google_1",
              email: "seyi@supa.media",
              syncServices: { gmail: true, calendar: false, chat: false },
              syncStatus: "connected",
              sync: SYNCING_HOURLY,
              gmail: {
                backfillDays: 365,
                folders: ["inbox", "sent"],
                destinationFolder: "0-inbox/email/seyi-at-supa-media",
                destinationPath: "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
                historyCursorReady: true,
              },
            },
          ],
        }),
      );
    }

    async function type(screen: ReturnType<typeof render>, value: string) {
      const input = screen.container.querySelector<HTMLInputElement>(
        '[data-testid="google-gmail-destination-google_1"]',
      );
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          input,
          value,
        );
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    test("offers the folders this console has loaded, and never a reserved one", async () => {
      const screen = editorScreen();
      await screen.click("edit-google-gmail-destination-google_1");
      await type(screen, "2-areas/comm");

      expect(
        screen.container.querySelector(
          '[data-testid="google-gmail-suggest-google_1-2-areas/communications"]',
        ),
      ).not.toBeNull();
      // A suggestion the validator would then refuse is worse than none.
      expect(
        screen.container.querySelector('[data-testid="google-gmail-suggest-google_1-.audit"]'),
      ).toBeNull();
      screen.unmount();
    });

    test("says what the pattern writes today, which nothing ever did before", async () => {
      const screen = editorScreen();
      await screen.click("edit-google-gmail-destination-google_1");
      await type(screen, "2-areas/communications");

      const preview = screen.container.querySelector(
        '[data-testid="google-gmail-preview-google_1"]',
      );
      expect(preview).not.toBeNull();
      // The day is the reader's, so the assertion is built the same way rather
      // than pinned to a date this suite would fail on tomorrow.
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
        now.getDate(),
      ).padStart(2, "0")}`;
      expect(preview!.textContent).toContain(`2-areas/communications/${today}.md`);
      screen.unmount();
    });

    test("refuses in the server's own words before the round trip, and will not save", async () => {
      const screen = editorScreen();
      await screen.click("edit-google-gmail-destination-google_1");
      await type(screen, ".audit/mail");

      expect(screen.container.textContent).toContain(
        "That folder is reserved for Context internals.",
      );
      const save = screen.container.querySelector<HTMLElement>(
        '[data-testid="save-google-gmail-destination-google_1"]',
      );
      expect(save!.getAttribute("aria-disabled")).toBe("true");

      // And nothing reached the control plane.
      mockDestinationCalls.length = 0;
      await screen.click("save-google-gmail-destination-google_1");
      expect(mockDestinationCalls).toEqual([]);
      screen.unmount();
    });

    test("will not save the destination that is already stored, however it is spelled", async () => {
      const screen = editorScreen();
      await screen.click("edit-google-gmail-destination-google_1");
      await type(screen, "0-inbox/email/seyi-at-supa-media/");

      const save = screen.container.querySelector<HTMLElement>(
        '[data-testid="save-google-gmail-destination-google_1"]',
      );
      expect(save!.getAttribute("aria-disabled")).toBe("true");
      screen.unmount();
    });

    test("cancelling puts the stored value back", async () => {
      const screen = editorScreen();
      await screen.click("edit-google-gmail-destination-google_1");
      await type(screen, "2-areas/communications");
      await screen.click("cancel-google-gmail-destination-google_1");

      expect(
        screen.container.querySelector('[data-testid="google-gmail-destination-google_1"]'),
      ).toBeNull();
      expect(screen.container.textContent).toContain(
        "0-inbox/email/seyi-at-supa-media/YYYY-MM-DD.md",
      );
      screen.unmount();
    });
  });

  /*
    The consequence of Disconnect used to sit beside the button permanently —
    once per account, on a panel with two of them, making destructive text the
    loudest thing on the page. It is armed now, like every other irreversible
    control in this console.
  */
  test("what Disconnect takes with it is said between the presses, not beside the button", async () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "calendar",
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          saveDestination: async () => null,
          saveSyncInterval: async () => null,
        },
        connections: [
          {
            connectionId: "google_1",
            email: "seyi@supa.media",
            syncServices: { gmail: true, calendar: true, chat: false },
            syncStatus: "active",
            sync: SYNCING_HOURLY,
            gmail: {
              backfillDays: 90,
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

    // At rest: the quiet line that a narrowed panel genuinely needs, and no
    // warning shouting from a column of its own.
    expect(screen.container.textContent).toContain("This account also syncs Email.");
    expect(screen.container.textContent).not.toContain("Removes the whole account");

    const disconnect = screen.container.querySelector<HTMLElement>(
      '[aria-label="Disconnect seyi@supa.media, which also stops Email"]',
    );
    expect(disconnect).not.toBeNull();
    await act(async () => {
      disconnect!.click();
    });

    expect(screen.container.textContent).toContain("This removes the whole account");
    expect(screen.container.textContent).toContain("Email stop too");
    screen.unmount();
  });

  test("a draining historical Gmail import says it is stopping", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        connections: [
          {
            connectionId: "google_1",
            email: "seyi@supa.media",
            syncServices: { gmail: true, calendar: false, chat: false },
            syncStatus: "backfilling",
            sync: SYNCING_HOURLY,
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
    // The summary line went; the block's own status is the claim now.
    expect(text).not.toContain("Email connected");
    expect(text).toContain("Stopping historical import · 15 of 90 days scanned · 237 emails found · 8 days had mail · 2.0 MB saved");
    expect(text).not.toContain("Email running");
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
            sync: SYNCING_HOURLY,
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
    // The summary line went; the block's own status is the claim now.
    expect(text).not.toContain("Email connected");
    expect(text).toContain("Ready for new mail");
    expect(text).not.toContain("Calendar:");
    expect(text).not.toContain("0-inbox/calendar/YYYY-MM-DD.md");
    screen.unmount();
  });
});

/**
 * THE SCHEDULE, WHICH IS THE PART THAT WAS MISSING.
 *
 * A connected mailbox that had never synced once and one syncing perfectly
 * rendered the same card. These checks are what stops that returning: the
 * sentence has to say which of the two this is, and the control that changes
 * it has to be the owner's alone.
 */
describe("the sync schedule on a connected account", () => {
  const neverSynced: GoogleSyncSchedule = {
    intervalMinutes: 15,
    everSynced: false,
    cursorReady: false,
    catchingUp: false,
  };

  function connection(sync: GoogleSyncSchedule): GoogleConnection {
    return {
      connectionId: "google_1",
      email: "person@example.invalid",
      syncServices: { gmail: true, calendar: false, chat: false },
      syncStatus: "active",
      sync,
      gmail: {
        backfillDays: 90,
        folders: ["inbox", "sent"],
        destinationFolder: "0-inbox/email/person-at-example-invalid",
        destinationPath: "0-inbox/email/person-at-example-invalid/YYYY-MM-DD.md",
        historyCursorReady: true,
      },
    };
  }

  test("a connection that has never synced says so, rather than looking healthy", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [connection(neverSynced)],
      }),
    );
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Every 15 min");
    expect(text).toContain("never synced yet");
    expect(text).toContain("due now");
    screen.unmount();
  });

  test("...and one that has synced does not", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [connection(SYNCING_HOURLY)],
      }),
    );
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Every 1 hour");
    expect(text).not.toContain("never synced");
    screen.unmount();
  });

  test("a pass that has only ever failed is not reported as never having been tried", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [
          connection({
            intervalMinutes: 15,
            everSynced: false,
            cursorReady: false,
            catchingUp: false,
            lastAttemptAt: Date.parse("2026-09-09T09:00:00.000Z"),
            nextDueAt: Date.parse("2026-09-09T09:15:00.000Z"),
            lastFailureAt: Date.parse("2026-09-09T09:00:00.000Z"),
            lastFailureCode: "GOOGLE_ACCESS_REFUSED",
            lastFailure: "Google refused access to this mailbox.",
          }),
        ],
      }),
    );
    const text = screen.container.textContent ?? "";
    expect(text).toContain("has not synced successfully yet");
    expect(text).toContain("Google refused access to this mailbox.");
    screen.unmount();
  });

  test("a Calendar panel is not shown a schedule that only advances mail", () => {
    const account = connection(neverSynced);
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "calendar",
        connections: [
          {
            ...account,
            syncServices: { gmail: true, calendar: true, chat: false },
            calendar: {
              destinationFolder: "0-inbox/calendar",
              destinationPath: "0-inbox/calendar/YYYY-MM-DD.md",
              syncCursorReady: false,
            },
          },
        ],
      }),
    );
    const text = screen.container.textContent ?? "";
    expect(text).not.toContain("Sync schedule");
    expect(text).not.toContain("Every 15 min");
    // Calendar's own honest sentence is still there.
    expect(text).toContain("Connected; upcoming event sync setup is pending");
    screen.unmount();
  });

  test("a baselined mailbox says it is watching, not that it has synced", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [
          connection({
            intervalMinutes: 15,
            everSynced: false,
            cursorReady: true,
            catchingUp: false,
            lastAttemptAt: Date.parse("2026-09-09T09:00:00.000Z"),
            nextDueAt: Date.parse("2026-09-09T09:15:00.000Z"),
          }),
        ],
      }),
    );
    const text = screen.container.textContent ?? "";
    expect(text).toContain("watching for new mail; none read yet");
    expect(text).not.toContain("never synced yet");
    screen.unmount();
  });

  test("a mailbox draining a backlog says so instead of naming a next due time", () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [
          connection({
            intervalMinutes: 60,
            everSynced: true,
            cursorReady: true,
            catchingUp: true,
            lastAttemptAt: Date.parse("2026-09-09T09:00:00.000Z"),
            nextDueAt: Date.parse("2026-09-09T09:00:00.000Z"),
          }),
        ],
      }),
    );
    const text = screen.container.textContent ?? "";
    expect(text).toContain("catching up on older mail");
    screen.unmount();
  });

  test("the picker is the owner's alone — absent for anybody else, not disabled", () => {
    const withoutActions = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [connection(neverSynced)],
      }),
    );
    expect(
      withoutActions.container.querySelector('[data-testid="google-sync-interval-5-google_1"]'),
    ).toBeNull();
    // The status itself is still shown: somebody who cannot change the
    // schedule can still need to know the last pass failed.
    expect(withoutActions.container.textContent).toContain("Every 15 min");
    withoutActions.unmount();

    const asOwner = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [connection(neverSynced)],
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          saveDestination: async () => null,
          saveSyncInterval: async () => null,
        },
      }),
    );
    expect(
      asOwner.container.querySelector('[data-testid="google-sync-interval-5-google_1"]'),
    ).not.toBeNull();
    asOwner.unmount();
  });

  test("choosing an interval sends exactly that many minutes", async () => {
    mockIntervalCalls.length = 0;
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [connection(neverSynced)],
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          saveDestination: async () => null,
          saveSyncInterval: async (connectionId, syncIntervalMinutes) => {
            mockIntervalCalls.push({ connectionId, syncIntervalMinutes });
            return null;
          },
        },
      }),
    );
    await screen.click("google-sync-interval-5-google_1");
    expect(mockIntervalCalls).toEqual([{ connectionId: "google_1", syncIntervalMinutes: 5 }]);
    screen.unmount();
  });

  test("a schedule the server refuses is shown, not swallowed", async () => {
    const screen = render(
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [connection(neverSynced)],
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          saveDestination: async () => null,
          saveSyncInterval: async () => {
            throw new Error("Sync can run at most every 5 minutes.");
          },
        },
      }),
    );
    await screen.click("google-sync-interval-1440-google_1");
    const text = screen.container.textContent ?? "";
    expect(text).toContain("Schedule was not saved");
    expect(text).toContain("Sync can run at most every 5 minutes.");
    screen.unmount();
  });
});
