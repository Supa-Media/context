import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { endSession } from "../features/offline/epoch";
import { ownedKeys } from "../features/offline/keys";
import { MeetingsController, findSession, recordElapsedMs } from "../features/meetings/controller";
import { fakeGateway, type FakeGateway } from "../features/meetings/fakeGateway";
import { fakeRecorder, fakeSegment, type FakeRecorder } from "../features/meetings/capture/fake";
import { forgetAllMeetings, loadMeetings } from "../features/meetings/local";
import {
  meetingKey,
  meetingKeys,
  meetingKeysForWorkspace,
  parseMeetingKey,
} from "../features/meetings/keys";
import { isSynced, pendingSteps } from "../features/meetings/record";
import { FINALIZE_TIMEOUT_MS } from "../features/meetings/recovery";

/**
 * A recording, from the press to the note — and everything that can happen to
 * it in between.
 *
 * The controller is deliberately not a hook, so this file drives it directly
 * with no renderer, no timers it does not control, and a store it can inspect.
 * What that buys is the ability to test the cases the product exists for and
 * which are otherwise unreachable: the app being killed mid-meeting, a refused
 * microphone, a sign-out racing a write, a context switch.
 *
 * `persistDebounceMs: 0` throughout, with an explicit tick between the write
 * and the assertion, because the debounce is a real behaviour tested on its own
 * below rather than something every other test should have to wait out.
 *
 * ## The sabotage record
 *
 * Broken on purpose, the whole mobile suite run (3050 tests), and reverted:
 *
 *  - **`start()` stops asking the recorder and writes `transcription: null`**:
 *    1 — **"the session records which engine is about to produce its words"**.
 *    Every meeting this build recorded would then land in the bucket saying
 *    nothing was transcribed, including the ones whose audio was streamed to a
 *    service, and nothing else in the app would have noticed.
 *  - **`transcriptionFor` mapping `nowhere` to `on-device`**: 2 — this file's
 *    **"a build that transcribes nowhere writes a meeting with no engine"** and
 *    `meetingsSession.test.ts`'s own mapping check. That is the pair worth
 *    having: the mapping is tested where it lives *and* through the one caller
 *    that uses it, so deleting either test still leaves the lie caught.
 *  - **`end()`'s `hasNothingCaptured` check removed**: 3 — the owner's own bug
 *    report, closed at the one place the phone can close it before a request
 *    ever leaves the device: **"a session with no transcript and no typed
 *    notes ends as empty, not a note"** and the two reason checks beside it.
 *    Without it a refused microphone finalizes normally, against whichever
 *    gateway this app holds, and writes an empty note.
 *  - **`recoverStaleFinalizes`'s `retry` branch removed**: 2 — the other half
 *    of the same bug report, "stuck on Finalizing for two hours": every stale
 *    sighting skips straight to `retry`'s no-op and a fresh launch's first
 *    sighting is read as already failed, which is the "never fail on the
 *    first sighting" property `checkFinalizeTimeout` exists to hold.
 */

const DEVICE = { platform: "ios" as const, name: "a phone" };

