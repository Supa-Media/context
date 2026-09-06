/**
 * @jest-environment jsdom
 */

import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * What the screens are allowed to say.
 *
 * Every assertion here is about a **claim**, not a layout. This repo has
 * shipped invented facts about somebody's own storage twice (#20 and #25), and
 * the rule that came out of it is the one these tests enforce: where there is
 * no answer, a screen renders nothing rather than something plausible, and
 * "saved" is said only when there is a path in the customer's bucket to print.
 *
 * The screens run against the **real controller** with a memory store, a fake
 * gateway and a fake recorder, so what is being checked is the whole path from
 * a press to the words on the glass — not a component fed a hand-made prop that
 * happens to be in the state the test wanted.
 *
 * The last block is the web-target honesty check: the browser build must
 * degrade to a typed-notes-only session and say so, rather than crashing on a
 * capability it does not have or drawing a transcript chip over silence.
 */

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

const pushed: string[] = [];
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
    usePathname: () => "/",
  };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { MeetingsListScreen } =
  require("../features/meetings/MeetingsListScreen") as typeof import("../features/meetings/MeetingsListScreen");
const { LiveMeetingScreen } =
  require("../features/meetings/LiveMeetingScreen") as typeof import("../features/meetings/LiveMeetingScreen");
const { MeetingNoteScreen } =
  require("../features/meetings/MeetingNoteScreen") as typeof import("../features/meetings/MeetingNoteScreen");
const { RecordingBar } =
  require("../features/meetings/components/RecordingBar") as typeof import("../features/meetings/components/RecordingBar");
const { meetings } =
  require("../features/meetings/controller") as typeof import("../features/meetings/controller");
const { fakeGateway } =
  require("../features/meetings/fakeGateway") as typeof import("../features/meetings/fakeGateway");
const { fakeRecorder, fakeSegment } =
  require("../features/meetings/capture/fake") as typeof import("../features/meetings/capture/fake");
const { notesOnlyRecorder } =
  require("../features/meetings/capture") as typeof import("../features/meetings/capture");
const { memoryStore } =
  require("../features/offline/memory") as typeof import("../features/offline/memory");
/* eslint-enable @typescript-eslint/no-require-imports */

/* -------------------------------------------------------------------------- */

interface Mounted {
  container: HTMLElement;
  unmount: () => void;
}

