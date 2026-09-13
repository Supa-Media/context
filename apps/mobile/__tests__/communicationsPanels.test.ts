/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://context.lc/"}
 */

/**
 * The four panels that replaced one "Mail, calendar & chats" section.
 *
 * One section used to hold everything that fills a workspace without being typed
 * into it, and the reason it was one was our plumbing rather than anybody's
 * question: a Google *account* carries three services, so a card built around
 * an account had to carry three too. A person does not open settings asking
 * "what does my Google account do" — they ask "why isn't my mail here", and
 * that question was answered in two places at once, because a mailbox reaches
 * a workspace either through a Google account or through the forwarding address,
 * and those are two different mechanisms.
 *
 * What this file pins:
 *
 *  1. **Email is one page.** The mailboxes we read and the address mail can be
 *     forwarded to are both on it, and neither is somewhere else.
 *  2. **Each panel narrows one card rather than repeating it.** Calendar does
 *     not carry an Email block, Chats does not carry a Calendar one.
 *  3. **A workspace is never told it can connect somebody's Gmail** — in any
 *     of the four. It is told why, in that panel's own words.
 *  4. **The owner-only gates survive the split.** Connecting or removing a
 *     Google account, and changing where mail lands or who may send it, are an
 *     owner's; a narrowed card must not have dropped the check on the way.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

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
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
  /*
    Meetings reaches for these now. `undefined` from `useConvex` is exactly
    what a console with no provider gets — the landing page's copy, and this
    harness — and it is the state `MeetingsDestination` already handles by
    drawing the folder with no control. `useMutation` is only ever called
    through the live half, which that check keeps unrendered; it is stubbed so
    that a future change reaching for it fails on an assertion rather than on a
    missing mock. See the same note in `settingsOverlayRender.test.ts`.
  */
  useConvex: () => undefined,
  useMutation: () => async () => {
    throw new Error("no mutation should run in this harness");
  },
}));

