/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { setCallAudioStorage, noteCallAudioShare } from "../features/meetings/capture/callAudioMemory";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Join and take notes, for a meeting on the person's calendar
 * (docs/decisions/meetings/joining-from-the-calendar.md).
 *
 * The press does two things, and the order between them is the whole design:
 * where this build hears the call with no share prompt, the call opens in the
 * same press; where a browser's prompt needs the press, the call waits for the
 * live card. And a meeting with no call link never opens anything.
 *
 * ## Sabotage record
 *
 * Each applied, suite run, named test failed, reverted.
 *
 *  1. The `!systemAudioNeedsPicker` guard dropped from the flow. → `a browser
 *     that needs its share prompt does not spend the press on the call` fails.
 *  2. `joinStartInput` keeping the person themself among the guests. → `the
 *     meeting is named after the event, with its guests` fails.
 *  3. `NextUpRow` ignoring the running meeting. → `a meeting already recording
 *     takes the row away` fails.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { Linking } = require("react-native") as typeof import("react-native");
const { useMeetingFlow } = require("../features/meetings/useMeetingFlow") as typeof import("../features/meetings/useMeetingFlow");
const { meetings } = require("../features/meetings/controller") as typeof import("../features/meetings/controller");
const { fakeGateway } = require("../features/meetings/fakeGateway") as typeof import("../features/meetings/fakeGateway");
const { fakeRecorder } = require("../features/meetings/capture/fake") as typeof import("../features/meetings/capture/fake");
const { memoryStore } = require("../features/offline/memory") as typeof import("../features/offline/memory");
const { joinStartInput, startsWhen, openCallLabel } = require("../features/meetings/join") as typeof import("../features/meetings/join");
const { setScheduledMeetings, clearScheduledMeetings } = require("../features/meetings/scheduled") as typeof import("../features/meetings/scheduled");
const { NextUpRow } = require("../features/meetings/components/NextUpRow") as typeof import("../features/meetings/components/NextUpRow");
const { OpenCallButton } = require("../features/meetings/components/OpenCallButton") as typeof import("../features/meetings/components/OpenCallButton");
/* eslint-enable @typescript-eslint/no-require-imports */

type CalendarEvent = import("../features/meetings/protocol").CalendarEvent & { account?: string };

const OWN = { slug: "testagent1", kind: "personal", role: "owner" };

function meeting(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "seyi@example.test:lw",
    title: "Leadership Weekly",
    startsAt: new Date(Date.now() + 4 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 64 * 60_000).toISOString(),
    attendees: [
      { name: "Seyi", email: "seyi@example.test", self: true, via: "calendar" },
      { name: "Zay", email: "zay@example.test", via: "calendar" },
    ],
    conferenceUrl: "https://meet.google.com/abc-defg-hij",
    account: "seyi@example.test",
    ...overrides,
  };
}

function mount(element: ReactElement): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return () => {
    act(() => root.unmount());
    host.remove();
  };
}