/** A clock a test moves by hand. Elapsed time is arithmetic, not a wait. */
function clockFrom(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Harness {
  controller: MeetingsController;
  store: KeyValueStore;
  gateway: FakeGateway;
  recorder: FakeRecorder;
  clock: ReturnType<typeof clockFrom>;
}

async function harness(
  options: {
    store?: KeyValueStore;
    recorder?: FakeRecorder;
    gateway?: FakeGateway;
    workspaceId?: string;
  } = {},
): Promise<Harness> {
  const controller = new MeetingsController();
  const store = options.store ?? memoryStore();
  const gateway = options.gateway ?? fakeGateway();
  const recorder = options.recorder ?? fakeRecorder();
  const clock = clockFrom(Date.parse("2026-09-05T18:00:00.000Z"));

  await controller.configure({
    workspaceId: options.workspaceId ?? "ws-1",
    store,
    gateway,
    recorder,
    device: DEVICE,
    now: clock.now,
    persistDebounceMs: 0,
  });

  return { controller, store, gateway, recorder, clock };
}

/** Let the debounce timer and the fire-and-forget writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

describe("starting a meeting", () => {
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

describe("the clock is the log, not a timer", () => {
  test("pauses come out of the elapsed time", async () => {
    const { controller, clock } = await harness();
    await controller.start({ title: "Design review" });

    clock.advance(10 * 60_000);
    controller.pause();
    clock.advance(15 * 60_000);
    controller.resume();
    clock.advance(5 * 60_000);

    const live = controller.getSnapshot().live;
    expect(live).not.toBeNull();
    expect(recordElapsedMs(live!, clock.now())).toBe(15 * 60_000);
  });

  test("a paused meeting's clock stands still", async () => {
    const { controller, clock } = await harness();
    await controller.start({ title: "Design review" });
    clock.advance(3 * 60_000);
    controller.pause();

    const paused = controller.getSnapshot().live!;
    expect(recordElapsedMs(paused, clock.now() + 60 * 60_000)).toBe(3 * 60_000);
  });
});

describe("the app being killed mid-meeting", () => {
  test("a relaunch finds the meeting, the notes and the elapsed time", async () => {
    /*
      The whole reason the session log is on disk. Everything below happens with
      the same store and a brand-new controller — which is what a cold launch
      is.
    */
    const store = memoryStore();
    const first = await harness({ store });
    const id = await first.controller.start({ title: "Reboot Camp" });
    first.controller.setNotes(id, "curiosity is the prerequisite");
    first.clock.advance(41 * 60_000);
    await settle();

    const second = await harness({ store });
    const restored = second.controller.getSnapshot().live;

    expect(restored?.session.id).toBe(id);
    expect(restored?.session.notes).toBe("curiosity is the prerequisite");
    expect(restored?.session.state).toBe("recording");
    // 41 minutes, from `startedAt` and the log — a `setInterval` would have
    // died with the process and restarted at zero.
    expect(recordElapsedMs(restored!, first.clock.now())).toBe(41 * 60_000);
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
});