function mount(element: ReactElement): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    container: host,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function press(container: HTMLElement, testId: string): void {
  const target = container.querySelector(`[data-testid="${testId}"]`);
  if (target === null) throw new Error(`no control named ${testId}`);
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function has(container: HTMLElement, testId: string): boolean {
  return container.querySelector(`[data-testid="${testId}"]`) !== null;
}

async function configure(
  options: {
    recorder?: ReturnType<typeof fakeRecorder> | ReturnType<typeof notesOnlyRecorder>;
    /** A folder this run's gateway will not file into. Drives the fallback. */
    refusesFolder?: (folder: string) => boolean;
  } = {},
) {
  const gateway = fakeGateway({ refusesFolder: options.refusesFolder });
  const recorder = options.recorder ?? fakeRecorder();
  await act(async () => {
    meetings.reset();
    await meetings.configure({
      workspaceId: `ws-${Math.random().toString(36).slice(2)}`,
      store: memoryStore(),
      gateway,
      recorder,
      device: { platform: "web" },
      persistDebounceMs: 0,
    });
  });
  return { gateway, recorder };
}

beforeEach(() => {
  pushed.length = 0;
});

/* -------------------------------------------------------------------------- */

describe("the list says what it knows and no more", () => {
  test("loading is not `no meetings`", async () => {
    /*
      The distinction `emptyConsoleStats.test.ts` exists for, one product over:
      a person with fifty recordings must not be told they have none while the
      store is being read. The empty state is drawn on `ready`, and only then.
    */
    await act(async () => {
      meetings.reset();
    });
    const mounted = mount(createElement(MeetingsListScreen));
    expect(has(mounted.container, "meetings-loading")).toBe(true);
    expect(has(mounted.container, "meetings-empty")).toBe(false);
    mounted.unmount();
  });

  test("an account with nothing recorded gets the empty state, once it is known", async () => {
    await configure();
    const mounted = mount(createElement(MeetingsListScreen));
    expect(has(mounted.container, "meetings-empty")).toBe(true);
    expect(mounted.container.textContent).toContain("your own bucket");
    mounted.unmount();
  });

  test("`Coming up` is absent rather than empty when nothing supplies a calendar", async () => {
    // There is no calendar integration. A visible-but-empty section would be a
    // claim that the app can see somebody's diary.
    await configure();
    const mounted = mount(createElement(MeetingsListScreen));
    expect(mounted.container.textContent).not.toContain("Coming up");
    mounted.unmount();
  });

  test("a calendar event, when something does supply one, offers Record and nothing to open", async () => {
    await configure();
    const soon = new Date(Date.now() + 12 * 60_000).toISOString();
    const ends = new Date(Date.now() + 60 * 60_000).toISOString();
    const mounted = mount(
      createElement(MeetingsListScreen, {
        upcoming: [
          {
            id: "ev-1",
            title: "Design review — Portal",
            startsAt: soon,
            endsAt: ends,
            attendees: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
          },
        ],
      }),
    );
    expect(mounted.container.textContent).toContain("Coming up");
    expect(mounted.container.textContent).toContain("Design review — Portal");
    expect(mounted.container.textContent).toContain("4 people");
    expect(has(mounted.container, "meeting-upcoming-ev-1")).toBe(true);
    mounted.unmount();
  });

  test("pressing record starts a meeting and opens it", async () => {
    await configure();
    const mounted = mount(createElement(MeetingsListScreen));
    press(mounted.container, "meetings-record");
    await act(async () => {
      await Promise.resolve();
    });

    const live = meetings.getSnapshot().live;
    expect(live).not.toBeNull();
    expect(pushed).toEqual([`/meetings/${live?.session.id}`]);
    mounted.unmount();
  });

  test("a meeting whose note is not in the bucket is marked a draft", async () => {
    await configure();
    await act(async () => {
      await meetings.start({ title: "Reboot Camp" });
    });
    const mounted = mount(createElement(MeetingsListScreen));
    expect(mounted.container.textContent).toContain("Reboot Camp");
    expect(mounted.container.textContent).toContain("Draft");
    mounted.unmount();
  });
});

describe("the live screen is a notepad with a recorder attached", () => {
  test("a transcript arriving leaves the typed notes exactly where they were", async () => {
    /*
      The same guarantee `meetingsTyping.test.ts` proves about the control, this
      time through the whole real path: the real controller, the real screen, a
      real segment from a recorder.
    */
    const { recorder } = await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });

    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    const pad = mounted.container.querySelector("textarea") as HTMLTextAreaElement;

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(pad, "curiosity is the prerequisite");
      pad.dispatchEvent(new Event("input", { bubbles: true }));
    });
    pad.setSelectionRange(9, 9);

    act(() => {
      (recorder as ReturnType<typeof fakeRecorder>).emit(fakeSegment("s1", 0, "hello there"));
      (recorder as ReturnType<typeof fakeRecorder>).emit(fakeSegment("s2", 2_000, "and again"));
    });

    expect(pad.value).toBe("curiosity is the prerequisite");
    expect(pad.selectionStart).toBe(9);
    // And the transcript really did arrive — otherwise this test proves nothing.
    expect(meetings.getSnapshot().live?.session.transcript).toHaveLength(2);
    mounted.unmount();
  });

  test("the transcript is a chip, not a column", async () => {
    // The mockup reduces it to a status chip precisely so nothing about it can
    // compete with the caret. A word count and a state, and none of the words
    // anybody said.
    const { recorder } = await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));

    act(() => {
      (recorder as ReturnType<typeof fakeRecorder>).emit(
        fakeSegment("s1", 0, "a sentence somebody said out loud"),
      );
    });

    expect(mounted.container.textContent).not.toContain("a sentence somebody said out loud");
    expect(mounted.container.textContent).toContain("Transcribing");
    mounted.unmount();
  });

  test("End does not navigate — the same route becomes the note", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));

    press(mounted.container, "meeting-end");
    await act(async () => {
      await Promise.resolve();
    });

    expect(pushed).toEqual([]);
    expect(meetings.getSnapshot().live).toBeNull();
    mounted.unmount();
  });

  test("a meeting this device does not hold says so rather than drawing an empty note", async () => {
    await configure();
    const mounted = mount(
      createElement(LiveMeetingScreen, { meetingId: "mtg_aaaaaaaaaaaaaaaaaaaa" }),
    );
    expect(has(mounted.container, "meeting-missing")).toBe(true);
    mounted.unmount();
  });
});

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
    expect(meetings.getSnapshot().live?.session.state).toBe("paused");
    press(mounted.container, "recording-bar-pause");
    expect(meetings.getSnapshot().live?.session.state).toBe("recording");
    mounted.unmount();
  });
});

