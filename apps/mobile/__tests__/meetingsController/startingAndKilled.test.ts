import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { findSession, recordElapsedMs } from "../../features/meetings/controller";
import { fakeSegment } from "../../features/meetings/capture/fake";
import { meetingKey, parseMeetingKey } from "../../features/meetings/keys";
import { isSynced } from "../../features/meetings/record";
import {
  DEVICE,
  fakeActivity,
  fakeGateway,
  fakeRecorder,
  harness,
  memoryStore,
  settle,
  type KeyValueStore,
} from "./fixtures";

/**
 * Starting a meeting, what a caller who says nothing gets, the clock as the
 * log rather than a timer, and the app being killed mid-meeting. See
 * `fixtures.ts` for the controller harness and the sabotage record that
 * proves it.
 */

afterEach(() => {
  jest.useRealTimers();
});

describe("starting a meeting", () => {
  test("system recording UI follows recorder truth through start, pause, resume and end", async () => {
    const activity = fakeActivity();
    const { controller, recorder, clock } = await harness({ activity });
    const id = await controller.start({ title: "Design review" });
    expect(activity.update).toHaveBeenLastCalledWith(expect.objectContaining({
      meetingId: id, phase: "recording", title: "Design review",
    }));

    clock.advance(4_000);
    await controller.pause();
    expect(recorder.state).toBe("paused");
    expect(activity.update).toHaveBeenLastCalledWith(expect.objectContaining({
      phase: "paused", recordedMs: 4_000, recordingSince: null,
    }));

    await controller.resume();
    expect(recorder.state).toBe("recording");
    expect(activity.update).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "recording" }));
    await controller.end();
    expect(activity.end).toHaveBeenCalledWith(id);
  });

  test("lock-screen controls require the current one-use capability and rotate after state changes", async () => {
    const activity = fakeActivity();
    const first = "11".repeat(32);
    const second = "22".repeat(32);
    const tokens = [first, second];
    const { controller } = await harness({ activity, activityToken: () => tokens.shift()! });
    const id = await controller.start({ title: "Security review" });

    expect(activity.update).toHaveBeenLastCalledWith(expect.objectContaining({ controlToken: first }));
    expect(controller.consumeActivityControl(id, "ff".repeat(32))).toBe(false);
    expect(controller.consumeActivityControl("mtg_someone_else", first)).toBe(false);
    expect(controller.consumeActivityControl(id, first)).toBe(true);
    expect(controller.consumeActivityControl(id, first)).toBe(false);

    await controller.pause();
    expect(activity.update).toHaveBeenLastCalledWith(expect.objectContaining({ controlToken: second }));
    expect(controller.consumeActivityControl(id, first)).toBe(false);
    expect(controller.consumeActivityControl(id, second)).toBe(true);
  });

  test("refused and background-downgraded capture never leaves a Live Activity", async () => {
    const activity = fakeActivity();
    const recorder = fakeRecorder();
    recorder.refuseStart("no microphone");
    const refused = await harness({ activity, recorder });
    await refused.controller.start({ title: "Refused" });
    expect(activity.update).not.toHaveBeenCalled();

    const downgradedActivity = fakeActivity();
    const downgraded = await harness({ activity: downgradedActivity });
    const id = await downgraded.controller.start({ title: "Started" });
    downgraded.recorder.fail({
      recoverable: true,
      kind: "background-unavailable",
      message: "foreground only",
    });
    expect(downgradedActivity.end).toHaveBeenCalledWith(id);
  });

  test("the notepad exists before the microphone does", async () => {
    /*
      The order this test exists for: the record is created and written down
      *before* the recorder is asked to start, so a refused permission leaves a
      real session somebody can type into rather than nothing at all. The
      reference experience is a notepad first; a denied microphone must not cost
      somebody their notes.
    */
    const recorder = fakeRecorder();
    recorder.refuseStart("Context needs permission to use the microphone.");
    const { controller } = await harness({ recorder });

    const id = await controller.start({ title: "Design review" });
    const snapshot = controller.getSnapshot();

    expect(snapshot.live?.session.id).toBe(id);
    expect(snapshot.live?.session.state).toBe("recording");
    /*
      The refusal is on the *snapshot*, not on the session, and that is a
      decision rather than a detail. A denied microphone is a fact about this
      phone: it does not belong in the note that lands in somebody's bucket, and
      it cannot live in `failureReason`, because the reducer clears that on the
      `failed -> recording` move that a first version of this used to make the
      session pass through.
    */
    expect(snapshot.live?.session.failureReason).toBeNull();
    expect(snapshot.captureError).toBe("Context needs permission to use the microphone.");
  });

  test("the session records which engine is about to produce its words", async () => {
    /*
      The note this meeting becomes has to say how it was made, and the only
      moment anything knows is this one: the recorder this build has is the
      thing that knows where the audio is going, and the session is built once.
      A field filled in later, at finalize, would be guessing from the outside
      at what the recorder was doing.
    */
    const { controller } = await harness({ recorder: fakeRecorder({ transcribesAt: "cloud" }) });
    const id = await controller.start({ title: "Design review" });

    expect(controller.getSnapshot().live?.session.transcription).toBe("cloud");
    expect(findSession(controller.getSnapshot(), id)?.transcription).toBe("cloud");
  });

  test("a build that transcribes nowhere writes a meeting with no engine, not a missing field", async () => {
    /*
      Android today, and any browser that cannot record: a notes-only session is
      a real and useful product, and its note says `transcription: none` rather
      than saying nothing — which a reader could not tell from an old note.
    */
    const { controller } = await harness({
      recorder: fakeRecorder({ audio: false, transcribesAt: "nowhere" }),
    });
    await controller.start({ title: "Design review" });

    const session = controller.getSnapshot().live?.session;
    expect(session?.transcription).toBeNull();
    expect(session !== undefined && "transcription" in session).toBe(true);
  });

  test("a recorder that dies mid-meeting leaves a session you can still type into", async () => {
    const { controller, recorder } = await harness();
    const id = await controller.start({ title: "Design review" });

    recorder.fail({ recoverable: false, message: "The microphone was taken by a call." });
    controller.setNotes(id, "kept typing anyway");

    const snapshot = controller.getSnapshot();
    expect(snapshot.live?.session.state).toBe("recording");
    expect(snapshot.live?.session.notes).toBe("kept typing anyway");
    // Said out loud rather than swallowed: somebody who pressed record is
    // entitled to know nothing is being captured, during rather than after.
    expect(snapshot.captureError).toBe("The microphone was taken by a call.");
  });

  test("a foreground-only warning survives later capture notices", async () => {
    const { controller, recorder } = await harness();
    await controller.start({ title: "Design review" });
    const warning =
      "Recording works while Context stays open, but locking your phone will stop the audio.";

    recorder.fail({ recoverable: true, kind: "background-unavailable", message: warning });

    for (const message of [
      "No speech was heard in the last stretch of audio, so nothing was transcribed from it. Capture is still running.",
      "Transcription is running behind, so a few seconds of audio were dropped. Capture is still running.",
      "Something else took the microphone. Typing still works, and capture picks up when it is free.",
    ]) {
      recorder.fail({ recoverable: true, message });
      expect(controller.getSnapshot().captureError).toBe(message);
      expect(controller.getSnapshot().backgroundCaptureWarning).toBe(warning);
    }
  });

  test("the id is the protocol's, and the meeting is filed under this context", async () => {
    const { controller, store } = await harness();
    const id = await controller.start({ title: "Design review" });
    await settle();

    expect(id).toMatch(/^mtg_[0-9a-hjkmnp-tv-z]{20}$/);
    expect(parseMeetingKey(meetingKey("ws-1", id))).toEqual({
      workspaceId: "ws-1",
      meetingId: id,
    });
    expect(await store.get(meetingKey("ws-1", id))).not.toBeNull();
  });
});