function press(testId: string): void {
  const target = document.body.querySelector(`[data-testid="${testId}"]`);
  if (target === null) throw new Error(`no control named ${testId}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

async function configure(capability?: Parameters<typeof fakeRecorder>[0]) {
  await act(async () => {
    meetings.reset();
    await meetings.configure({
      workspaceId: "ws-1",
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder: fakeRecorder(capability),
      device: { platform: "web" },
      persistDebounceMs: 0,
    });
  });
}

function Harness({ event }: { event: CalendarEvent }): ReactElement {
  const flow = useMeetingFlow({ contexts: [OWN], onStarted: () => {} });
  return createElement(
    "div",
    null,
    createElement("button", { "data-testid": "join", onClick: () => flow.joinMeetingFlow(event) }, "Join"),
    flow.sheet,
  );
}

let opened: string[] = [];
beforeEach(() => {
  opened = [];
  jest.spyOn(Linking, "openURL").mockImplementation(async (url: string) => {
    opened.push(url);
    return true;
  });
  document.body.replaceChildren();
});
afterEach(() => {
  jest.restoreAllMocks();
  setCallAudioStorage(undefined);
  clearScheduledMeetings();
});

describe("what a join records", () => {
  test("the meeting is named after the event, with its guests", () => {
    const input = joinStartInput(meeting());
    expect(input.title).toBe("Leadership Weekly");
    expect(input.attendees?.map((a) => a.name)).toEqual(["Zay"]);
    expect(input.source).toEqual({ kind: "meet", url: "https://meet.google.com/abc-defg-hij", calendarEventId: "seyi@example.test:lw" });
  });

  test("a meeting with no call link is in person", () => {
    expect(joinStartInput(meeting({ conferenceUrl: undefined })).source).toEqual({ kind: "in-person", calendarEventId: "seyi@example.test:lw" });
  });

  test("when it starts is said plainly", () => {
    const now = Date.now();
    expect(startsWhen(meeting(), now)).toBe("in 4 min");
    expect(startsWhen(meeting({ startsAt: new Date(now - 60_000).toISOString() }), now)).toBe("now");
    expect(openCallLabel("https://us02web.zoom.us/j/1")).toBe("Open Zoom");
  });
});

describe("one press", () => {
  test("where nothing needs the press, the call opens and the notes start together", async () => {
    await configure();
    const unmount = mount(createElement(Harness, { event: meeting() }));
    await settle();
    press("join");
    await settle();
    expect(opened).toEqual(["https://meet.google.com/abc-defg-hij"]);
    const live = meetings.getSnapshot().live;
    expect(live?.session.title).toBe("Leadership Weekly");
    expect(live?.session.source).toMatchObject({ kind: "meet", url: "https://meet.google.com/abc-defg-hij" });
    expect(live?.session.attendees.some((a) => a.name === "Zay")).toBe(true);
    unmount();
  });

  test("a browser that needs its share prompt does not spend the press on the call", async () => {
    const kept = new Map<string, string>();
    setCallAudioStorage({
      getItem: (key) => kept.get(key) ?? null,
      setItem: (key, value) => void kept.set(key, value),
      removeItem: (key) => void kept.delete(key),
    });
    // A share has worked in this browser before, so no primer stands in the way.
    noteCallAudioShare(true);
    await configure({ systemAudioNeedsPicker: true });
    const unmount = mount(createElement(Harness, { event: meeting() }));
    await settle();
    press("join");
    await settle();
    expect(opened).toEqual([]);
    expect(meetings.getSnapshot().live?.session.title).toBe("Leadership Weekly");
    unmount();
  });

  test("a meeting with no call link opens nothing", async () => {
    await configure();
    const unmount = mount(createElement(Harness, { event: meeting({ conferenceUrl: undefined }) }));
    await settle();
    press("join");
    await settle();
    expect(opened).toEqual([]);
    expect(meetings.getSnapshot().live?.session.source.kind).toBe("in-person");
    unmount();
  });
});

describe("the live card's call button", () => {
  test("offers the call by name, and opens it", async () => {
    const session = { source: { kind: "meet", url: "https://meet.google.com/abc-defg-hij" } } as never;
    const unmount = mount(createElement(OpenCallButton, { session, testID: "open-call" }));
    expect(document.body.textContent).toContain("Open Google Meet");
    press("open-call");
    expect(opened).toEqual(["https://meet.google.com/abc-defg-hij"]);
    unmount();
  });

  test("never offers a link that is not a known call", () => {
    const session = { source: { kind: "unknown", url: "https://meet.google.com.evil.example/x" } } as never;
    const unmount = mount(createElement(OpenCallButton, { session, testID: "open-call" }));
    expect(document.body.querySelector('[data-testid="open-call"]')).toBeNull();
    unmount();
  });
});

describe("the sidebar's next-up row", () => {
  test("names a meeting four minutes away, with the join press", async () => {
    await configure();
    setScheduledMeetings({ status: "ready", meetings: [meeting()], reconnect: [] });
    const joined: string[] = [];
    const unmount = mount(createElement(NextUpRow, { onJoin: (m: CalendarEvent) => joined.push(m.id) }));
    expect(document.body.textContent).toContain("Leadership Weekly");
    expect(document.body.textContent).toContain("Next · in 4 min");
    press("next-up-join");
    expect(joined).toEqual(["seyi@example.test:lw"]);
    unmount();
  });

  test("says nothing about a meeting half an hour away", async () => {
    await configure();
    const later = Date.now() + 30 * 60_000;
    setScheduledMeetings({
      status: "ready",
      meetings: [meeting({ startsAt: new Date(later).toISOString(), endsAt: new Date(later + 3_600_000).toISOString() })],
      reconnect: [],
    });
    const unmount = mount(createElement(NextUpRow, { onJoin: () => {} }));
    expect(document.body.querySelector('[data-testid="next-up"]')).toBeNull();
    unmount();
  });

  test("a meeting already recording takes the row away", async () => {
    await configure();
    await act(async () => {
      await meetings.start({ title: "Something else" });
    });
    setScheduledMeetings({ status: "ready", meetings: [meeting()], reconnect: [] });
    const unmount = mount(createElement(NextUpRow, { onJoin: () => {} }));
    expect(document.body.querySelector('[data-testid="next-up"]')).toBeNull();
    unmount();
  });
});

describe("the Mac app's menu bar is handed the same meetings", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { fakeDesktopBridge } = require("@context/desktop-bridge/fake") as typeof import("@context/desktop-bridge/fake");
  const { setScheduledMeetings, clearScheduledMeetings } =
    require("../features/meetings/scheduled") as typeof import("../features/meetings/scheduled");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const scope = globalThis as { desktop?: unknown };
  afterEach(() => {
    delete scope.desktop;
    clearScheduledMeetings();
  });

  const weekly = {
    id: "work@example.test:evt1",
    title: "Leadership Weekly",
    startsAt: "2026-10-28T16:00:00.000Z",
    endsAt: "2026-10-28T17:00:00.000Z",
    conferenceUrl: "https://meet.google.com/abc-defg-hij",
    attendees: [
      { name: "Me", email: "me@example.test", self: true, via: "calendar" as const },
      { name: "Ruth", email: "ruth@example.test", via: "calendar" as const },
    ],
  };

  test("a Mac app that can take them gets today's meetings, without the person as a guest", () => {
    const fake = fakeDesktopBridge();
    scope.desktop = fake.bridge;
    setScheduledMeetings({ status: "ready", meetings: [weekly], reconnect: [] });
    expect(fake.upcomingPushes).toHaveLength(1);
    expect(fake.upcomingPushes[0]).toEqual({
      meetings: [
        {
          id: weekly.id,
          title: "Leadership Weekly",
          startsAt: weekly.startsAt,
          endsAt: weekly.endsAt,
          conferenceUrl: weekly.conferenceUrl,
          attendees: [{ name: "Ruth", email: "ruth@example.test" }],
        },
      ],
      askBeforeMs: 60_000,
    });
  });

  test("an older Mac app, or a browser, is handed nothing and nothing throws", () => {
    const fake = fakeDesktopBridge({ noCalendar: true });
    scope.desktop = fake.bridge;
    expect(() => setScheduledMeetings({ status: "ready", meetings: [weekly], reconnect: [] })).not.toThrow();
    expect(fake.calls).not.toContain("calendar.setUpcoming");
    delete scope.desktop;
    expect(() => setScheduledMeetings({ status: "ready", meetings: [weekly], reconnect: [] })).not.toThrow();
  });

  test("signing out empties the menu bar too", () => {
    const fake = fakeDesktopBridge();
    scope.desktop = fake.bridge;
    setScheduledMeetings({ status: "ready", meetings: [weekly], reconnect: [] });
    clearScheduledMeetings();
    expect(fake.upcomingPushes.at(-1)?.meetings).toEqual([]);
  });
});