jest.mock("../features/console/google/leaveForGoogle", () => ({
  leaveForGoogle: (url: string) => {
    mockNavigations.push(url);
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SettingsPane } from "../features/console/panes/SettingsPane";
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
import type { ConsoleData } from "../features/console/types";
import type { SettingsSectionKey } from "../features/console/settings/sections";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

/** The demo console, with one of its three contexts selected. */
function demoData(contextId: string): ConsoleData {
  let latest: ConsoleData | null = null;
  function Probe() {
    latest = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  act(() => {
    latest!.selectContext(contextId);
  });
  return latest!;
}

const OWNED = "seyi";
const WORKSPACE = "pw";

function panelElement(contextId: string, section: SettingsSectionKey): HTMLElement {
  const data = demoData(contextId);
  return mount(() => createElement(SettingsPane, { data, onClose: () => {}, section }));
}

function panel(contextId: string, section: SettingsSectionKey): string {
  return panelElement(contextId, section).textContent ?? "";
}

/*
  Each service's destination, named once and asserted against by the narrowing
  tests. They differ from each other on purpose: that is what makes "only the
  calendar block" an assertion rather than a coincidence.
*/
const MAIL_DESTINATION = "0-inbox/email/someone/YYYY-MM-DD.md";
const CALENDAR_DESTINATION = "0-inbox/calendar/YYYY-MM-DD.md";
const CHAT_DESTINATION = "2-areas/communications/daily/YYYY-MM-DD.md";

/** One Google account with all three services on, so narrowing has work to do. */
const THREE_SERVICE_ACCOUNT: GoogleConnection = {
  connectionId: "google_1",
  email: "someone@example.com",
  syncServices: { gmail: true, calendar: true, chat: true },
  syncStatus: "active",
  sync: SYNCING_HOURLY,
  gmail: {
    backfillDays: 90,
    folders: ["inbox"],
    destinationFolder: "0-inbox/email/someone",
    destinationPath: MAIL_DESTINATION,
    historyCursorReady: true,
  },
  calendar: {
    destinationFolder: "0-inbox/calendar",
    destinationPath: CALENDAR_DESTINATION,
    syncCursorReady: true,
  },
  chat: {
    destinationFolder: "2-areas/communications/daily",
    destinationPath: CHAT_DESTINATION,
    cursorCount: 2,
  },
};

describe("Email answers the whole question on one page", () => {
  test("the mailboxes we read and the address mail is forwarded to are both here", () => {
    const text = panel(OWNED, "email");
    // The Google half.
    expect(text).toContain("Google accounts");
    // The forwarding half, which used to be a separate block under a separate
    // heading — the split people had to learn was ours, not theirs.
    expect(text).toContain("Ingestion address");
  });

  test("and it is not carrying the other two services", () => {
    const text = panel(OWNED, "email");
    expect(text).not.toContain("Calendar daily file pattern");
    expect(text).not.toContain("Chat daily file pattern");
  });
});

describe("each panel narrows the Google card rather than repeating it", () => {
  test("Calendar shows only the calendar block of a three-service account", () => {
    const container = mount(() =>
      createElement(GoogleConnectionsCard, {
        service: "calendar",
        connections: [THREE_SERVICE_ACCOUNT],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain(CALENDAR_DESTINATION);
    expect(text).not.toContain(MAIL_DESTINATION);
    expect(text).not.toContain(CHAT_DESTINATION);
  });

  test("Email shows only the mail block", () => {
    // Asserted here rather than through the Email *panel*, and deliberately:
    // the demo console carries no Google connections, so a panel-level check
    // for "no Calendar block" passes whether or not narrowing works at all.
    const container = mount(() =>
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [THREE_SERVICE_ACCOUNT],
      }),
    );
    const text = container.textContent ?? "";
    /*
      The uppercase field label was the old observable and it is gone with the
      always-open field. The destination itself is the better one: it differs
      per service, so "only the mail block" is asserted on the thing that would
      actually be wrong if the narrowing broke.
    */
    expect(text).toContain(MAIL_DESTINATION);
    expect(text).not.toContain(CALENDAR_DESTINATION);
    expect(text).not.toContain(CHAT_DESTINATION);
  });

  test("Chats shows only the chat block", () => {
    const container = mount(() =>
      createElement(GoogleConnectionsCard, {
        service: "chat",
        connections: [THREE_SERVICE_ACCOUNT],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain(CHAT_DESTINATION);
    expect(text).not.toContain(MAIL_DESTINATION);
    expect(text).not.toContain(CALENDAR_DESTINATION);
  });

  test("an account that does not sync this service is not listed under it", () => {
    const container = mount(() =>
      createElement(GoogleConnectionsCard, {
        service: "calendar",
        connections: [
          {
            ...THREE_SERVICE_ACCOUNT,
            syncServices: { gmail: true, calendar: false, chat: false },
          },
        ],
      }),
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("someone@example.com");
    expect(text).toContain("0 connected");
  });

  test("connecting from a narrowed card asks Google for that service alone", async () => {
    mockStartCalls.length = 0;
    mockNavigations.length = 0;
    const container = mount(() =>
      createElement(GoogleConnectionsCard, {
        service: "calendar",
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          saveDestination: async () => null,
          saveSyncInterval: async () => null,
        },
      }),
    );
    const button = container.querySelector<HTMLElement>('[data-testid="connect-google"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });

    expect(mockStartCalls).toEqual([
      {
        workspaceId: "ws_1",
        redirectUri: "https://context.lc/connect/google",
        syncServices: { gmail: false, calendar: true, chat: false },
      },
    ]);
  });

  test("disconnecting from a narrowed card says it takes the other services with it", () => {
    const container = mount(() =>
      createElement(GoogleConnectionsCard, {
        service: "calendar",
        actions: {
          workspaceId: "ws_1",
          disconnect: async () => null,
          saveDestination: async () => null,
          saveSyncInterval: async () => null,
        },
        connections: [THREE_SERVICE_ACCOUNT],
      }),
    );
    // The card's unit is a Google *account*, and Disconnect removes the whole
    // one. Under a per-service heading that is a footgun unless it is said.
    expect(container.textContent ?? "").toContain("Email and Chat");
  });
});

describe("only an owner connects, removes, or re-files", () => {
  test.each(["gmail", "calendar", "chat"] as const)(
    "a narrowed %s card with no actions offers no way in",
    (service) => {
      const container = mount(() =>
        createElement(GoogleConnectionsCard, { service, connections: [] }),
      );
      const text = container.textContent ?? "";
      expect(text).toContain("Only an owner can connect or remove Google accounts.");
      expect(container.querySelector('[data-testid="connect-google"]')).toBeNull();
    },
  );

  /*
    Absent, not disabled — which is this console's rule everywhere else and was
    the one place it was not followed. There is no `saveDestination` without
    `googleActions`, so a reader who cannot save is now offered no way *in*
    either: no Change, so no editor, so no Save. A disabled Save button sitting
    under a path was an affordance whose only possible outcome was refusal.
  */
  test("a narrowed card offers no way into the editor without a saver", () => {
    const container = mount(() =>
      createElement(GoogleConnectionsCard, {
        service: "gmail",
        connections: [THREE_SERVICE_ACCOUNT],
      }),
    );
    expect(
      container.querySelector('[data-testid="edit-google-gmail-destination-google_1"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="save-google-gmail-destination-google_1"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="google-gmail-destination-google_1"]'),
    ).toBeNull();
    // The destination is still *stated*: not being able to change it is not a
    // reason to be unable to see where your mail goes.
    expect(container.textContent ?? "").toContain(MAIL_DESTINATION);
  });

  test("and the forwarding rules stay the owner's", () => {
    // The demo console has no `ingestion.save`, which is exactly the shape a
    // non-owner gets. The Email panel must not offer the controls anyway.
    const container = panelElement(OWNED, "email");
    expect(container.querySelector('[data-testid="ingestion-who"]')).toBeNull();
    expect(container.querySelector('[data-testid="ingestion-folder"]')).toBeNull();
  });
});

describe("a workspace is never told it can connect somebody's Gmail", () => {
  test.each(["email", "calendar", "chats", "meetings"] as const)(
    "%s offers no Google connection at all",
    (section) => {
      const text = panel(WORKSPACE, section);
      expect(text).not.toContain("Google accounts");
      expect(text).not.toContain("Connect Google account");
      expect(text).not.toContain("Connect a Gmail account");
    },
  );

  test("Email says the workspace has no address of its own", () => {
    const text = panel(WORKSPACE, "email");
    expect(text).toContain("This workspace does not receive email");
    expect(text).toContain("Switch to a personal workspace");
  });

  test("Calendar and Chats each say why", () => {
    expect(panel(WORKSPACE, "calendar")).toContain("Switch to a personal workspace");
    expect(panel(WORKSPACE, "chats")).toContain("Switch to a personal workspace");
  });

  test("Meetings is not a refusal — a meeting note can be filed anywhere", () => {
    // `features/meetings/destination.ts`: the first offer is always the
    // person's own workspace, and the context they are looking at is the second
    // offer with its audience named. So a workspace's Meetings panel has
    // something true to say rather than a wall.
    const text = panel(WORKSPACE, "meetings");
    expect(text).not.toContain("Switch to a personal workspace");
    expect(text).toContain("0-inbox/meetings");
  });
});

describe("no panel is an empty card under a heading", () => {
  const cases: Array<[string, SettingsSectionKey]> = [
    [OWNED, "email"],
    [OWNED, "calendar"],
    [OWNED, "chats"],
    [OWNED, "meetings"],
    [WORKSPACE, "email"],
    [WORKSPACE, "calendar"],
    [WORKSPACE, "chats"],
    [WORKSPACE, "meetings"],
  ];

  test.each(cases)("%s / %s says something", (contextId, section) => {
    // A heading over nothing is a worse answer than no section. Every one of
    // the eight has to carry a sentence past its own title.
    const text = panel(contextId, section);
    expect(text.length).toBeGreaterThan(120);
  });
});
