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
  RECORDED_INTO,
  configure,
  currentEpoch,
  emptyAck,
  fakeGateway,
  fakeRecorder,
  field,
  FINALIZE_TIMEOUT_MS,
  has,
  meetingKey,
  meetings,
  MEETING_PROTOCOL_VERSION,
  MEETING_RECORD_VERSION,
  memoryStore,
  mount,
  pendingSteps,
  press,
  saveMeeting,
  seedSession,
  typeInto,
} from "./fixtures";

/**
 * `saved` is said only when there is a path to print: the note-taking screen's
 * claims about what has and has not reached the bucket. See `fixtures.ts` for
 * the screens, controller and fakes this suite mounts against, and the module
 * doc comment there for the rule these tests enforce.
 */

beforeEach(() => {
  pushed.length = 0;
});

/* -------------------------------------------------------------------------- */

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

  /*
    A session that captured nothing is not "not saved yet" — nothing is coming.
    `session.notePath === null` is true of both, and this is the check that
    keeps the false promise ("sent as soon as your context answers") off a
    meeting that will never be sent.
  */
  test("a session that captured nothing says so, and offers a way to try again", async () => {
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Refused microphone" });
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).not.toContain("Saved to your bucket");
    expect(mounted.container.textContent).not.toContain("Not in your bucket yet");
    expect(mounted.container.textContent).toContain("Nothing was captured");
    expect(mounted.container.textContent).toContain("Record again");
    mounted.unmount();
  });

  /*
    Nor is a `failed` session "not saved yet", and it is the sharper case of
    the two: recovery's own `fail` is what puts a meeting there, and nothing
    queues a finalize for a session that is not `finalizing`. So the screen
    that told somebody it would be "sent as soon as your context answers" was
    promising a send no code path was going to make.
  */
  test("a meeting recovery gave up on says it was not filed, and offers Retry", async () => {
    const gateway = fakeGateway();
    gateway.offlineFor(50);
    await act(async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "ws-gave-up",
        store: memoryStore(),
        gateway,
        recorder: fakeRecorder(),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
    });

    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Stuck, then given up on" });
      meetings.setNotes(id, "typed while the gateway was quiet");
      await meetings.end();
    });
    await act(async () => {
      // Retried once, then failed — the pure rule, driven with an explicit
      // clock rather than a wait.
      meetings.recoverStaleFinalizes(Date.now() + FINALIZE_TIMEOUT_MS);
      meetings.recoverStaleFinalizes(Date.now() + FINALIZE_TIMEOUT_MS * 3);
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).not.toContain("Not in your bucket yet");
    expect(mounted.container.textContent).not.toContain("Saved to your bucket");
    expect(mounted.container.textContent).toContain("Not filed");
    expect(mounted.container.textContent).toContain("Retry");
    // And the words are still on the screen, which is what the Retry is for.
    expect(mounted.container.textContent).toContain("typed while the gateway was quiet");
    mounted.unmount();
  });

  test("A REFUSAL AFTER THE NOTE LANDED DOES NOT UN-SAY THE PATH", async () => {
    /*
      THE CONTRADICTION A PERSON WATCHED HAPPEN, ON ONE MEETING, TEN MINUTES
      APART.

      This screen said "Saved to your bucket" with the path, and later said
      "This meeting has not left the device — gateway answered 400" about the
      same meeting. The note was in the bucket the whole time; what had been
      refused was one *later* write. The `rejection` branch ran before the
      `notePath` branch and claimed the whole meeting, and the sentence it
      claimed it with was an HTTP status.

      Both facts are true and both are said: the note is where the path says,
      and something about the meeting did not go. Neither shows a status code.
    */
    const { gateway } = await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Saved, then refused" });
      meetings.setNotes(id, "the decision");
      await meetings.end();
    });

    const saved = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(saved.container.textContent).toContain("Saved to your bucket");
    saved.unmount();

    // A later write about the same meeting, refused in the way that parks it.
    await act(async () => {
      gateway.failNext("meeting_invalid", "these segments were minted for another meeting");
      meetings.setNotes(id, "the decision, expanded");
      await meetings.sync();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).not.toContain("This meeting has not left the device");
    expect(mounted.container.textContent).toContain("Saved to your bucket");
    expect(mounted.container.textContent).toContain(`0-inbox/meetings/${id}.md`);
    expect(mounted.container.textContent).toContain("Part of this meeting was not sent");
    // The gateway's own sentence, which this app could not see at all until
    // `postEntry` started reading `error_description`. Never a bare status.
    expect(mounted.container.textContent).toContain("minted for another meeting");
    expect(mounted.container.textContent).not.toContain("gateway answered");
    mounted.unmount();
  });

  test("a saved meeting with words still on the device says so, and a finished one does not", async () => {
    /*
      THE THIRD LINE, WHICH NOTHING ELSE CHECKS.

      A tick and a path are said the instant finalize lands, and a write that
      belongs to this meeting can still be sitting in the queue behind it. This
      screen may not imply the file is finished while one is, which is
      `app-and-console.md`'s rule about never claiming a write nobody has seen
      land, applied one write later than usual.

      It is also the line most likely to be wrong in the crying-wolf
      direction: a `session` step is pending on **every** finished meeting the
      instant its note lands, because folding the gateway's `written` answer
      changes the metadata fingerprint. So the negative half is asserted first,
      on a meeting that is genuinely finished, and it is the half that fails if
      `stillSending` ever stops filtering to content steps.

      **The pending step here is a transcript batch, and it used to be typing.**
      `pendingSteps` no longer offers a `notes` step for a `complete` session —
      there is nothing left that would accept one — so typing after the note
      lands is a different sentence now, and the test below is the one that
      asserts it. The record is seeded rather than driven, because the
      controller cannot produce this: it is a device coming back with a batch
      whose acknowledgement never arrived, which is the case the line exists for.
    */
    const store = memoryStore();
    await store.set(
      meetingKey("ws-tail", "mtg_tailtailtailtailx"),
      JSON.stringify({
        version: MEETING_RECORD_VERSION,
        workspaceId: "ws-tail",
        session: {
          id: "mtg_tailtailtailtailx",
          title: "Saved, with a tail",
          state: "complete",
          startedAt: "2026-09-11T10:00:00.000Z",
          endedAt: "2026-09-11T10:30:00.000Z",
          notes: "the decision",
          transcript: [
            {
              id: "mtg_tailtailtailtailx:0",
              startMs: 0,
              endMs: 900,
              text: "the last thing anybody said",
              speaker: null,
            },
          ],
          attendees: [],
          recordedMs: 1_800_000,
          source: { kind: "in-person" },
          enhanced: null,
          notePath: "0-inbox/meetings/2026-09-11-saved-with-a-tail-ailtailx.md",
          failureReason: null,
          flags: [],
        },
        // The note landed and the metadata was acknowledged with it; the batch
        // was not. That is exactly one content step outstanding.
        acked: { metadata: null, segmentIds: [], notes: "the decision", finalized: true },
        destination: null,
        runningSince: null,
        updatedAt: 0,
        attempts: 0,
      }),
    );
    await act(async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "ws-tail",
        store,
        gateway: fakeGateway(),
        recorder: fakeRecorder(),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
    });

    const sending = mount(
      createElement(MeetingNoteScreen, { meetingId: "mtg_tailtailtailtailx" }),
    );
    expect(sending.container.textContent).toContain("Saved to your bucket");
    expect(sending.container.textContent).toContain(
      "The rest of this meeting is still being sent from this device",
    );
    expect(sending.container.textContent).not.toContain("This meeting has not left the device");
    sending.unmount();

    // And the negative half, on a meeting with nothing outstanding at all.
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Saved and finished" });
      meetings.setNotes(id, "the decision");
      await meetings.end();
    });
    const settled = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(settled.container.textContent).toContain("Saved to your bucket");
    expect(settled.container.textContent).not.toContain("still being sent");
    settled.unmount();
  });

  test("typing after the note landed is said to be on this device, not sent and not dropped", async () => {
    /*
      THE SEAM THE POST-MEETING NOTEPAD OPENS, AND THE ONE ANSWER THAT IS TRUE.

      `MeetingNoteScreen` takes notes while a meeting is `finalizing`, because
      the note is composed from the session when the finalize runs. A keystroke
      landing in the seconds *after* that has missed it: the gateway's notes
      route refuses a complete session in its own words — "this session is
      already complete; edit the note instead" — and `createConvexGateway` has
      already done its one write, so it would acknowledge the text and write
      nothing.

      Three things could happen to those words and two of them are defects.
      They could be silently dropped. They could be queued forever behind a
      request that will always be refused, under a line claiming the meeting is
      "still being sent" — the crying-wolf version, and what this screen did
      before `pendingSteps` learned the guard. Or the person is told they are
      on this device and shown where to put them. This asserts the third and
      rules out the second by name.
    */
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Typed into afterwards" });
      meetings.setNotes(id, "what I managed during");
      await meetings.end();
    });
    expect(meetings.getSnapshot().records[0]?.session.state).toBe("complete");

    await act(async () => {
      meetings.setNotes(id, "what I managed during\n\nand the bit I remembered after");
      await meetings.sync();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    // Kept, and visible: the words are not thrown away to keep a queue tidy.
    expect(mounted.container.textContent).toContain("the bit I remembered after");
    expect(mounted.container.textContent).toContain("on this device only");
    expect(mounted.container.textContent).not.toContain("still being sent");
    mounted.unmount();

    // And nothing is queued for a route that would refuse it.
    const record = meetings.getSnapshot().records.find((r) => r.session.id === id);
    expect(record).toBeDefined();
    expect(pendingSteps(record!).some((step) => step.kind === "notes")).toBe(false);
  });

  test("a meeting with nothing in the bucket and a refusal still says it has not left", async () => {
    /*
      The other half, unchanged and still needed: with no path, nothing has
      left, and that is what a person is told — in words rather than a code.
    */
    const gateway = fakeGateway();
    await act(async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "ws-refused",
        store: memoryStore(),
        gateway,
        recorder: fakeRecorder(),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
    });

    let id = "";
    await act(async () => {
      gateway.failNext("meeting_forbidden", "this grant may not write here");
      id = await meetings.start({ title: "Refused outright" });
      meetings.setNotes(id, "typed anyway");
      await meetings.end();
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("This meeting has not left the device");
    expect(mounted.container.textContent).toContain("Connect it again");
    expect(mounted.container.textContent).not.toContain("Saved to your bucket");

    /*
      AND A WAY TO SAY "DONE, TRY IT NOW".

      This sentence has always ended with something for a person to *do* —
      connect the machine again — and this branch then offered them nothing to
      press. The only control that reached `retrySync` was the header's
      **Re-run**, labelled for the enhancement, which is not what somebody who
      has just reconnected a machine goes looking for.

      `retrySync` clears `rejection` on the way through precisely so the
      attempt reaches the gateway again, so pressing this is a real second
      attempt rather than a relabelled wait.
    */
    const before = gateway.calls.length;
    await act(async () => {
      press(mounted.container, "meeting-retry-sync");
      await Promise.resolve();
    });
    expect(gateway.calls.length).toBeGreaterThan(before);
    mounted.unmount();
  });

  /*
    `markSyncFailed`'s own backstop for a session with nothing captured that
    still reached the retry-exhausted path — which, after the fix beside it,
    `end()` and `recoverInterruptedRecordings` no longer let happen on their
    own. Written directly to the store, the way "a record another version
    wrote" is in `meetingsController.test.ts`, because nothing on the ordinary
    path reaches this branch any more; the point of the test is that if it
    ever is reached again, the screen still says the true, permanent thing
    rather than "try again" or "This meeting has not left the device".
  */
  test("a parked meeting with nothing in it never says try again, even as a backstop", async () => {
    const store = memoryStore();
    const id = "mtg_nothingcapturedxxx1";
    await saveMeeting(
      store,
      {
        version: MEETING_RECORD_VERSION,
        workspaceId: "ws-backstop",
        session: seedSession({
          id,
          title: "Backstop case",
          startedAt: "2026-09-05T18:00:00.000Z",
          source: { kind: "in-person" },
          device: { platform: "web" },
          transcription: null,
          version: MEETING_PROTOCOL_VERSION,
        }),
        destination: null,
        acked: emptyAck(),
        runningSince: null,
        updatedAt: 0,
        attempts: 6,
        rejection: {
          code: "NOTHING_CAPTURED",
          message:
            "Nothing was captured during this meeting, so there is nothing to send and nothing to copy out.",
          noticedAt: 0,
        },
      },
      currentEpoch(),
    );

    await act(async () => {
      meetings.reset();
      await meetings.configure({
        workspaceId: "ws-backstop",
        store,
        gateway: fakeGateway(),
        recorder: fakeRecorder(),
        device: { platform: "web" },
        persistDebounceMs: 0,
      });
    });

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(mounted.container.textContent).toContain("Nothing was captured");
    expect(mounted.container.textContent).not.toContain("try again");
    expect(mounted.container.textContent).not.toContain("several times");
    expect(mounted.container.textContent).not.toContain("This meeting has not left the device");
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
      meetings.setNotes(id, "camp notes");
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
      meetings.setNotes(id, "camp notes");
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

  test("a meeting still being written up takes the notes you did not have time for", async () => {
    /*
      *"There's no way to add post meeting notes."* The card printed what was
      typed and took nothing.

      It takes them while the note has not been written yet, which is the
      window in which they still reach the file: on this app's writer the note
      is composed *from this session* when the finalize runs, and on the
      gateway's the `notes` route accepts every state but `complete`. Driven
      here through a `finalizing` session — the gateway is offline, so finalize
      has not landed — and asserted on the session rather than on the DOM,
      because the pad is uncontrolled and its own value proves nothing about
      where the words went.
    */
    const { gateway } = await configure();
    let id = "";
    await act(async () => {
      gateway.offlineFor(50);
      id = await meetings.start({ title: "Still being written up" });
      meetings.setNotes(id, "what I managed during");
      await meetings.end();
    });
    expect(meetings.getSnapshot().records[0]?.session.state).toBe("finalizing");

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    typeInto(
      field<HTMLTextAreaElement>(mounted.container, "meeting-own-notes-pad"),
      "what I managed during\n\nand the three things I remembered after",
    );
    expect(meetings.getSnapshot().records[0]?.session.notes).toContain(
      "the three things I remembered after",
    );
    mounted.unmount();
  });

  test("a meeting whose note landed offers the note instead of a pad", async () => {
    /*
      `complete` is terminal by the contract, and deliberately: *"once the note
      is in the customer's bucket, the note is the meeting and it is edited as
      a note."* That decision was missing its other half — the screen printed
      the address and offered no door, so the title, the summary, the notes and
      the transcript were all visibly there and all read-only.

      Both halves are asserted together because each without the other is a
      defect: a pad here would collect words nothing will ever write out, and
      no door leaves somebody looking at a file they own and cannot open.
    */
    await configure();
    let id = "";
    await act(async () => {
      id = await meetings.start({ title: "Pricing, round two", destination: RECORDED_INTO });
      meetings.setNotes(id, "the decision");
      await meetings.end();
    });
    const record = meetings.getSnapshot().records[0];
    expect(record?.session.state).toBe("complete");

    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(has(mounted.container, "meeting-own-notes-pad")).toBe(false);
    expect(has(mounted.container, "meeting-edit-note")).toBe(true);

    press(mounted.container, "meeting-edit-note");
    /*
      The console's own file page, addressed by the context this meeting was
      recorded into and the path the gateway answered with — a deep link, which
      grants nothing, rather than a meetings-only editor with its own idea of
      conflicts and its own audit trail.
    */
    expect(pushed).toEqual([
      `/console/@${RECORDED_INTO.contextSlug}?note=${encodeURIComponent(record!.session.notePath!)}`,
    ]);

    // And the name, because pressing a thing's name is how people rename it.
    pushed.length = 0;
    press(mounted.container, "meeting-title");
    expect(pushed).toHaveLength(1);
    mounted.unmount();
  });

  test("a meeting with no note to open keeps its name as a heading", async () => {
    /*
      The link needs two facts and neither is guessed: the path is the
      gateway's answer and the context is the destination the recording was
      started with. A meeting that has not been written yet has no path, so
      there is nothing to open — and a heading that is not a control is the
      honest shape for that, rather than a button that goes nowhere.
    */
    const { gateway } = await configure();
    let id = "";
    await act(async () => {
      gateway.offlineFor(50);
      id = await meetings.start({ title: "Not filed yet" });
      meetings.setNotes(id, "something");
      await meetings.end();
    });
    const mounted = mount(createElement(MeetingNoteScreen, { meetingId: id }));
    expect(has(mounted.container, "meeting-edit-note")).toBe(false);
    press(mounted.container, "meeting-title");
    expect(pushed).toEqual([]);
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

