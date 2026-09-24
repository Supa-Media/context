/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

const pushed: string[] = [];
/** Mutable, so a test can put the router somewhere and see what a screen does there. */
let mockPathname = "/";
jest.mock("expo-router", () => {
  const { createElement: h } = require("react") as typeof import("react");
  return {
    Stack: () => null,
    Slot: () => null,
    Link: ({ children }: { children?: unknown }) => h("div", null, children as never),
    useRouter: () => ({
      replace: () => {},
      push: (href: string) => pushed.push(href),
      back: () => {},
    }),
    useLocalSearchParams: () => ({}),
    useGlobalSearchParams: () => ({}),
    usePathname: () => mockPathname,
  };
});

import {
  MeetingNoteScreen,
  RecordingBar,
  configure,
  has,
  meetings,
  mount,
  press,
} from "./fixtures";

/**
 * Three different ways a meeting can be absent, and the persistent bar. See
 * `fixtures.ts` for the screens, controller and fakes this suite mounts
 * against.
 */

beforeEach(() => {
  pushed.length = 0;
});

/* -------------------------------------------------------------------------- */

describe("three different ways a meeting can be absent", () => {
  test("a link that names no meeting is a dead end straight away", async () => {
    // No amount of reading the device turns a malformed id into a recording,
    // so this answer does not wait for anything.
    await act(async () => {
      meetings.reset();
    });
    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: "" }));
    expect(has(mounted.container, "meeting-dead-link")).toBe(true);
    expect(has(mounted.container, "meeting-missing")).toBe(false);
    mounted.unmount();
  });

  test("a real id, before the store has answered, claims nothing", async () => {
    /*
      The bug this closes: "that meeting is not on this device" is a claim about
      the store, and until the store has been read nothing has checked it — so
      somebody opening a meeting they *do* have would be told they do not, for
      as long as the read takes.
    */
    await act(async () => {
      meetings.reset();
    });
    const mounted = mount(
      createElement(MeetingNoteScreen, { meetingId: "mtg_aaaaaaaaaaaaaaaaaaaa" }),
    );
    expect(has(mounted.container, "meeting-loading")).toBe(true);
    expect(has(mounted.container, "meeting-missing")).toBe(false);
    expect(has(mounted.container, "meeting-dead-link")).toBe(false);
    mounted.unmount();
  });

  test("a real id the store does not hold is the honest absence", async () => {
    await configure();
    const mounted = mount(
      createElement(MeetingNoteScreen, { meetingId: "mtg_aaaaaaaaaaaaaaaaaaaa" }),
    );
    expect(has(mounted.container, "meeting-missing")).toBe(true);
    mounted.unmount();
  });
});

describe("the persistent bar", () => {
  test("nothing is live, so it draws nothing at all", async () => {
    await configure();
    const mounted = mount(createElement(RecordingBar));
    expect(mounted.container.textContent).toBe("");
    mounted.unmount();
  });

  test("a recording started elsewhere is visible from a screen that knows nothing about it", async () => {
    /*
      The property that makes the bar work: the state is an external store, so a
      screen mounted after the recording began — a different route, a cold
      remount — shows the meeting without anything having been passed to it.
    */
    await configure();
    await act(async () => {
      await meetings.start({ title: "Reboot Camp" });
    });

    const mounted = mount(createElement(RecordingBar));
    expect(has(mounted.container, "recording-bar")).toBe(true);
    // A clock, and a way out, and nothing covering somebody's work.
    expect(mounted.container.textContent).toContain("End");
    mounted.unmount();
  });

  /**
   * THE BAR IS ALSO THE WAY BACK, AND NOTHING CHECKED IT.
   *
   * `RecordingBar`'s own header says "the title is one tap away because the bar
   * itself navigates to the meeting", and that middle target was the only part
   * of the bar with no test — End, pause and resume each had one. It is the
   * half that matters most now that a recording is visible from *everywhere*:
   * the bar is the only handle a person on a note screen has on the meeting
   * they are in, and a dead target there leaves the URL as the way back.
   *
   * SABOTAGE: made `open` return without pushing.
   * MEASURED: this test failed and no other did.
   */
  test("the bar is the way back into the meeting from anywhere", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });
    const mounted = mount(createElement(RecordingBar));

    press(mounted.container, "recording-bar-open");

    expect(pushed).toEqual([`/meetings/${id}`]);
    mounted.unmount();
    await act(async () => {
      await meetings.end();
    });
  });

  test("End from the bar ends the meeting and takes the bar down", async () => {
    await configure();
    await act(async () => {
      await meetings.start({ title: "Reboot Camp" });
    });
    const mounted = mount(createElement(RecordingBar));

    press(mounted.container, "recording-bar-end");
    await act(async () => {
      await Promise.resolve();
    });

    expect(meetings.getSnapshot().live).toBeNull();
    expect(has(mounted.container, "recording-bar")).toBe(false);
    mounted.unmount();
  });

  test("pause and resume, from anywhere", async () => {
    await configure();
    await act(async () => {
      await meetings.start({ title: "Reboot Camp" });
    });
    const mounted = mount(createElement(RecordingBar));

    press(mounted.container, "recording-bar-pause");
    await act(async () => {
      await Promise.resolve();
    });
    expect(meetings.getSnapshot().live?.session.state).toBe("paused");
    press(mounted.container, "recording-bar-pause");
    await act(async () => {
      await Promise.resolve();
    });
    expect(meetings.getSnapshot().live?.session.state).toBe("recording");
    mounted.unmount();
  });
});