describe("ending a meeting", () => {
  test("the device is released and the note is written", async () => {
    const { controller, recorder, gateway } = await harness();
    const id = await controller.start({ title: "Design review" });
    controller.setNotes(id, "what I typed");
    await controller.end();
    await settle();

    expect(recorder.calls).toContain("stop");
    const record = controller.getSnapshot().records[0];
    expect(record.session.state).toBe("complete");
    expect(record.session.notePath).toBe(`0-inbox/meetings/${id}.md`);
    expect(gateway.held.get(id)?.notes).toBe("what I typed");
  });

  test("the persistent bar comes down the moment End is pressed", async () => {
    // Not when the gateway answers. `finalizing` is not live, so the bar is
    // gone as soon as somebody has finished — waiting on a round trip to take
    // it down would leave a recording indicator over a meeting that is over.
    const offline = fakeGateway();
    offline.offlineFor(50);
    const { controller } = await harness({ gateway: offline });
    await controller.start({ title: "Design review" });
    await controller.end();
    expect(controller.getSnapshot().live).toBeNull();
  });

  test("the microphone is released even when the session refuses to end", async () => {
    /*
      `stop()` is called before any state check. A double press racing itself,
      or a bug in the state machine, must not leave the microphone open — on iOS
      that is a red bar across somebody's status bar after they thought they had
      finished.
    */
    const { controller, recorder } = await harness();
    await controller.start({ title: "Design review" });
    await controller.end();
    const after = recorder.calls.length;
    await controller.end();
    expect(recorder.calls.length).toBe(after + 1);
    expect(recorder.calls[recorder.calls.length - 1]).toBe("stop");
  });

  test("a meeting whose notes never left the device is not drawn as saved", async () => {
    const offline = fakeGateway();
    offline.offlineFor(50);
    const { controller } = await harness({ gateway: offline });
    const id = await controller.start({ title: "On a train" });
    controller.setNotes(id, "typed underground");
    await controller.end();

    const record = controller.getSnapshot().records[0];
    // The gateway holding a session is not the customer's bucket holding a
    // note, and only `notePath` says the second.
    expect(record.session.notePath).toBeNull();
    expect(record.acked.finalized).toBe(false);
  });

  /*
    THE OWNER'S OWN BUG REPORT: four empty notes, one per failed recording
    attempt, "0 min, typed session" with no transcript and no typed notes.
    `end()` checks `hasNothingCaptured` before `sync()` ever runs, so there is
    no request for the gateway to answer and no note for it to write.
  */
  test("a session with no transcript and no typed notes ends as empty, not a note", async () => {
    const { controller, gateway } = await harness();
    const id = await controller.start({ title: "Never really started" });
    await controller.end();
    await settle();

    const record = controller.getSnapshot().records[0];
    expect(record.session.state).toBe("empty");
    expect(record.session.notePath).toBeNull();
    // The session's own metadata still syncs — the gateway is told the meeting
    // exists and is empty — but finalize itself is never asked, because
    // `pendingSteps` does not queue one for a session that is no longer
    // `finalizing`. There is no note for a gateway that was never asked to
    // write one, on either writer this app holds.
    expect(gateway.calls.some((call) => call.includes("finalize"))).toBe(false);
    expect(gateway.held.get(id)?.state).toBe("empty");
  });

  test("the empty reason is the device's own capture problem, when there was one", async () => {
    const recorder = fakeRecorder();
    recorder.refuseStart("The microphone was not granted.");
    const { controller } = await harness({ recorder });
    await controller.start({ title: "Refused microphone" });
    await controller.end();
    await settle();

    const record = controller.getSnapshot().records[0];
    expect(record.session.state).toBe("empty");
    expect(record.session.emptyReason).toBe("The microphone was not granted.");
  });

  test("...and a generic sentence when the device gave no reason at all", async () => {
    const { controller } = await harness();
    await controller.start({ title: "Nothing captured, nothing said" });
    await controller.end();
    await settle();

    const record = controller.getSnapshot().records[0];
    expect(record.session.state).toBe("empty");
    expect(typeof record.session.emptyReason).toBe("string");
    expect(record.session.emptyReason?.length).toBeGreaterThan(0);
  });

  test("typed notes with no audio at all are still a real meeting, not empty", async () => {
    const { controller, gateway } = await harness();
    const id = await controller.start({ title: "Typed only" });
    controller.setNotes(id, "- they said yes");
    await controller.end();
    await settle();

    const record = controller.getSnapshot().records[0];
    expect(record.session.state).toBe("complete");
    expect(record.session.notePath).toBe(`0-inbox/meetings/${id}.md`);
    expect(gateway.held.get(id)?.notes).toBe("- they said yes");
  });

  test("a transcript with no typed notes is still a real meeting too", async () => {
    const { controller, recorder, gateway } = await harness();
    const id = await controller.start({ title: "Audio only" });
    recorder.emit(fakeSegment("s1", 0, "hello"));
    await controller.end();
    await settle();

    const record = controller.getSnapshot().records[0];
    expect(record.session.state).toBe("complete");
    expect(record.session.notePath).toBe(`0-inbox/meetings/${id}.md`);
    expect(gateway.held.get(id)?.transcript?.some((s: { text: string }) => s.text === "hello")).toBe(true);
  });
});

