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
  MeetingsListScreen,
  LiveMeetingScreen,
  configure,
  continuationFromRecord,
  emptyAck,
  fakeGateway,
  fakeRecorder,
  fakeSegment,
  field,
  has,
  meetingKey,
  meetings,
  MEETING_RECORD_VERSION,
  memoryStore,
  mount,
  press,
  typeInto,
} from "./fixtures";

/**
 * What the list says it knows and no more, and the live screen's notepad
 * with a recorder attached. See `fixtures.ts` for the screens, controller and
 * fakes this suite mounts against, and the module doc comment there for the
 * rule these tests enforce.
 */

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

  test("a resumed meeting does not say when this part started", async () => {
    /*
      Its clock carries on from where the note left off, so the part's own
      start time beside it would say the meeting began a minute ago.
    */
    await configure();
    let first = "";
    await act(async () => {
      first = await meetings.start({ title: "Reboot Camp" });
      meetings.setNotes(first, "before the break");
      await meetings.end();
    });

    const landed = meetings.getSnapshot().records.find((r) => r.session.id === first)!;
    expect(landed.session.state).toBe("complete");
    const continues = continuationFromRecord(meetings.getSnapshot().records, landed)!;
    let second: string | null = null;
    await act(async () => {
      second = await meetings.continueMeeting({ continues, title: "Reboot Camp", destination: null });
    });
    const resumed = mount(createElement(LiveMeetingScreen, { meetingId: second! }));
    expect(resumed.container.querySelector('[data-testid="meeting-clock"]')).not.toBeNull();
    expect(resumed.container.querySelector('[data-testid="meeting-started-at"]')).toBeNull();
    resumed.unmount();

    await act(async () => {
      await meetings.end();
    });
    let fresh = "";
    await act(async () => {
      fresh = await meetings.start({ title: "Something else" });
    });
    const plain = mount(createElement(LiveMeetingScreen, { meetingId: fresh }));
    expect(plain.container.querySelector('[data-testid="meeting-started-at"]')).not.toBeNull();
    plain.unmount();
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

  /**
   * THE SENTENCE THAT SAYS THE TRANSCRIPT HAS STOPPED IS ON THE GLASS.
   *
   * The last link in the chain the desktop bridge's `notice` field opened. The
   * shell raises `CAPTURE_NOTICES.refused` — "this meeting is not being
   * transcribed" — `desktop.ts` reports it as a recorder error, the controller
   * puts it on `captureError`, and *this* is where somebody actually reads it.
   * A field nothing displayed would repeat the original defect one layer up:
   * for a whole day the only place an empty transcript announced itself was the
   * empty transcript.
   *
   * The chip outranks "Listening", which is the point — a meeting that is not
   * being transcribed must not go on claiming that it is.
   */
  test("a notice from the recorder replaces the transcript chip", async () => {
    const { recorder } = await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("Listening");

    const refused =
      "This meeting is not being transcribed — the gateway would not accept the audio. Your notes and the meeting still land in your bucket.";
    act(() => {
      (recorder as ReturnType<typeof fakeRecorder>).fail({ recoverable: false, message: refused });
    });

    expect(mounted.container.textContent).toContain("not being transcribed");
    expect(mounted.container.textContent).not.toContain("Listening");
    mounted.unmount();
  });

  test("the foreground-only warning stays fully visible through later capture notices", async () => {
    const recorder = fakeRecorder();
    const warning =
      "Recording works while Context stays open, but locking your phone will stop the audio.";
    const originalStart = recorder.start.bind(recorder);
    recorder.start = async (options) => {
      await originalStart(options);
      // The controller subscribes before start so it cannot miss a synchronous
      // runtime downgrade reported while the native recorder is opening.
      recorder.fail({
        recoverable: true,
        kind: "background-unavailable",
        message: warning,
      });
    };
    await configure({ recorder });
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Reboot Camp" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));

    act(() => {
      recorder.fail({
        recoverable: true,
        message:
          "No speech was heard in the last stretch of audio, so nothing was transcribed from it. Capture is still running.",
      });
    });

    const notice = mounted.container.querySelector(
      '[data-testid="meeting-background-warning"]',
    );
    expect(notice?.textContent).toBe(warning);
    expect((notice?.querySelector("div") as HTMLElement | null)?.style.whiteSpace).not.toBe(
      "nowrap",
    );
    expect(mounted.container.textContent).toContain("No speech was heard");
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

  test("End says it is ending, for the whole of the wait it used to spend silent", async () => {
    /*
      THE FIVE SECONDS NOBODY WAS TOLD ABOUT.

      `end()` stops the recorder before anything about the session moves, and
      stopping drains the last chunk so the end of the meeting lands in the
      note — a deliberate trade `capture/audio.ts` calls "a spinner rather than
      a microphone". The spinner was never drawn. The session stayed
      `recording`, this screen went on ticking, and the owner pressed End and
      watched nothing happen: *"it literally takes, like, five seconds with no
      indicator of what's going on."*

      So the test stands **inside** that wait — `holdStop` is what makes the
      window real rather than a tick long — and asserts the three things a
      person needs there: the control says what it is doing, it stops taking
      presses, and the screen says what is being waited for. Then it lets go
      and the meeting finishes, because an indicator that never clears is the
      same defect wearing a different hat.
    */
    // Built here rather than taken from `configure`'s return, so it is typed as
    // the fake — `holdStop` is the fake's own control and not a recorder's.
    const recorder = fakeRecorder();
    await configure({ recorder });
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Slow to stop" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));

    const release = recorder.holdStop();
    let ending: Promise<void> = Promise.resolve();
    await act(async () => {
      ending = meetings.end();
      await Promise.resolve();
    });

    expect(mounted.container.textContent).toContain("Ending");
    expect(has(mounted.container, "meeting-ending")).toBe(true);
    expect(
      field<HTMLElement>(mounted.container, "meeting-end").getAttribute("aria-disabled"),
    ).toBe("true");
    // Still recording as far as the contract is concerned, which is why the
    // wait needs saying at all rather than being covered by the note screen.
    expect(meetings.getSnapshot().live).not.toBeNull();

    await act(async () => {
      release();
      await ending;
    });
    expect(meetings.getSnapshot().ending).toBeNull();
    expect(meetings.getSnapshot().live).toBeNull();
    mounted.unmount();
  });

  test("the clock stops when the microphone does, not when the transcript lands", async () => {
    /*
      *"The post processing step was just really slow… the countdown doesn't
      stop."*

      `recorder.stop()` used to wait for every outstanding transcription, and
      `end()` cannot fold the `end` event until it resolves — so the session
      stayed `recording` for the whole of it. The person got the live screen, a
      running clock and a microphone chip over a meeting they had finished, for
      as long as the network took.

      The wait still exists and is still worth having: the finalize composes
      the note from the transcript this session holds, so a segment arriving
      after it is a note missing the end of the meeting. It happens *after* the
      fold now, behind `MeetingNoteScreen` and the sentence that screen already
      has for it.

      Held open on purpose, because a drain that resolves on the next tick
      cannot tell a fold-before from a fold-after.
    */
    const recorder = fakeRecorder();
    await configure({ recorder });
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Slow to write up" });
      // Something to file: a session that captured nothing folds to `empty`,
      // which is terminal and never reaches a finalize at all.
      meetings.setNotes(id, "the decision");
    });

    const release = recorder.holdDrain();
    let ending: Promise<void> = Promise.resolve();
    await act(async () => {
      ending = meetings.end();
      await Promise.resolve();
    });

    /*
      Mid-drain: the meeting is over as far as every screen is concerned. The
      session has left `recording`, so `[id].tsx` is drawing the note screen,
      the clock is not running, and the bar is down.
    */
    expect(meetings.getSnapshot().live).toBeNull();
    expect(meetings.getSnapshot().records[0]?.session.state).toBe("finalizing");
    expect(meetings.getSnapshot().ending).toBeNull();

    /*
      And the screen says what is actually outstanding. Before this it had one
      sentence for a meeting with no note — "waiting to reach your context" —
      which describes a network problem the person does not have.
    */
    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("turning the last of the audio into words");
    expect(mounted.container.textContent).not.toContain("Waiting to reach your context");
    expect(has(mounted.container, "meeting-ending")).toBe(false);
    mounted.unmount();

    await act(async () => {
      release();
      await ending;
    });
    expect(meetings.getSnapshot().records[0]?.session.state).toBe("complete");
  });

  test("a recorder that will not stop still ends the meeting, and stops saying Ending", async () => {
    /*
      THE FAILURE MODE AN INDICATOR ADDS THAT SILENCE COULD NOT.

      `ending` is published before an `await`, and the thing awaited is the one
      call this feature deliberately swallows the failure of — "a recorder that
      will not stop is not a reason to refuse to end a meeting". Left set by
      that path it would be a meeting stuck saying it is ending, with End and
      Pause both refused, for the life of the process: worse than the silence
      it replaced, because the silence at least left the controls working.

      **What this does not prove is the `finally` itself**, and the sabotage
      says so: `stopAndFold` catches the recorder's rejection internally, so
      the clear on the ordinary path is what runs here. Removing the `finally`
      alone leaves this green; removing the clear altogether fails it. The
      `finally` is belt and braces over the rest of that body, and it is kept
      for the reason it is cheap and this flag is one a person is looking at.
    */
    const recorder = fakeRecorder();
    await configure({ recorder });
    await act(async () => {
      await meetings.start({ title: "Will not stop" });
    });
    recorder.stop = async () => {
      throw new Error("the device is gone");
    };
    await act(async () => {
      await meetings.end();
    });
    expect(meetings.getSnapshot().ending).toBeNull();
    expect(meetings.getSnapshot().records[0]?.session.state).not.toBe("recording");
  });

  test("the meeting can be named while it is being recorded", async () => {
    /*
      `controller.setTitle` shipped with no callers at all, so every meeting
      this app has ever written is called "New meeting" — in the list, in the
      note's `# ` heading, and in the key the note is filed under. The owner's
      report: *"i can't even edit the meeting title."*

      Typed rather than called: the point of the test is the wiring, and
      `meetings.setTitle(id, …)` would pass against a screen that renders the
      name as static text, which is exactly the version being replaced.
    */
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "New meeting" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));

    typeInto(field<HTMLInputElement>(mounted.container, "meeting-title"), "Pricing, round two");
    expect(meetings.getSnapshot().records[0]?.session.title).toBe("Pricing, round two");

    /*
      And an empty field is not an empty title. `normalizeTitle` is the
      contract's own fallback, and without it a note heading of `# ` and a
      nameless row in the list are one backspace away.
    */
    typeInto(field<HTMLInputElement>(mounted.container, "meeting-title"), "   ");
    expect(meetings.getSnapshot().records[0]?.session.title).toBe("Untitled meeting");
    mounted.unmount();
  });

  test("the transport has one meter on it, and the pause button is not it", async () => {
    /*
      *"Why are there two different equalizers, and the one that's supposed to
      it doesn't even move?"*

      Because the pause button drew a `Waveform` — the same five-bar mark the
      live meter beside it is drawn from — so the bar carried two equalizers and
      only one of them was ever going to move. `Waveform`'s own header states
      the rule this broke: "a meter that responds to sound is a capability
      claim". A mark shaped like a meter makes that claim whether or not
      anything behind it is measuring.

      Counted rather than eyeballed, and counted on the thing that differs: a
      waveform is five bars, the pause mark is two, and a play triangle is a
      single leaf. Putting a `Waveform` back on the button is the regression
      this fails on, and it is the only assertion available — both marks are
      `View`s, both are the right colour, and a screenshot of either at rest
      looks deliberate.
    */
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Two equalizers" });
    });
    const mounted = mount(createElement(LiveMeetingScreen, { meetingId: id }));

    expect(mounted.container.querySelectorAll('[data-testid="meeting-level"]')).toHaveLength(1);
    expect(field<HTMLElement>(mounted.container, "meeting-pause-mark").children).toHaveLength(2);

    // And paused it is a triangle: one box, no children at all.
    await act(async () => {
      await meetings.pause();
    });
    expect(field<HTMLElement>(mounted.container, "meeting-pause-mark").children).toHaveLength(0);
    expect(mounted.container.querySelectorAll('[data-testid="meeting-level"]')).toHaveLength(1);
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

