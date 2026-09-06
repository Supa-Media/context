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
const { meetingKey } =
  require("../features/meetings/keys") as typeof import("../features/meetings/keys");
const { MEETING_RECORD_VERSION, emptyAck } =
  require("../features/meetings/record") as typeof import("../features/meetings/record");
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

  test("a queued meeting is on the list, and a failed one is on it too", async () => {
    /*
      The two states a person is most likely to be looking for, because they are
      the two the bucket does not hold: one waiting to be sent and one whose
      finalize was refused. Neither may be hidden — the list is the only thing
      standing between somebody and a meeting that exists nowhere else, and
      nothing on this screen consults a gateway to draw a row.
    */
    const { gateway } = await configure();
    let queued = "";
    let refused = "";
    // The refusal first, while the gateway is still answering: a permanent code
    // parks the record rather than retrying it.
    await act(async () => {
      refused = await meetings.start({ title: "Refused by the context" });
      gateway.failNext("meeting_invalid", "no");
      await meetings.end();
      await meetings.sync();
    });
    // Then the queue, with the gateway unreachable for the rest of the test.
    gateway.offlineFor(50);
    await act(async () => {
      queued = await meetings.start({ title: "Waiting to send" });
      await meetings.end();
      await meetings.sync();
    });

    const mounted = mount(createElement(MeetingsListScreen));
    expect(mounted.container.textContent).toContain("Waiting to send");
    expect(mounted.container.textContent).toContain("Refused by the context");
    expect(has(mounted.container, "meetings-empty")).toBe(false);

    /*
      And the two really are in the states this test is named for, rather than
      two ordinary rows that would have rendered anyway. A vacuous version of
      this test is worth nothing — `emptyConsoleStats.test.ts`'s harness was
      exactly that for a while.
    */
    const records = meetings.getSnapshot().records;
    const queuedRecord = records.find((record) => record.session.id === queued);
    const refusedRecord = records.find((record) => record.session.id === refused);
    expect(queuedRecord?.session.notePath).toBeNull();
    expect(refusedRecord?.rejection).toBeDefined();
    // The refusal is a fact about the send, and the meeting is still a meeting:
    // it is on the list, and its own screen says it has not left the device.
    expect(refusedRecord?.session.notes).toBeDefined();
    mounted.unmount();
  });

  test("a meeting with no readable date is on the list, not silently missing", async () => {
    /*
      The same defect as an unreachable route, one layer down: `isSession` asks
      `startedAt` for a string rather than a date, so a record with a broken one
      loads, is *not* counted among the unreadable, and opens perfectly at
      `/meetings/:id` — while `groupMeetings` dropped it in a `continue`. One
      alone on a device drew "Nothing recorded on this device yet" over a
      meeting that was right there.

      Seeded through the store rather than the controller, because the
      controller cannot write this: it is what a hand-edited record, or one
      written by another build, looks like on the way back in.
    */
    const store = memoryStore();
    await store.set(
      meetingKey("ws-undated", "mtg_undatedundatedunda"),
      JSON.stringify({
        version: MEETING_RECORD_VERSION,
        workspaceId: "ws-undated",
        session: {
          id: "mtg_undatedundatedunda",
          title: "The one with no date",
          state: "complete",
          startedAt: "nonsense",
          endedAt: null,
          notes: "still somebody's meeting",
          transcript: [],
          attendees: [],
          recordedMs: 0,
          source: { kind: "in-person" },
          enhanced: null,
          notePath: null,
          failureReason: null,
          flags: [],
        },
        acked: emptyAck(),
        destination: null,
        runningSince: null,
        updatedAt: 0,
        attempts: 0,
      }),
    );
    await act(async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "ws-undated",
        store,
        gateway: fakeGateway(),
        recorder: fakeRecorder(),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
    });

    const mounted = mount(createElement(MeetingsListScreen));
    expect(meetings.getSnapshot().unreadable).toBe(0);
    expect(has(mounted.container, "meetings-empty")).toBe(false);
    expect(mounted.container.textContent).toContain("The one with no date");
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
    expect(mounted.container.textContent).toContain(
      "did not file this meeting in the folder you chose",
    );
    // And never the folder it refused: the ack carries no copy of it, so
    // neither can the screen.
    expect(mounted.container.textContent).not.toContain("2-areas/private");
    /*
      **And it does not claim this is the default folder**, because that is only
      one of the two cases `folderRejected` covers. The gateway sets the flag
      equally when the folder was legal and a *different* one had already been
      claimed — a second finalize naming somewhere else, or a retry after a
      failed note write — and the note is then in the claimed folder, which is
      neither the default nor the one the person picked. See
      `IngestAck.folderRejected` in `packages/meetings/src/protocol.js`, whose
      own description said only the first case, and `folderFlag` in
      `apps/mcp/src/meetings/ingest.js`, which has always set both.

      SABOTAGE: put "so this is the default folder" back into
      `FOLDER_REJECTED_NOTICE`. MEASURED: this line fails.
    */
    expect(mounted.container.textContent).not.toContain("default folder");
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
      require("../features/design/keyboardSticky") as typeof import("../features/design/keyboardSticky");
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
      join(__dirname, "..", "features", "meetings", "LiveMeetingScreen.tsx"),
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
      join(__dirname, "..", "features", "design", "keyboardSticky.tsx"),
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