describe("a session stuck finalizing is not left stuck", () => {
  /*
    The other half of the owner's bug report: "a meeting stuck on Finalizing
    for over two hours". `recoverStaleFinalizes` is the glue around
    `checkFinalizeTimeout` (`@context/meetings/recovery`, the pure rule tested
    on its own with a fake clock) — retried once, then failed, never read
    again as "Finalizing" forever.
  */
  test("well within the bound, a stuck finalize is left alone", async () => {
    const gateway = fakeGateway();
    gateway.offlineFor(1000);
    const { controller, clock } = await harness({ gateway });
    const id = await controller.start({ title: "Just ended" });
    controller.setNotes(id, "typed before the gateway went quiet");
    await controller.end();
    await settle();

    clock.advance(FINALIZE_TIMEOUT_MS - 1_000);
    controller.recoverStaleFinalizes(clock.now());

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("finalizing");
    expect(record.retriedAt).toBeUndefined();
  });

  test("at the bound, it is retried once — never failed on the first sighting", async () => {
    const gateway = fakeGateway();
    gateway.offlineFor(1000);
    const { controller, clock } = await harness({ gateway });
    const id = await controller.start({ title: "Stuck for two hours" });
    controller.setNotes(id, "typed before the gateway went quiet");
    await controller.end();
    await settle();

    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("finalizing");
    expect(record.retriedAt).toBe(clock.now());
  });

  test("a full timeout window past that retry, it is failed — not read as Finalizing forever", async () => {
    const gateway = fakeGateway();
    gateway.offlineFor(1000);
    const { controller, clock } = await harness({ gateway });
    const id = await controller.start({ title: "Stuck for two hours" });
    controller.setNotes(id, "typed before the gateway went quiet");
    await controller.end();
    await settle();

    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("failed");
    expect(typeof record.session.failureReason).toBe("string");
    expect(record.session.failureReason?.length).toBeGreaterThan(0);
    // The one thing this may never cost: the human's own words.
    expect(record.session.notes).toBe("typed before the gateway went quiet");
  });

  test("sync() runs the same check on its own schedule, not only on relaunch", async () => {
    const gateway = fakeGateway();
    gateway.offlineFor(1000);
    const { controller, clock } = await harness({ gateway });
    const id = await controller.start({ title: "Stuck for two hours" });
    controller.setNotes(id, "typed before the gateway went quiet");
    await controller.end();
    await settle();

    // Two calls, with the clock moved between them: the first stamps
    // `retriedAt`, and once a full window has passed since that stamp, a
    // later `sync()` on the same schedule is what actually fails it —
    // modelled as two direct calls rather than a real interval, for the same
    // reason the rest of this file drives the controller by hand.
    clock.advance(FINALIZE_TIMEOUT_MS);
    await controller.sync();
    clock.advance(FINALIZE_TIMEOUT_MS);
    await controller.sync();

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("failed");
  });

  test("on the phone's nearest thing to a launch, configure() reads a session already past the bound", async () => {
    const store = memoryStore();
    const gateway = fakeGateway();
    gateway.offlineFor(1000);
    const first = await harness({ store, gateway });
    const id = await first.controller.start({ title: "Left running" });
    first.controller.setNotes(id, "typed before the app was killed");
    await first.controller.end();
    await settle();

    // A fresh controller against the same store, with a clock already past
    // the bound — the phone relaunched into a queue a previous process left
    // in `finalizing`.
    const relaunched = new MeetingsController();
    const laterNow = first.clock.now() + FINALIZE_TIMEOUT_MS;
    await relaunched.configure({
      workspaceId: "ws-1",
      store,
      gateway,
      recorder: fakeRecorder(),
      device: DEVICE,
      now: () => laterNow,
      persistDebounceMs: 0,
    });

    const record = relaunched.getSnapshot().records.find((r) => r.session.id === id)!;
    // Retried, not failed outright: even on a fresh launch, the first
    // sighting past the bound is one more chance before giving up.
    expect(record.session.state).toBe("finalizing");
    expect(record.retriedAt).toBe(laterNow);
  });
});

