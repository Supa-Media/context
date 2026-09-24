/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
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
  LiveMeetingScreen,
  MeetingNoteScreen,
  RecordingBar,
  configure,
  field,
  has,
  meetings,
  mount,
  press,
} from "./fixtures";

/**
 * The keyboard not taking the End button with it, the recording bar knowing
 * when you are already there, and audio kept on the phone being said on every
 * surface that shows the meeting. See `fixtures.ts` for the screens,
 * controller and fakes this suite mounts against.
 */

beforeEach(() => {
  pushed.length = 0;
});

/* -------------------------------------------------------------------------- */

/**
 * The keyboard, which is up for the whole meeting.
 *
 * The notepad `autoFocus`es — it is the screen — so on a phone the soft
 * keyboard is up from the moment a recording starts and stays up. Two things
 * followed from that and both were found by recording a real meeting:
 *
 *  - **End was unreachable.** The transport sat at the bottom of the screen, the
 *    keyboard is drawn over the app on both native platforms, and the one
 *    control that stops a recording was behind it: *"I had to like leave and go
 *    to another page"* to end the meeting. That is the same family as a meeting
 *    you cannot find — a recording you cannot stop from where you are.
 *  - **There was no way to put the keyboard away**, unlike the note editor,
 *    which has one on its accessory bar.
 *
 * `KeyboardSticky` and `dismissKeyboard` already existed for exactly this —
 * `NoteAccessory` has used the pair since `b23ac96`, and its call site is the
 * one that gets the geometry right, which is why this screen now copies it. The
 * transport rides the keyboard, with a spacer holding its place in the flow so
 * the chips above it are never covered, and the leading key on it puts the
 * keyboard down.
 *
 * ## WHAT THIS FILE EXECUTES, AND WHAT IT CANNOT
 *
 * Stated because the block below is named after something it cannot see. Jest
 * resolves `.web.tsx`, so what runs here is `keyboardSticky.web.tsx` — a plain
 * absolutely-positioned `View` — and `KeyboardStickyView`,
 * `KeyboardController.dismiss()` and the native `testID` pass-through are
 * executed by nothing in this suite. That is not a gap to paper over: on the
 * web the browser shrinks the layout viewport and bottom-anchoring genuinely
 * *is* the whole implementation, so the web half is the real answer rather than
 * a stub, and `dismissKeyboard` blurring the active element really is the
 * platform's "hide the keyboard".
 *
 * So these tests assert the claims that survive that: End is inside the
 * anchored wrapper, the wrapper is anchored, the geometry the caller owns is
 * the geometry it should be, and pressing dismiss does not end the meeting.
 * The native half is pinned by reading its source rather than running it —
 * `the native half is the one that translates` below. **Whether the caret
 * actually clears the lifted transport on a phone is a measurement no test in
 * this repository can make, and it is stated in the branch report as needing a
 * device.**
 *
 * SABOTAGE RECORD, each applied, whole suite run, reverted:
 *
 *  1. Took the transport back out of `KeyboardSticky`, into plain flow.
 *     → `the transport rides above the keyboard, so End is always reachable`
 *     failed, alone.
 *  2. Dropped the dismiss key.
 *     → 2 failed: `the keyboard can be put away from the screen it covers` and
 *     `putting the keyboard away does not end the meeting`, which cannot press
 *     a key that is not there.
 *  3. Made the dismiss key call `meetings.end()` as well — the tempting
 *     "done means done" shortcut.
 *     → `putting the keyboard away does not end the meeting` failed. Worth
 *     having: a key next to End that sometimes ends things is worse than no key.
 */
