import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { endSession } from "../features/offline/epoch";
import { ownedKeys } from "../features/offline/keys";
import { forgetEverything } from "../features/offline/cache";
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
import { isSynced } from "../features/meetings/record";

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

  test("PINNED GAP: sign-out does not clear meetings yet", async () => {
    /*
      `forgetEverything` walks `ownedKeys`, which is the offline namespace, and
      `forgetLocalCopies` additionally clears `console/lastPlace.ts`'s keys by
      name — the precedent for a feature with its own namespace being *named* in
      that function rather than swept up by accident.

      Meetings need the same one line, and until it exists a signed-out device
      keeps meeting notes. This test asserts the gap so it is a red line in a
      suite rather than a comment nobody reads.

      **When this fails**: `forgetLocalCopies` has learned about meetings. Good.
      Delete this test and replace it with the opposite assertion — that
      `forgetAllMeetings` ran and the keys are gone.
    */
    const { controller, store } = await harness();
    await controller.start({ title: "Private meeting" });
    await settle();

    await forgetEverything(store);
    expect(meetingKeys(await store.keys())).toHaveLength(1);

    // What the missing line would do, exported and ready for it.
    await forgetAllMeetings(store);
    expect(meetingKeys(await store.keys())).toHaveLength(0);
  });

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