describe("a meeting recovery gave up on can still be filed", () => {
  /*
    The other half of "retry once, then fail", and the half a failed session is
    worthless without: `pendingSteps` offers a `finalize` only for a session in
    `finalizing`, so once recovery folds `fail` nothing in this app ever sends
    that meeting again on its own. A phone that lost signal for twenty minutes
    after a meeting would otherwise keep somebody's typed words on the device
    permanently, behind a badge that said the meeting failed and no control
    that did anything about it. `retryFinalize` is the `failed -> finalizing`
    the contract has always allowed, at the person's own request.
  */
  async function stuckThenFailed() {
    const gateway = fakeGateway();
    gateway.offlineFor(1000);
    const harnessed = await harness({ gateway });
    const id = await harnessed.controller.start({ title: "Stuck, then given up on" });
    harnessed.controller.setNotes(id, "the words this must not lose");
    await harnessed.controller.end();
    await settle();

    harnessed.clock.advance(FINALIZE_TIMEOUT_MS);
    harnessed.controller.recoverStaleFinalizes(harnessed.clock.now());
    harnessed.clock.advance(FINALIZE_TIMEOUT_MS);
    harnessed.controller.recoverStaleFinalizes(harnessed.clock.now());
    return { ...harnessed, gateway, id };
  }

  test("nothing sends a failed meeting on its own, which is why the person's Retry has to exist", async () => {
    const { controller, id } = await stuckThenFailed();
    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("failed");
    // The proof that this is not "it will go out on the next sync": the queue
    // this record offers has no finalize left in it.
    expect(pendingSteps(record).some((step) => step.kind === "finalize")).toBe(false);
  });

  test("Retry takes it back to finalizing and the meeting lands in the bucket", async () => {
    const { controller, gateway, id } = await stuckThenFailed();
    // The network came back — which is the ordinary case for a meeting that
    // failed because a laptop was in a lift, not because anything was wrong.
    gateway.offlineFor(0);
    await controller.retryFinalize(id);
    await settle();

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("complete");
    expect(record.session.notePath).toBe(`0-inbox/meetings/${id}.md`);
    expect(record.session.failureReason).toBeNull();
    expect(record.session.notes).toBe("the words this must not lose");
    expect(gateway.notesWritten()).toBe(1);
  });

  test("...and the retry gets its own full window rather than being failed on the next tick", async () => {
    const { controller, clock, id } = await stuckThenFailed();
    await controller.retryFinalize(id);
    await settle();

    const reopened = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(reopened.session.state).toBe("finalizing");
    // The retry recovery already spent belonged to the attempt that failed.
    expect(reopened.retriedAt).toBeUndefined();

    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    const afterOneWindow = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(afterOneWindow.session.state).toBe("finalizing");
    expect(afterOneWindow.retriedAt).toBe(clock.now());
  });

  test("the shape the owner actually reported: accepted, never written, and Retry asks again", async () => {
    /*
      A gateway that takes the finalize and never comes back with a path is
      `sync.ts`'s "finalize accepted but no path came back" — a real state
      while an enhancement runs, and the one this bug report was: two hours of
      "Finalizing". The acknowledgement is what stops `pendingSteps` offering
      the step again, so a Retry that did not clear it would be a button that
      does nothing.
    */
    let finalizeCalls = 0;
    const acceptsButNeverWrites = {
      async putSession(_to: unknown, session: { id: string }) {
        return { sessionId: session.id, state: "finalizing", segmentCount: 0, notePath: null, conflictSafe: true };
      },
      async putSegments(_to: unknown, id: string) {
        return { sessionId: id, state: "finalizing", segmentCount: 0, notePath: null, conflictSafe: true };
      },
      async putNotes(_to: unknown, id: string) {
        return { sessionId: id, state: "finalizing", segmentCount: 0, notePath: null, conflictSafe: true };
      },
      async finalize(_to: unknown, session: { id: string }) {
        finalizeCalls += 1;
        return { sessionId: session.id, state: "finalizing", segmentCount: 0, notePath: null, conflictSafe: true };
      },
      async list() {
        return [];
      },
    } as unknown as FakeGateway;

    const { controller, clock } = await harness({ gateway: acceptsButNeverWrites });
    const id = await controller.start({ title: "Finalizing for two hours" });
    controller.setNotes(id, "the decision from the meeting");
    await controller.end();
    await settle();
    const accepted = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(accepted.session.state).toBe("finalizing");
    expect(accepted.acked.finalized).toBe(true);
    expect(pendingSteps(accepted).some((step) => step.kind === "finalize")).toBe(false);

    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    expect(controller.getSnapshot().records.find((r) => r.session.id === id)!.session.state).toBe("failed");

    const before = finalizeCalls;
    await controller.retryFinalize(id);
    await settle();
    expect(finalizeCalls).toBe(before + 1);
    expect(controller.getSnapshot().records.find((r) => r.session.id === id)!.session.notes).toBe(
      "the decision from the meeting",
    );
  });

  test("a meeting nobody failed is not reopened by it", async () => {
    const { controller } = await harness();
    const id = await controller.start({ title: "Perfectly fine" });
    controller.setNotes(id, "typed");
    await controller.end();
    await settle();

    await controller.retryFinalize(id);
    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    // `complete` is terminal and nothing returns from it, least of all this.
    expect(record.session.state).toBe("complete");
  });
});

