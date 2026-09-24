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
  LiveMeetingScreen,
  MeetingNoteScreen,
  configure,
  fakeGateway,
  fakeRecorder,
  has,
  meetings,
  memoryStore,
  mount,
  notesOnlyRecorder,
  press,
} from "./fixtures";

/**
 * Web-target honesty (the browser build degrades to a typed session and says
 * so) and getting a meeting off the device. See `fixtures.ts` for the
 * screens, controller and fakes this suite mounts against.
 */

beforeEach(() => {
  pushed.length = 0;
});

/* -------------------------------------------------------------------------- */

describe("web-target honesty", () => {
  test("the browser build runs a typed session and says the audio is not there", async () => {
    /*
      The web build must not crash on a missing native capability and must not
      draw a transcript chip over silence.

      `createRecorder` in a browser now returns a real recorder
      (`capture/audio.web.ts`, `getUserMedia` + `MediaRecorder`), and
      `notesOnlyRecorder("web")` is what it falls back to when the browser has
      no `MediaRecorder`, no `mediaDevices`, or a `Blob` whose bytes cannot be
      read — an old embedded webview, or a page served over plain HTTP. That
      state is still reachable, so the screen still has to draw it, and the chip
      carries its own sentence rather than a generic one.
    */
    await configure({ recorder: notesOnlyRecorder("web") });
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Design review" });
    });

    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("This browser can't hear the meeting");
    expect(mounted.container.textContent).not.toContain("Transcribing");
    // The notepad is still the screen, which is the whole point of degrading
    // rather than refusing.
    expect(mounted.container.querySelector("textarea")).not.toBeNull();
    mounted.unmount();
  });

  test("a capture failure mid-meeting outranks the standing capability", async () => {
    const { recorder } = await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Design review" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));

    act(() => {
      (recorder as ReturnType<typeof fakeRecorder>).fail({
        recoverable: false,
        message: "The microphone was taken by a call.",
      });
    });

    // Newer and more specific than "this build cannot capture audio", which
    // would also be false — it was capturing a moment ago.
    expect(mounted.container.textContent).toContain("The microphone was taken by a call.");
    mounted.unmount();
  });

  test("a source nobody detected is not announced as detected", async () => {
    // "Zoom detected" is a claim about the world. Over a `kind: "unknown"`
    // source it is the invented-fact bug this repo has shipped twice.
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Design review" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    expect(has(mounted.container, "meeting-source-chip")).toBe(false);
    expect(mounted.container.textContent).toContain("In person");
    mounted.unmount();
  });

  test("a detected source is announced, with the platform's name", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Design review", source: { kind: "zoom", app: "zoom.us" } });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    expect(has(mounted.container, "meeting-source-chip")).toBe(true);
    expect(mounted.container.textContent).toContain("Zoom detected");
    mounted.unmount();
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A way to get the meeting's text off the device.
 *
 * The screen could show a meeting and there was nothing to *do* with one: the
 * transcript expanded inline, and that was all. No copy, no share, no export.
 * The gateway credential is deliberately unwired (`gateway.ts`), so on this
 * build the note does not reach the bucket on its own either — which means a
 * person could see their meeting and could not use it. That is the data-loss
 * experience even where no data was lost, and it is what the owner met.
 *
 * **What lands on the clipboard is the note itself**, from
 * `renderMeetingNote` — the same function the gateway writes into the bucket
 * with, imported rather than reimplemented, so what somebody pastes is the file
 * they would have had. A second renderer here would be a second answer to "what
 * is a meeting note", and the frontmatter is a stable on-bucket format
 * (CLAUDE.md, non-negotiable 3) rather than something a screen gets to guess at.
 *
 * **And it never claims a copy it did not make.** `writeClipboard` answers a
 * boolean for exactly this reason and its own header calls a discarded `false`
 * "the small lie nobody forgives". jsdom has no `navigator.clipboard` and no
 * `document.execCommand`, so the refusal case below is the real function
 * refusing rather than a mock of one.
 *
 * SABOTAGE RECORD, each applied, whole suite run, reverted:
 *
 *  1. The Copy control discards `writeClipboard`'s answer and always says
 *     copied.
 *     → `a clipboard that refuses is said, not papered over` failed, alone.
 *  2. The copy renders the summary and notes without the frontmatter or the
 *     transcript — the "just the readable part" simplification.
 *     → `what lands on the clipboard is the note the gateway would have
 *     written` failed, alone.
 *  3. The Copy control drawn only when `session.notePath !== null`.
 *     → `the way out is there for the meeting that has not left the device`
 *     failed, which is the only case the control exists for.
 */
describe("a meeting can be got off the device", () => {
  /** jsdom's clipboard, or the absence of one. Restored by `afterEach`. */
  function grantClipboard(): { written: string[] } {
    const written: string[] = [];
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    return { written };
  }

  function revokeClipboard(): void {
    Reflect.deleteProperty(globalThis.navigator as unknown as object, "clipboard");
  }

  test("what lands on the clipboard is the note the gateway would have written", async () => {
    await configure();
    const clipboard = grantClipboard();

    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
      meetings.setNotes(id, "curiosity is the prerequisite");
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    press(mounted.container, "meeting-copy");
    await act(async () => {
      await Promise.resolve();
    });

    expect(clipboard.written).toHaveLength(1);
    const copied = clipboard.written[0]!;
    // The whole file, not a readable excerpt of it: frontmatter that names the
    // meeting and how it was made, the title, and all three headings in the
    // order `note.js` writes them.
    expect(copied.startsWith("---\n")).toBe(true);
    expect(copied).toContain(`meeting-id: ${id}`);
    expect(copied).toContain("# Reboot Camp");
    expect(copied).toContain("## Summary");
    expect(copied).toContain("## My notes");
    expect(copied).toContain("curiosity is the prerequisite");
    expect(copied).toContain("## Transcript");
    // And the screen says it happened, because a copy is invisible.
    expect(mounted.container.textContent).toContain("on your clipboard");

    mounted.unmount();
    revokeClipboard();
  });

  test("a clipboard that refuses is said, not papered over", async () => {
    /*
      No `navigator.clipboard` and no `document.execCommand` in jsdom, which is
      the real `clipboard.web.ts` returning `false` rather than a stub. A screen
      that said "Copied" here would be telling somebody their only copy of a
      meeting is somewhere it is not.
    */
    await configure();
    revokeClipboard();

    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    press(mounted.container, "meeting-copy");
    await act(async () => {
      await Promise.resolve();
    });

    expect(mounted.container.textContent).not.toContain("on your clipboard");
    expect(mounted.container.textContent).toContain("Couldn't reach the clipboard");
    mounted.unmount();
  });

  test("the way out is there for the meeting that has not left the device", async () => {
    /*
      The only case this control exists for. A meeting that reached the bucket
      can be opened in the console, in Obsidian, or through any connected
      client; a meeting that has not is on this phone and nowhere else, and the
      clipboard is the whole of what somebody can do about that.
    */
    const gateway = fakeGateway();
    gateway.offlineFor(50);
    await act(async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "ws-stranded",
        store: memoryStore(),
        gateway,
        recorder: fakeRecorder(),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
    });

    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "On a train" });
      meetings.setNotes(id, "typed underground");
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("Not in your bucket yet");
    expect(has(mounted.container, "meeting-copy")).toBe(true);
    mounted.unmount();
  });
});

/* -------------------------------------------------------------------------- */