describe("the keyboard does not take the End button with it", () => {
  test("the transport rides above the keyboard, so End is always reachable", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });

    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    const sticky = mounted.container.querySelector<HTMLElement>(
      '[data-testid="meeting-transport-sticky"]',
    );
    expect(sticky).not.toBeNull();
    // End is inside it. That is the whole claim: whatever the keyboard does to
    // the bottom of the glass, this moves with it.
    expect(sticky!.querySelector('[data-testid="meeting-end"]')).not.toBeNull();
    // And it is anchored rather than in flow, which is what "rides" means on
    // both halves of the platform split.
    expect(window.getComputedStyle(sticky!).position).toBe("absolute");
    // The chips above it keep their room: a spacer stands where the transport
    // used to be, so nothing is drawn underneath it.
    expect(has(mounted.container, "meeting-transport-spacer")).toBe(true);

    mounted.unmount();
    await act(async () => {
      await meetings.end();
    });
  });

  test("the transport is inset clear of the home indicator, and drawn over the chips", async () => {
    /*
      `KeyboardSticky` anchors at `bottom: 0` and says so: it has no offset,
      because "how flush the result sits against the keyboard is decided by the
      caller's container". This screen was the caller that decided nothing.

      An absolutely-positioned child is laid out against its parent's *padding
      box*, so `Screen`'s own safe-area `paddingBottom` does not hold the bar
      back — it sat 34pt down in the home-indicator band, which is
      `RecordingBar`'s stated rule inverted: "a control under the home indicator
      is a control a swipe takes instead of a tap." `NoteAccessory`, the pair's
      other caller, has always set both of these; this copies it.
    */
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });

    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    const sticky = mounted.container.querySelector<HTMLElement>(
      '[data-testid="meeting-transport-sticky"]',
    );
    const style = window.getComputedStyle(sticky!);
    // `floatingGapFor(34)` — the mocked inset — which is the same `max` the
    // recording bar spends at the same edge.
    expect(style.paddingBottom).toBe("34px");
    // Above the chips it is drawn over. `NoteAccessory` sets `2` for the same
    // reason and says why: the frame's own chrome sits at `1`.
    expect(Number(style.zIndex)).toBeGreaterThan(0);

    // And the flow reserves exactly what the slot occupies, so nothing above is
    // covered when the keyboard is down. Both numbers now come from one place.
    const spacer = mounted.container.querySelector<HTMLElement>(
      '[data-testid="meeting-transport-spacer"]',
    );
    expect(window.getComputedStyle(spacer!).height).toBe("100px");

    mounted.unmount();
    await act(async () => {
      await meetings.end();
    });
  });

  test("the notepad gives the keyboard its room, so the lifted bar lands on the spacer", async () => {
    /*
      The half that was missing. `NotesPad` is `flex: 1` in a non-scrolling
      `Screen` with nothing avoiding the keyboard, so its frame ran behind the
      keyboard and stayed there — while `KeyboardStickyView` lifted an opaque
      66pt bar by the full keyboard height and put it *inside* the visible text
      region. Ten lines of typing and the caret is under it.

      The room is bought with `Screen`'s own `chrome` prop — "our own floating
      chrome over this surface" — so the content box ends where the keyboard
      begins and the spacer, which is the last thing in that box, is exactly
      where the lifted bar lands.

      **On the web the height is 0 and that is the right answer**, not a stub: a
      mobile browser shrinks the layout viewport, so the document has already
      reflowed into what is left and a margin here would push the caret up by a
      keyboard that is not covering anything. That is what this assertion is —
      the web half, executed.
    */
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { useKeyboardHeight } =
      require("../../features/design/keyboardSticky") as typeof import("../../features/design/keyboardSticky");
    /* eslint-enable @typescript-eslint/no-require-imports */

    let observed = -1;
    function Probe() {
      observed = useKeyboardHeight();
      return null;
    }
    const mounted = mount(createElement(Probe));
    expect(observed).toBe(0);
    mounted.unmount();

    /*
      And the wiring, read rather than run — because on this platform the height
      is 0, so deleting the whole mechanism changes nothing jsdom can measure.
      That is the boundary stated at the head of this block: the arithmetic is a
      device measurement, but *whether the screen gives up the room at all* is a
      fact about source, and this is the assertion that fails when somebody
      removes it.
    */
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const screen = readFileSync(
      join(__dirname, "..", "..", "features", "meetings", "LiveMeetingScreen.tsx"),
      "utf8",
    );
    expect(screen).toContain("const keyboard = useKeyboardHeight();");
    expect(screen).toContain("chrome={{ bottom: keyboard }}");
  });

  test("the native half is the one that translates, and this suite does not run it", async () => {
    /*
      The honest form of a claim jsdom cannot make. Jest resolves `.web.tsx`, so
      `KeyboardStickyView` and `KeyboardController.dismiss()` are executed by
      nothing above — the test named "rides above the keyboard" asserts DOM
      ancestry and `position: absolute`, which is all there is to assert on a
      platform that has no soft keyboard to ride.

      What can be held from here is that the native half still does the thing
      the web half is standing in for, and that the two agree on the props. Read
      rather than run, the way `storageCodePosition.test.ts` holds a fact about
      another app.
    */
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const native = readFileSync(
      join(__dirname, "..", "..", "features", "design", "keyboardSticky.tsx"),
      "utf8",
    );

    expect(native).toContain("KeyboardStickyView");
    expect(native).toContain("KeyboardController.dismiss()");
    // The height the caller shrinks its content by is a real subscription on
    // native, and the same export name the web half answers 0 from.
    expect(native).toContain("useKeyboardState");
    expect(native).toContain("export function useKeyboardHeight");
    // One declaration of the props, imported by the other half, so the two
    // cannot drift without failing typecheck.
    expect(native).toContain('from "./keyboardSticky.web"');
  });

  test("the keyboard can be put away from the screen it covers", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });

    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    const notes = mounted.container.querySelector<HTMLElement>('[data-testid="meeting-notes"]');
    notes!.focus();
    expect(document.activeElement).toBe(notes);

    press(mounted.container, "meeting-keyboard-hide");
    // The web half of `dismissKeyboard` blurs the focused element, because that
    // *is* the platform's "hide the keyboard".
    expect(document.activeElement).not.toBe(notes);

    mounted.unmount();
    await act(async () => {
      await meetings.end();
    });
  });

  test("putting the keyboard away does not end the meeting", async () => {
    // It sits beside End on a bar somebody is reaching for with a thumb. A key
    // that sometimes stops the recording is worse than no key at all.
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });

    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    press(mounted.container, "meeting-keyboard-hide");
    await act(async () => {
      await Promise.resolve();
    });

    expect(meetings.getSnapshot().live?.session.id).toBe(id);
    expect(meetings.getSnapshot().live?.session.state).toBe("recording");

    mounted.unmount();
    await act(async () => {
      await meetings.end();
    });
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The bar that reaches a meeting you walked away from, and the screen you did
 * not.
 *
 * `RecordingBar` is mounted above every route so a recording survives leaving
 * the screen that started it. Above every route includes the meeting's own,
 * where it draws a second copy of the same three controls — and the two are
 * ~90% on top of each other: the transport's slot and the bar's slot are the
 * same 66pt of glass at the same inset. `zIndex` cannot separate them, because
 * every react-native-web `View` opens a stacking context and they are in
 * different ones (`docs/decisions/app-and-console.md`).
 *
 * Suppressing it there is not a layout workaround, it is what the bar is for:
 * it exists to reach a meeting you are *not* looking at. The pathname it needs
 * to know that was already read, for the End press, and asserted nowhere.
 */
