import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { endSession } from "../../features/offline/epoch";
import { ownedKeys } from "../../features/offline/keys";
import { fakeSegment } from "../../features/meetings/capture/fake";
import { forgetAllMeetings, loadMeetings } from "../../features/meetings/local";
import { meetingKeys, meetingKeysForWorkspace } from "../../features/meetings/keys";
import {
  DEVICE,
  MeetingsController,
  clockFrom,
  fakeGateway,
  fakeRecorder,
  harness,
  memoryStore,
  settle,
} from "./fixtures";

/**
 * Typing while a transcript arrives, typing not becoming one request per
 * keystroke, the device's own keys, a device that will not keep anything, and
 * the snapshot as a store React can subscribe to. See `fixtures.ts` for the
 * controller harness and the sabotage record that proves it.
 */

afterEach(() => {
  jest.useRealTimers();
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
    await controller.pause();
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
    await controller.pause();
    expect(controller.getSnapshot()).toBe(before);
  });
});