/**
 * A CAPABILITY WITH A CONSENT STEP IS OPTED INTO, NEVER DEFAULTED INTO.
 *
 * `start()`'s fallback for a caller that says nothing about system audio is
 * "whatever this build can do" — which was right while the only build that
 * could do it was the desktop shell, whose loopback tap is silent. A browser
 * can also do it, and doing it there means opening a screen-share picker.
 * Falling back to the capability alone would put that picker in front of any
 * caller that starts a meeting without going through the sheet, on behalf of
 * somebody who was never asked.
 *
 * So the fallback is "whatever this build can do **without asking again**", and
 * these two checks are the difference. The sheet still decides for itself; this
 * is about every other way a meeting can start.
 */
describe("what a caller who says nothing gets", () => {
  test("a silent tap is taken", async () => {
    const recorder = fakeRecorder({ systemAudio: true, systemAudioNeedsPicker: false });
    const { controller } = await harness({ recorder });
    await controller.start({ title: "Standup" });
    expect(recorder.startedWith?.systemAudio).toBe(true);
  });

  test("a picker is not opened on somebody's behalf", async () => {
    const recorder = fakeRecorder({ systemAudio: true, systemAudioNeedsPicker: true });
    const { controller } = await harness({ recorder });
    await controller.start({ title: "Standup" });
    expect(recorder.startedWith?.systemAudio).toBe(false);
  });

  test("...and a caller who does say still decides", async () => {
    const recorder = fakeRecorder({ systemAudio: true, systemAudioNeedsPicker: true });
    const { controller } = await harness({ recorder });
    await controller.start({ title: "Standup", systemAudio: true });
    expect(recorder.startedWith?.systemAudio).toBe(true);
  });
});

