/**
 * @jest-environment jsdom
 */

/**
 * Settings › Meetings, Joining from your calendar
 * (docs/decisions/meetings/joining-from-the-calendar.md): a calendar can be
 * switched off, and the Mac app's ask can be one minute, five, or never. A
 * choice is saved on the account and reaches the Mac app at once.
 *
 * ## Sabotage record
 *
 *  1. The switch saving the address it was given rather than lowercased. →
 *     `switching a calendar off saves its address` fails.
 *  2. `setShellAskBefore` not called on a pick. → `Don't ask reaches the Mac
 *     app at once` fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockSaves: unknown[] = [];
let mockSaved: unknown = null;

jest.mock("convex/react", () => ({
  useConvex: () => ({}),
  useQuery: () => mockSaved,
  useMutation: () => async (args: unknown) => {
    mockSaves.push(args);
    return 1;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";
import { MeetingJoinSettings } from "../features/console/settings/panels/MeetingJoinSettings";
import { setScheduledMeetings, clearScheduledMeetings } from "../features/meetings/scheduled";
import { setShellAskBefore } from "../features/meetings/shellCalendar";
import type { GoogleConnection } from "../features/console/google/GoogleConnectionsCard";

function connection(email: string, calendar = true): GoogleConnection {
  return {
    connectionId: email,
    email,
    syncServices: { gmail: true, calendar, chat: false },
    syncStatus: "ok",
    sync: { kind: "never" },
  } as unknown as GoogleConnection;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(connections: GoogleConnection[]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(MeetingJoinSettings, { connections }));
  });
  return host;
}

function byTestId(id: string): HTMLElement {
  const found = host!.querySelector(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`no ${id}`);
  return found as HTMLElement;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  mockSaves.length = 0;
  mockSaved = null;
  delete (globalThis as { desktop?: unknown }).desktop;
  clearScheduledMeetings();
  setShellAskBefore(60_000);
});

describe("joining from your calendar", () => {
  test("every connected calendar has a switch, and one without calendar is not listed", async () => {
    const view = await render([connection("Work@Example.test"), connection("mail-only@example.test", false)]);
    expect(view.textContent).toContain("Work@Example.test");
    expect(view.textContent).not.toContain("mail-only@example.test");
    expect(view.textContent).toContain("1 minute before");
  });

  test("switching a calendar off saves its address", async () => {
    await render([connection("Work@Example.test")]);
    await act(async () => {
      byTestId("meeting-join-calendar-0").click();
    });
    expect(mockSaves).toEqual([{ calendarsOff: ["work@example.test"], askBeforeMs: 60_000 }]);
    expect(host!.textContent).toContain("Its meetings are not offered");
  });

  test("a saved choice is what the page shows", async () => {
    mockSaved = { calendarsOff: ["work@example.test"], askBeforeMs: 300_000, updatedAt: 1 };
    const view = await render([connection("Work@Example.test")]);
    expect(view.textContent).toContain("Its meetings are not offered");
    expect(view.textContent).toContain("5 minutes before");
  });

  test("Don't ask reaches the Mac app at once", async () => {
    const fake = fakeDesktopBridge();
    (globalThis as { desktop?: unknown }).desktop = fake.bridge;
    setScheduledMeetings({ status: "ready", meetings: [], reconnect: [] });
    await render([connection("work@example.test")]);
    await act(async () => {
      byTestId("meeting-join-ask").click();
    });
    const never = [...host!.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].find((item) =>
      item.textContent?.includes("Don't ask"),
    ) as HTMLElement | undefined;
    expect(never).toBeDefined();
    await act(async () => {
      never!.click();
    });
    expect(mockSaves.at(-1)).toEqual({ calendarsOff: [], askBeforeMs: null });
    expect(fake.upcomingPushes.at(-1)?.askBeforeMs).toBeNull();
  });

  test("with no calendar connected it says where to connect one", async () => {
    const view = await render([]);
    expect(view.textContent).toContain("No calendar connected");
  });
});