describe("`saved` is said only when there is a path to print", () => {
  test("a finished meeting shows where it landed in the bucket", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
      meetings.setNotes(id, "curiosity is the prerequisite");
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("Saved to your bucket");
    expect(mounted.container.textContent).toContain(`0-inbox/meetings/${id}.md`);
    mounted.unmount();
  });

  test("a meeting still on the device does not claim to be saved", async () => {
    const gateway = fakeGateway();
    gateway.offlineFor(50);
    await act(async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "ws-offline",
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
    expect(mounted.container.textContent).not.toContain("Saved to your bucket");
    expect(mounted.container.textContent).toContain("Not in your bucket yet");
    // And the person's own words are on the screen, which is the point of
    // showing them: they can see what survived.
    expect(mounted.container.textContent).toContain("typed underground");
    mounted.unmount();
  });

  test("a folder the context would not file into is said on the screen, not swallowed", async () => {
    /*
      `IngestAck.folderRejected` and the sentence it is for. The gateway falls
      back to the default rather than losing the meeting over one bad string —
      that trade is right, and it is only right if the person is told, because
      a fallback nobody hears about is exactly the destination control that
      appears to work and does nothing.

      The path is still printed and still says `Saved to your bucket`, because
      it is: the note exists and this is where it is. What is added is why it is
      not where they pointed.
    */
    await configure({ refusesFolder: (folder) => folder === "2-areas/private" });
    let id = "";
    await act(async () => {
      id = await meetings.start({
        title: "Reboot Camp",
        destination: {
          kind: "currentPage",
          contextSlug: "me",
          folder: "2-areas/private",
          label: "2-areas/private",
        },
      });
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("Saved to your bucket");
    expect(mounted.container.textContent).toContain("not the folder you chose");
    // And never the folder it refused: the ack carries no copy of it, so
    // neither can the screen.
    expect(mounted.container.textContent).not.toContain("2-areas/private");
    mounted.unmount();
  });

  test("a folder that was honoured says nothing about folders at all", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({
        title: "Reboot Camp",
        destination: {
          kind: "currentPage",
          contextSlug: "me",
          folder: "1-projects/portal",
          label: "1-projects/portal",
        },
      });
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("Saved to your bucket");
    expect(mounted.container.textContent).not.toContain("not the folder you chose");
    mounted.unmount();
  });

  test("the human's notes are drawn beside the generated ones, labelled unchanged", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
      meetings.setNotes(id, "Phil 1:6 — he who began a good work");
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("My notes, unchanged");
    expect(mounted.container.textContent).toContain("Phil 1:6 — he who began a good work");
    mounted.unmount();
  });

  test("the transcript is a section of this note, not a place to navigate to", async () => {
    // One file per meeting: the transcript is `## Transcript` in the same
    // Markdown note whose path is printed at the bottom of this screen.
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(has(mounted.container, "meeting-transcript")).toBe(false);
    press(mounted.container, "meeting-transcript-toggle");
    expect(has(mounted.container, "meeting-transcript")).toBe(true);
    expect(pushed).toEqual([]);
    mounted.unmount();
  });
});

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