describe("typing while a transcript arrives", () => {
  test("a segment landing mid-sentence does not touch the notes", async () => {
    const { controller, recorder } = await harness();
    const id = await controller.start({ title: "Design review" });

    controller.setNotes(id, "half a sen");
    recorder.emit(fakeSegment("s1", 0, "somebody said something"));
    controller.setNotes(id, "half a sentence");
    recorder.emit(fakeSegment("s2", 2_000, "and something else"));

    const live = controller.getSnapshot().live;
    expect(live?.session.notes).toBe("half a sentence");
    expect(live?.session.transcript).toHaveLength(2);
  });

  test("typing is written down on a debounce, and ending flushes it", async () => {
    /*
      The asymmetry `features/offline/useOfflineNotes.ts` documents: a keystroke
      is a `JSON.stringify` of the whole record into the store, so typing is
      debounced and anything that *removes* work is written through.
    */
    const store = memoryStore();
    const controller = new MeetingsController();
    const clock = clockFrom(Date.parse("2026-09-05T18:00:00.000Z"));
    await controller.configure({
      workspaceId: "ws-1",
      store,
      gateway: fakeGateway(),
      recorder: fakeRecorder(),
      device: DEVICE,
      now: clock.now,
      persistDebounceMs: 10_000,
    });

    const id = await controller.start({ title: "Design review" });
    await settle();
    controller.setNotes(id, "not written down yet");
    await settle();

    const beforeFlush = await loadMeetings(store, "ws-1");
    expect(beforeFlush.records[0].session.notes).toBe("");

    controller.flush(id);
    await settle();
    const afterFlush = await loadMeetings(store, "ws-1");
    expect(afterFlush.records[0].session.notes).toBe("not written down yet");
  });
});

describe("typing does not become one request per keystroke", () => {
  test("a burst of edits asks for one drain, not forty", async () => {
    /*
      The bug this exists for, found in review rather than in production: the
      app's "something is waiting, send it" effect depends on the records, and
      every keystroke changes them — so a drain fired straight from that effect
      POSTs the notes once per character against the customer's own gateway.

      `requestSync` is a **throttle** and not a debounce, which is the other
      half: a debounce would reset on each keystroke, so somebody typing
      steadily for forty minutes would sync nothing at all until they stopped.
    */
    const gateway = fakeGateway();
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws-1",
      store: memoryStore(),
      gateway,
      recorder: fakeRecorder(),
      device: DEVICE,
      persistDebounceMs: 0,
      syncThrottleMs: 5,
    });

    const id = await controller.start({ title: "Design review" });
    for (const text of ["c", "cu", "cur", "curi", "curio", "curios"]) {
      controller.setNotes(id, text);
      controller.requestSync();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));

    // One drain: metadata, then the *last* text. Not six of anything.
    expect(gateway.calls).toEqual(["session", "notes"]);
    expect(gateway.held.get(id)?.notes).toBe("curios");
  });

  test("a request made while a drain is scheduled rides along with it", async () => {
    const gateway = fakeGateway();
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws-1",
      store: memoryStore(),
      gateway,
      recorder: fakeRecorder(),
      device: DEVICE,
      persistDebounceMs: 0,
      syncThrottleMs: 5,
    });
    const id = await controller.start({ title: "Design review" });

    controller.requestSync();
    controller.requestSync();
    controller.requestSync();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(gateway.calls).toEqual(["session"]);

    // And the window reopens afterwards, rather than the throttle latching shut.
    controller.setNotes(id, "later");
    controller.requestSync();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(gateway.calls).toEqual(["session", "notes"]);
  });
});