describe("the recording bar knows when you are already there", () => {
  test("it draws nothing on the meeting it would take you to", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });

    mockPathname = `/meetings/${id}`;
    const mounted = mount(createElement(RecordingBar, {}));
    expect(has(mounted.container, "recording-bar")).toBe(false);
    mounted.unmount();

    mockPathname = "/";
    const elsewhere = mount(createElement(RecordingBar, {}));
    expect(has(elsewhere.container, "recording-bar")).toBe(true);
    elsewhere.unmount();

    await act(async () => {
      await meetings.end();
    });
  });

  test("and does not push a second copy of a screen you are already on", async () => {
    /*
      The other half of the same fact, and the reason the guard exists at all.
      It was written and asserted by nothing.
    */
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });

    mockPathname = "/console";
    const mounted = mount(createElement(RecordingBar, {}));
    pushed.length = 0;
    press(mounted.container, "recording-bar-end");
    await act(async () => {
      await Promise.resolve();
    });
    expect(pushed).toEqual([`/meetings/${id}`]);
    mounted.unmount();
    mockPathname = "/";
  });

  test("an end that throws still lands you on the meeting, rather than nowhere", async () => {
    /*
      `void (async () => { await meetings.end(); … })()` swallowed a rejecting
      `end()` into an unhandled rejection with nothing on screen — which is the
      exact shape this whole branch exists to close: *"I don't know if it
      succeeded, if it failed. Just nothing at all."*

      Landing on the meeting is the answer rather than a toast, because the
      meeting screen is what says what state it is in. A failed end leaves a
      session this device still holds, and `MeetingNoteScreen` is where a person
      reads that and can copy their notes out.
    */
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });

    const broken = jest
      .spyOn(meetings, "end")
      .mockRejectedValue(new Error("the store went away"));

    mockPathname = "/console";
    const mounted = mount(createElement(RecordingBar, {}));
    pushed.length = 0;
    press(mounted.container, "recording-bar-end");
    await act(async () => {
      await Promise.resolve();
    });

    expect(pushed).toEqual([`/meetings/${id}`]);
    broken.mockRestore();
    mounted.unmount();
    mockPathname = "/";
    await act(async () => {
      await meetings.end();
    });
  });
});