describe("the clock is the log, not a timer", () => {
  test("pauses come out of the elapsed time", async () => {
    const { controller, clock } = await harness();
    await controller.start({ title: "Design review" });

    clock.advance(10 * 60_000);
    await controller.pause();
    clock.advance(15 * 60_000);
    await controller.resume();
    clock.advance(5 * 60_000);

    const live = controller.getSnapshot().live;
    expect(live).not.toBeNull();
    expect(recordElapsedMs(live!, clock.now())).toBe(15 * 60_000);
  });

  test("a paused meeting's clock stands still", async () => {
    const { controller, clock } = await harness();
    await controller.start({ title: "Design review" });
    clock.advance(3 * 60_000);
    await controller.pause();

    const paused = controller.getSnapshot().live!;
    expect(recordElapsedMs(paused, clock.now() + 60 * 60_000)).toBe(3 * 60_000);
  });
});

describe("the app being killed mid-meeting", () => {
  test("a relaunch never resumes a running timer — it fails, closed, with what was captured", async () => {
    /*
      The whole reason the session log is on disk. Everything below happens with
      the same store and a brand-new controller — which is what a cold launch
      is.

      This test used to assert the opposite of what it does now: that
      `restored.session.state` came back `"recording"` and that
      `recordElapsedMs` kept counting from `startedAt` across the relaunch —
      the zombie-recording defect. A fresh controller's fresh `fakeRecorder` is
      never told to `start()` again here, exactly like a real relaunch, so a
      session that came back `"recording"` was never backed by anything: the
      defect was passing precisely because this test expected it to.
    */
    const store = memoryStore();
    const first = await harness({ store });
    const id = await first.controller.start({ title: "Reboot Camp" });
    first.controller.setNotes(id, "curiosity is the prerequisite");
    first.clock.advance(41 * 60_000);
    await settle();

    // The relaunch happens at whatever moment it actually happens — a fresh
    // process's clock does not rewind to the meeting's own start.
    const second = await harness({ store, startAt: first.clock.now() });
    // No live recording claims to exist — the bar this would have driven is
    // gone, not frozen mid-count.
    expect(second.controller.getSnapshot().live).toBeNull();

    const restored = second.controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(restored.session.notes).toBe("curiosity is the prerequisite");
    // Closed and on its way, rather than parked behind a Retry — see the
    // owner's rule quoted in `what was captured survives` below.
    expect(restored.session.state).toBe("finalizing");
    expect(restored.interrupted).toBe(true);
    // 41 minutes — exactly what was captured before the restart — and it does
    // not move no matter how much wall clock passes after it.
    expect(recordElapsedMs(restored, first.clock.now())).toBe(41 * 60_000);
    expect(recordElapsedMs(restored, first.clock.now() + 60 * 60_000)).toBe(41 * 60_000);
  });

  test("what was captured survives, and a real Retry reaches a finished note", async () => {
    const store = memoryStore();
    const first = await harness({ store });
    const id = await first.controller.start({ title: "Reboot Camp" });
    first.recorder.emit(fakeSegment("seg-1", 0, "curiosity is the prerequisite"));
    first.clock.advance(5 * 60_000);
    await settle();

    const second = await harness({ store, startAt: first.clock.now() });
    const restored = second.controller.getSnapshot().records.find((r) => r.session.id === id)!;
    /*
      CHANGED, AND THE OWNER CHANGED IT: *"if a meeting ever stops it should
      IMMEDIATELY be saved, no button press needed"*.

      This used to fold `fail`, on the argument that "finalizing it
      automatically, unasked, would write a note the person never agreed was
      over — a meeting that was merely interrupted by a restart may well
      continue". Both halves of that turned out to cost more than they saved.
      A note is editable, movable and deletable the moment it lands; a meeting
      parked on the device behind a Retry nobody knew to press is reachable by
      nothing, which is the failure actually reported. And "may well continue"
      is answered by resuming the meeting, not by withholding the note.

      So the move is `end`, which is the same event the button pressed, and
      the ordinary queue takes it from there.
    */
    expect(restored.session.state).toBe("finalizing");
    // The transcript captured before the restart is not discarded.
    expect(restored.session.transcript).toHaveLength(1);
    // Client-local, so the app can say the recording was cut short without
    // writing that claim into the customer's own file.
    expect(restored.interrupted).toBe(true);

    await second.controller.sync();
    await settle();

    const finished = second.controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(finished.session.state).toBe("complete");
    expect(finished.session.notePath).toBe(`0-inbox/meetings/${id}.md`);
    expect(second.gateway.notesWritten()).toBe(1);
    // Nobody pressed anything.
    expect(finished.interrupted).toBe(true);
  });

  test("a paused meeting is reconciled the same way as a recording one", async () => {
    const store = memoryStore();
    const first = await harness({ store });
    const id = await first.controller.start({ title: "Design review" });
    // Something captured, so this test is exercising the "recording vs.
    // paused" question rather than the "nothing captured" one covered above.
    first.controller.setNotes(id, "agenda: the review");
    first.clock.advance(2 * 60_000);
    await first.controller.pause();
    await settle();

    const second = await harness({ store, startAt: first.clock.now() });
    const restored = second.controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(restored.session.state).toBe("finalizing");
    // The clock still stops where the recording did, which is the half of the
    // old `fail` that was never about failing: an open interval climbing from
    // a `startedAt` in the past is the zombie this closes.
    expect(recordElapsedMs(restored, second.clock.now())).toBe(2 * 60_000);
  });

  /*
    THE HARDWARE CASE THIS SECTION WAS NAMED FOR: a recording killed within
    seconds, before anything at all was captured. "Interrupted, retry it" is
    the wrong sentence for this one — there is no "rest of this meeting" a
    Retry could ever find, and `INTERRUPTED_RECORDING_REASON` saying "what was
    recorded is kept below" would be false about a session with nothing in it.
    `end()` already tells this apart with `hasNothingCaptured`; this is the
    same rule reaching the one caller of `fail` that had not been taught it.
  */
  test("a recording killed within seconds — nothing captured — is empty, not failed", async () => {
    const store = memoryStore();
    const first = await harness({ store });
    const id = await first.controller.start({ title: "Killed instantly" });
    first.clock.advance(2_000);
    await settle();

    const second = await harness({ store, startAt: first.clock.now() });
    const restored = second.controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(restored.session.state).toBe("empty");
    expect(restored.session.emptyReason).toMatch(/restarted before anything was captured/i);
    expect(restored.session.failureReason).toBeNull();

    // Nothing to retry: `failed -> finalizing` is the only route `retryFinalize`
    // takes, and this session never enters `failed` at all, so pressing it is
    // a no-op rather than a Retry that could never succeed.
    await second.controller.retryFinalize(id);
    expect(
      second.controller.getSnapshot().records.find((r) => r.session.id === id)!.session.state,
    ).toBe("empty");
  });

  test("a meeting that ended cleanly is untouched by the reconciliation", async () => {
    const store = memoryStore();
    const offline = fakeGateway();
    offline.offlineFor(50);
    const first = await harness({ store, gateway: offline });
    const id = await first.controller.start({ title: "Wrapped up" });
    first.controller.setNotes(id, "wrapped up on time");
    await first.controller.end();
    await settle();

    const second = await harness({ store });
    const restored = second.controller.getSnapshot().records.find((r) => r.session.id === id);
    // `end()` moves to `finalizing`, not `failed` — a session mid-finalize on
    // a genuine relaunch is `recoverStaleFinalizes`'s question, not this one's,
    // and only after the bound in `checkFinalizeTimeout` has actually passed.
    expect(restored?.session.state).toBe("finalizing");
  });

  test("staying on the same workspace never fails a meeting that really is recording", async () => {
    // The fast path in `configure()`: reconfiguring for the *same* workspace
    // keeps the live recorder rather than reading a fresh one off the store,
    // and must never run the reconciliation this describe block is about —
    // that would fail every recording in the app the moment a screen remounts.
    const { controller, recorder } = await harness();
    const id = await controller.start({ title: "Still going" });

    await controller.configure({
      workspaceId: "ws-1",
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder: fakeRecorder(),
      device: DEVICE,
    });

    const live = controller.getSnapshot().live;
    expect(live?.session.id).toBe(id);
    expect(live?.session.state).toBe("recording");
    expect(recorder.calls).not.toContain("stop");
  });

  test("a meeting that never reached the gateway is still waiting after a relaunch", async () => {
    const store = memoryStore();
    const offline = fakeGateway();
    offline.offlineFor(50);

    const first = await harness({ store, gateway: offline });
    const id = await first.controller.start({ title: "On a train" });
    first.controller.setNotes(id, "typed underground");
    await first.controller.end();
    await settle();

    const second = await harness({ store });
    const record = second.controller.getSnapshot().records[0];
    expect(record.session.notes).toBe("typed underground");
    expect(isSynced(record)).toBe(false);
    expect(record.session.notePath).toBeNull();
  });

  test("a record another version wrote is counted, not silently dropped", async () => {
    const store = memoryStore();
    await store.set(meetingKey("ws-1", "mtg_aaaaaaaaaaaaaaaaaaaa"), JSON.stringify({ version: 99 }));
    const { controller } = await harness({ store });
    // Over-warning costs a sentence on a list screen; under-warning costs
    // somebody a meeting with nothing anywhere saying it existed.
    expect(controller.getSnapshot().unreadable).toBe(1);
  });

  test("a store that cannot be listed leaves the screen usable rather than loading forever", async () => {
    /*
      `loadMeetings` is the one caller of `keys()` in this app that is a read
      rather than a clear, and it is the only one that must absorb a listing
      failure instead of reporting it.

      The port lets a failed listing reject on both real stores, because every
      other caller is a *clear* and a clear that reads an empty listing as
      "done" claims to have emptied a device it could not look at. Here the
      opposite stance is right, and the reason is this assertion: `configure()`
      is awaited from an effect in `useMeetings` that holds no `catch`, so a
      rejection would leave `status` at `loading` for the life of the screen and
      take the notepad — which needs no storage at all — down with the list.

      `unreadable` stays 0 rather than being inflated: nothing was read, so
      there is no count to report, and a number nobody could measure is the one
      thing this feature does not print.
    */
    const store: KeyValueStore = {
      ...memoryStore(),
      keys: async () => {
        throw new Error("database disk image is malformed");
      },
    };

    const { controller } = await harness({ store });

    expect(controller.getSnapshot().status).toBe("ready");
    expect(controller.getSnapshot().records).toEqual([]);
    expect(controller.getSnapshot().unreadable).toBe(0);

    // And the feature still works: a meeting started after an unreadable launch
    // is a meeting, not a screen that refuses.
    const id = await controller.start({ title: "After a bad launch" });
    expect(controller.getSnapshot().records.some((record) => record.session.id === id)).toBe(true);
  });
});