describe("the device's own keys", () => {
  test("a meeting is not filed under the offline cache's namespace", async () => {
    /*
      Deliberate, and the reason is data loss rather than tidiness: `sweep()`
      deletes every key under `context.lc.offline` whose version segment it does
      not recognise, on the first mount after an upgrade — and a meeting that
      has not reached the bucket is somebody's typing, not a disposable copy.
    */
    const { controller, store } = await harness();
    await controller.start({ title: "Design review" });
    await settle();

    const keys = await store.keys();
    expect(meetingKeys(keys)).toHaveLength(1);
    expect(ownedKeys(keys)).toHaveLength(0);
  });

  /*
    The "PINNED GAP" test that stood here asserted that sign-out did *not*
    clear this namespace, and carried an instruction: when it fails, the
    function has learned about meetings, so replace it with the opposite
    assertion. It has, so it is gone from here rather than inverted in place —
    `forgetLocalCopies` opens its own store, which this harness does not
    supply, so a test driving it belongs where that store is mocked.
    `__tests__/offlineForget.test.ts` holds both halves now: the meeting and
    the remembered destination.
  */

  test("discarding the meeting that is running releases the microphone", async () => {
    // Without this the device stays open with nothing left to record into —
    // on iOS, a red bar over an app that has forgotten why.
    const { controller, recorder, store } = await harness();
    const id = await controller.start({ title: "Started by mistake" });
    await settle();

    await controller.discard(id);
    expect(recorder.calls).toContain("stop");
    expect(controller.getSnapshot().live).toBeNull();
    expect(meetingKeys(await store.keys())).toHaveLength(0);
  });

  test("a write racing sign-out is dropped rather than landing after the clear", async () => {
    /*
      The measured failure `features/offline/epoch.ts` exists for, applied to a
      recording: the writes are fire-and-forget, sign-out is a `remove()` loop,
      and without the barrier somebody's private notes come back onto the device
      *after* the clear said they were gone.
    */
    const { controller, store } = await harness();
    const id = await controller.start({ title: "Private meeting" });
    await settle();

    endSession();
    await forgetAllMeetings(store);
    controller.setNotes(id, "typed as the session ended");
    controller.flush(id);
    await settle();

    expect(meetingKeys(await store.keys())).toHaveLength(0);
  });

  test("a context's meetings can be found by that context alone", async () => {
    // What "forget the context I just left" would need, and the reason it is a
    // function rather than a filter written out at the call site: two copies of
    // "which keys is this about" is how a clear reports success over records it
    // never looked at (`keysForWorkspace` in `features/offline/keys.ts`).
    const { controller, store } = await harness({ workspaceId: "ws-left" });
    await controller.start({ title: "A context I left" });
    await settle();

    const keys = await store.keys();
    expect(meetingKeysForWorkspace(keys, "ws-left")).toHaveLength(1);
    expect(meetingKeysForWorkspace(keys, "ws-other")).toHaveLength(0);
  });

  test("one context's meetings are invisible to another", async () => {
    // Non-negotiable #4 at the smallest scale there is: two contexts on one
    // device, and the second must not enumerate the first.
    const store = memoryStore();
    const mine = await harness({ store, workspaceId: "ws-mine" });
    await mine.controller.start({ title: "Mine" });
    await settle();

    const theirs = await harness({ store, workspaceId: "ws-theirs" });
    expect(theirs.controller.getSnapshot().records).toHaveLength(0);
    expect(theirs.controller.getSnapshot().unreadable).toBe(0);
  });
});

describe("a device that will not keep anything", () => {
  test("the promise is downgraded rather than made anyway", async () => {
    /*
      `memoryStore()` answers `durable: false` — a browser in Private Browsing,
      a webview that refused site data. The meeting still runs and still syncs;
      what changes is what the app is allowed to claim, which `copy.ts`'s rule
      says has to be said rather than hidden.
    */
    const { controller } = await harness({ store: memoryStore() });
    const snapshot = controller.getSnapshot();
    expect(snapshot.durable).toBe(false);
    expect(snapshot.durabilityReason).toContain("will not keep");
  });
});

describe("the snapshot is a store React can subscribe to", () => {
  test("it is stable between changes, which is what stops a render loop", async () => {
    // `useSyncExternalStore` requires it: a fresh object per call is an
    // infinite loop, and it is the single easiest way to break an external
    // store.
    const { controller } = await harness();
    expect(controller.getSnapshot()).toBe(controller.getSnapshot());
    await controller.start({ title: "Design review" });
    const after = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(after);
  });

  test("subscribers hear about a recording starting, and stop hearing when they leave", async () => {
    const { controller } = await harness();
    let heard = 0;
    const unsubscribe = controller.subscribe(() => {
      heard += 1;
    });
    await controller.start({ title: "Design review" });
    expect(heard).toBeGreaterThan(0);

    unsubscribe();
    const quiet = heard;
    controller.pause();
    expect(heard).toBe(quiet);
  });

  test("a refused move changes nothing at all, not even identity", async () => {
    // `applyMeetingEvent` returns the same object for a refusal and the
    // controller compares by identity, so an illegal move costs no render.
    const { controller } = await harness();
    await controller.start({ title: "Design review" });
    await controller.end();
    await settle();

    const before = controller.getSnapshot();
    controller.pause();
    expect(controller.getSnapshot()).toBe(before);
  });
});
