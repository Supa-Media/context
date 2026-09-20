/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/**
 * ONE INDICATOR PER SURFACE, AND IT IS THE ONE YOU CAN WORK IN.
 *
 * The floating recording bar is mounted above every route because "a recording
 * with no visible indicator is a bug and not a mode"
 * (`docs/decisions/meetings.md`). The console's right panel is now a place a
 * meeting is *worked* — named, noted in, stopped — with the note still open
 * beside it, and when that panel is folded the console keeps the clock in its
 * title bar. A bar floating over the note while the console shows the same
 * meeting is the duplicate chrome this feature has already fought twice: the
 * bar yields on the meeting's own screen, and the microphone yields to the bar.
 *
 * `features/meetings/carried.ts` is how the two agree without either knowing
 * where the other is mounted — the bar is above the console in the tree, so a
 * provider cannot reach it, which is `bottomChrome.ts`'s argument verbatim.
 *
 * **This file exists because the sabotage pass found the guard unheld.**
 * Removing `|| carried` from the bar's yield broke nothing in the suite: the
 * console's own tests do not mount the bar, and the bar's tests do not mount a
 * console. That is exactly the shape `docs/decisions/testing.md` refuses — a
 * guard nobody has checked is not a guard.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `|| carried` dropped from `RecordingBar`'s yield.
 *     → `a surface that is already showing the meeting takes the bar down`
 *     fails, with two indicators for one recording.
 *  2. `useCarriesMeeting`'s cleanup dropped, so the claim survives the console.
 *     → `and the claim goes with the surface that made it` fails — which is
 *     the state where a phone-width route after a console has no indicator at
 *     all, the failure the bar exists to prevent.
 *  3. `setMeetingCarried` notifying unconditionally rather than on a change.
 *     → `publishing the same answer twice wakes nobody` fails.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
let mockLive: unknown = null;

jest.mock("../features/meetings/useMeetings", () => ({
  useMeetingsSnapshot: () => ({
    live: mockLive,
    records: [],
    ending: null,
    audio: {},
    offline: false,
  }),
  useTick: () => 0,
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  usePathname: () => "/console/@seyi",
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { RecordingBar } from "../features/meetings/components/RecordingBar";
import {
  meetingCarried,
  setMeetingCarried,
  subscribeMeetingCarried,
  useCarriesMeeting,
} from "../features/meetings/carried";

function recording() {
  return {
    session: {
      id: "m1",
      title: "Pricing sync",
      state: "recording",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      recordedMs: 0,
      attendees: [],
      source: { kind: "in-person" },
      notes: "",
      transcript: [],
      notePath: null,
      enhanced: null,
      log: [],
    },
    runningSince: new Date(Date.now() - 60_000).toISOString(),
    destination: null,
  };
}

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockLive = null;
  setMeetingCarried(false);
});

function mount(element: Parameters<typeof createRoot>[0] extends never ? never : ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
  return {
    container,
    bar: () => container.querySelector('[data-testid="recording-bar"]'),
    rerender: (next: ReturnType<typeof createElement>) => act(() => root.render(next)),
  };
}

/** A console, as far as this claim is concerned: something that says it carries one. */
function Carrier({ carries }: { carries: boolean }) {
  useCarriesMeeting(carries);
  return null;
}

/* -------------------------------------------------------------------------- */

describe("the bar and the surface that is already showing the meeting", () => {
  test("with nothing claiming it, the bar is the indicator", () => {
    mockLive = recording();
    const app = mount(createElement(RecordingBar, {}));
    expect(app.bar()).not.toBeNull();
  });

  test("a surface that is already showing the meeting takes the bar down", () => {
    mockLive = recording();
    const app = mount(createElement(RecordingBar, {}));
    expect(app.bar()).not.toBeNull();

    act(() => setMeetingCarried(true));
    expect(app.bar()).toBeNull();
  });

  test("and it comes straight back when that surface stops carrying it", () => {
    mockLive = recording();
    const app = mount(createElement(RecordingBar, {}));
    act(() => setMeetingCarried(true));
    act(() => setMeetingCarried(false));
    expect(app.bar()).not.toBeNull();
  });

  test("a claim with nothing recording behind it draws no bar either way", () => {
    const app = mount(createElement(RecordingBar, {}));
    expect(app.bar()).toBeNull();
    act(() => setMeetingCarried(true));
    expect(app.bar()).toBeNull();
  });
});

describe("the claim belongs to whatever made it", () => {
  test("a surface with a panel claims the meeting while it is mounted", () => {
    const app = mount(createElement(Carrier, { carries: true }));
    expect(meetingCarried()).toBe(true);
    app.rerender(createElement(Carrier, { carries: false }));
    expect(meetingCarried()).toBe(false);
  });

  test("and the claim goes with the surface that made it", () => {
    /*
      The failure this half prevents is the opposite of the one above and is
      worse: a console unmounts, nothing publishes `false`, and the next route
      — a phone-width screen with no panel at all — shows a running meeting
      with no indicator anywhere.
    */
    const app = mount(createElement(Carrier, { carries: true }));
    expect(meetingCarried()).toBe(true);
    roots.pop()!();
    expect(meetingCarried()).toBe(false);
    expect(app.container.isConnected).toBe(false);
  });

  test("publishing the same answer twice wakes nobody", () => {
    // The store is read on every render of the bar; a version that notified
    // unconditionally would re-render it on every render of the console.
    let woken = 0;
    const stop = subscribeMeetingCarried(() => {
      woken += 1;
    });
    setMeetingCarried(true);
    setMeetingCarried(true);
    setMeetingCarried(false);
    stop();
    expect(woken).toBe(2);
  });
});