describe("audio kept on the phone is said, on every surface that shows the meeting", () => {
  /*
    The words are `keptAudio.ts`'s and tested there; what is checked here is
    that each surface actually draws them from the real controller's snapshot
    — a sentence nobody renders is not a sentence the person reads.
  */
  const { memorySpool, setAudioSpool } =
    require("../../features/meetings/capture/spool") as typeof import("../../features/meetings/capture/spool");
  const { setCaptureOffline } =
    require("../../features/meetings/capture/connectivity") as typeof import("../../features/meetings/capture/connectivity");

  function keepFor(spool: ReturnType<typeof memorySpool>, meetingId: string, count: number): void {
    for (let index = 0; index < count; index += 1) {
      spool.keep(
        { meetingId, index, offsetMs: index * 20_000, durationMs: 20_000 },
        { kind: "bytes", bytes: Uint8Array.from([index]), mimeType: "audio/wav" },
        0,
      );
    }
  }

  async function offlineWithAudio(count: number): Promise<{ id: string; spool: ReturnType<typeof memorySpool> }> {
    const spool = memorySpool();
    setAudioSpool(spool);
    setCaptureOffline(true);
    await configure();
    let id = "";
    await act(async () => {
      meetings.setOffline(true);
      id = await meetings.start({ title: "Underground" });
      keepFor(spool, id, count);
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    return { id, spool };
  }

  afterEach(() => {
    setAudioSpool(null);
    setCaptureOffline(false);
    act(() => meetings.setOffline(false));
  });

  test("the live screen says the recording is saved on this phone, and how much is waiting", async () => {
    const { id } = await offlineWithAudio(3);
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    const chip = field(mounted.container, "meeting-audio-kept");
    expect(chip.textContent).toBe(
      "Offline — recording is saved on this phone and will be transcribed when you're back online · 3 pieces waiting",
    );
    mounted.unmount();
  });

  test("the bar says it in two words, and in full to a screen reader", async () => {
    await offlineWithAudio(2);
    mockPathname = "/somewhere-else";
    const mounted = mount(createElement(RecordingBar));
    expect(field(mounted.container, "recording-bar-kept").textContent).toBe("On phone · 2");
    expect(
      field(mounted.container, "recording-bar-open").getAttribute("aria-label"),
    ).toContain("recording is saved on this phone");
    mounted.unmount();
    mockPathname = "/";
  });

  test("an ended meeting says its note is waiting for the audio, and the transcript that it is incomplete", async () => {
    const { id } = await offlineWithAudio(2);
    await act(async () => {
      await meetings.end();
    });
    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(field(mounted.container, "meeting-summary").textContent).toContain(
      "2 pieces of this recording are saved on this phone and will be transcribed when you're back online",
    );
    // The record was not finalized while the audio waits.
    const record = meetings.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("finalizing");
    mounted.unmount();
  });
});
