import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { fakeSegment } from "../../features/meetings/capture/fake";
import { pendingSteps } from "../../features/meetings/record";
import { DEVICE, fakeGateway, fakeRecorder, harness, settle } from "./fixtures";

/**
 * Ending a meeting, words belonging to the meeting that produced them, and
 * the leak at every shape the recorder actually outlives a meeting in. See
 * `fixtures.ts` for the controller harness and the sabotage record that
 * proves it.
 */

afterEach(() => {
  jest.useRealTimers();
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

describe("words belong to the meeting that produced them", () => {
  /*
    THE DEFECT, AND IT PUT ONE MEETING'S TRANSCRIPT IN ANOTHER MEETING'S WRITE.

    `listenToRecorder` subscribes a handler closing over the meeting id, and
    nothing detached the previous meeting's. After two meetings the recorder had
    two subscribers; after seven it had seven, and every segment of the meeting
    being recorded now was folded into the record of every meeting recorded
    before it in this process.

    Measured on the owner's Mac across one evening: eight finished meetings,
    eight `segments` writes each carrying words from *later* meetings, all
    refused 400 because the sessions they named were already complete at the
    gateway. The refusal is the only reason those words did not reach a note —
    a meeting whose finalize had not drained yet would have taken them.

    Both halves are checked, because either alone is green with the bug in
    place: the old meeting must not gain the new words, and the new meeting must
    still get them.
  */
  test("a second meeting's words do not land on the first meeting's record", async () => {
    const { controller, recorder } = await harness();

    const first = await controller.start({ title: "One" });
    recorder.emit(fakeSegment(`${first}-mic-0-s000`, 0, "said in the first meeting"));
    await controller.end();
    await settle();

    const second = await controller.start({ title: "Two" });
    recorder.emit(fakeSegment(`${second}-mic-0-s000`, 0, "said in the second meeting"));
    await settle();

    const one = controller.getSnapshot().records.find((r) => r.session.id === first)!;
    const two = controller.getSnapshot().records.find((r) => r.session.id === second)!;
    expect(one.session.transcript.map((s) => s.id)).toEqual([`${first}-mic-0-s000`]);
    expect(two.session.transcript.map((s) => s.id)).toEqual([`${second}-mic-0-s000`]);
  });

  test("a stale recorder subscription is detached, not merely out-voted", async () => {
    /*
      Asserted on the recorder rather than on the records, so the check is about
      the subscription itself. A fix that filtered misaddressed segments while
      leaving the handler attached would pass the test above and still leak one
      closure per meeting for the life of the process.
    */
    const { controller, recorder } = await harness();
    await controller.start({ title: "One" });
    await controller.end();
    await settle();
    await controller.start({ title: "Two" });
    await settle();

    // One handler for the meeting that is live, and no handler for the one that
    // finished. Two here is the defect exactly: the previous meeting's closure,
    // still attached, still folding.
    expect(recorder.segmentSubscribers).toBe(1);

    const id = controller.getSnapshot().live!.session.id;
    recorder.emit(fakeSegment(`${id}-mic-0-s000`, 0, "one delivery"));
    expect(controller.getSnapshot().live!.session.transcript).toHaveLength(1);
  });

  test("the error subscription is detached with the segment one", async () => {
    /*
      It leaked identically and was worth fixing for a different reason: an
      error handler per meeting sets `captureError` once per meeting ever
      started, so a single refused microphone was written to the snapshot five
      times on the fifth meeting of a session. Harmless today only because they
      all write the same string.
    */
    const { controller, recorder } = await harness();
    await controller.start({ title: "One" });
    await controller.end();
    await settle();
    await controller.start({ title: "Two" });
    await settle();

    expect(recorder.errorSubscribers).toBe(1);
  });

  test("a finished meeting's projection refuses transcript outright", async () => {
    /*
      The second answer, independent of who is sending. `applyMeetingEvent`'s
      `segment` case consulted no state at all, unlike `start`/`pause`/`end`
      beside it — so a `complete` session folded words that `pendingSteps` then
      offered forever as unsent, against a gateway that answers 400 for a
      session that is already a note. Driven through `apply` directly, because
      the whole point is that it holds whatever routed the event.
    */
    const { controller } = await harness();
    const id = await controller.start({ title: "Finished" });
    controller.setNotes(id, "typed");
    await controller.end();
    await settle();

    const done = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(done.session.state).toBe("complete");

    controller.apply(id, { type: "segment", segment: fakeSegment(`${id}-mic-9-s000`, 0, "too late") });
    await settle();

    const after = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(after.session.transcript).toHaveLength(0);
    // No `segments` step, which is the one that would be posted to a session
    // the gateway has already turned into a note and would answer 400 for.
    expect(pendingSteps(after).filter((step) => step.kind === "segments")).toHaveLength(0);
  });

  test("a segment minted for another meeting is refused rather than folded", async () => {
    /*
      The guard, independent of the fix above: `apply` is handed a segment whose
      id names a different meeting, exactly as the leaked handler used to hand
      it one, and the record does not take it. This is what makes a future
      version of the same mistake visible instead of a silently contaminated
      note — `foreignSegmentSessions` in the contract is the shared rule and the
      gateway refuses the same shape at its own door.
    */
    const { controller } = await harness();
    const mine = await controller.start({ title: "Mine" });
    const somebodyElses = "mtg_00000000000000000000";

    controller.apply(mine, {
      type: "segment",
      segment: fakeSegment(`${somebodyElses}-mic-0-s000`, 0, "spoken in another room"),
    });
    await settle();

    expect(controller.getSnapshot().live!.session.transcript).toHaveLength(0);
  });

  test("a segment id that names no meeting is still taken", async () => {
    /*
      The phone's own recorders key their chunks on `String(Date.now())`, so
      their ids name no meeting at all. Unaddressed is not misaddressed: a guard
      on somebody's transcript may only fail in the direction of accepting what
      it cannot prove wrong, or it silently stops taking words the day a
      recorder changes how it mints ids.
    */
    const { controller } = await harness();
    await controller.start({ title: "From a phone" });
    const id = controller.getSnapshot().live!.session.id;

    controller.apply(id, { type: "segment", segment: fakeSegment("1757280000000-0-s000", 0, "hello") });
    await settle();

    expect(controller.getSnapshot().live!.session.transcript).toHaveLength(1);
  });
});

describe("the leak, at every shape the recorder actually outlives a meeting in", () => {
  /*
    ADVERSARIAL REVIEW OF THE FIX ABOVE.

    The block above proves the two-meeting case, which is the one that was
    measured. `retainedRecorder` exists precisely because the recorder outlives
    more than that: a meeting can be discarded rather than ended, a screen can
    remount and hand a fresh recorder in, and two meetings can be started
    without an `end()` between them. Each of those is a separate path to "the
    handler for meeting N is still attached", and a fix that closed only the
    `end()` path would be green on everything above.

    Every case here fails with `detachRecorder` removed from the path it names,
    which is what makes them checks rather than restatements.
  */

  test("three meetings in a row, and each holds only its own words", async () => {
    const { controller, recorder } = await harness();
    const ids: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      const id = await controller.start({ title });
      ids.push(id);
      recorder.emit(fakeSegment(`${id}-mic-0-s000`, 0, `said in ${title}`));
      await controller.end();
      await settle();
      // Never more than the meeting that is live, at any point in the sequence.
      expect(recorder.segmentSubscribers).toBeLessThanOrEqual(1);
    }

    for (const id of ids) {
      const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
      expect(record.session.transcript.map((s) => s.id)).toEqual([`${id}-mic-0-s000`]);
      // And nothing is queued for a meeting that has already been written out,
      // which is the shape the eight parked entries had.
      expect(pendingSteps(record).filter((step) => step.kind === "segments")).toHaveLength(0);
    }
  });

  test("a meeting discarded rather than ended leaves no handler behind", async () => {
    const { controller, recorder } = await harness();
    const gone = await controller.start({ title: "Discarded" });
    recorder.emit(fakeSegment(`${gone}-mic-0-s000`, 0, "never mind"));
    await controller.discard(gone);
    await settle();

    expect(recorder.segmentSubscribers).toBe(0);
    expect(recorder.errorSubscribers).toBe(0);

    const kept = await controller.start({ title: "Kept" });
    recorder.emit(fakeSegment(`${kept}-mic-0-s000`, 0, "this one counts"));
    await settle();

    expect(recorder.segmentSubscribers).toBe(1);
    const live = controller.getSnapshot().live!;
    expect(live.session.id).toBe(kept);
    expect(live.session.transcript.map((s) => s.text)).toEqual(["this one counts"]);
    // The discarded meeting is not resurrected by anything that arrived after it.
    expect(controller.getSnapshot().records.some((r) => r.session.id === gone)).toBe(false);
  });

  test("discarding an old meeting does not deafen the one that is recording", async () => {
    /*
      The other direction of the same branch, and the one a careless
      `detachRecorder()` at the top of `discard` would break: deleting a
      finished meeting from a list while a recording is running must not stop
      the running one from hearing anything.
    */
    const { controller, recorder } = await harness();
    const old = await controller.start({ title: "Old" });
    await controller.end();
    await settle();

    const live = await controller.start({ title: "Live" });
    await controller.discard(old);
    await settle();

    expect(recorder.segmentSubscribers).toBe(1);
    recorder.emit(fakeSegment(`${live}-mic-0-s000`, 0, "still listening"));
    await settle();
    expect(controller.getSnapshot().live!.session.transcript).toHaveLength(1);
  });

  test("words emitted while the recorder is stopping still reach the meeting that is ending", async () => {
    /*
      `end()` detaches **after** `await recorder.stop()`, and this is the check
      that the order is the one the comment claims. Every real recorder in this
      app drains its in-flight sends inside `stop()` — `drainSends`,
      `stream.finish()`, `stopCapture()` — so detaching first would drop the
      last words of every recording this app has ever made, silently, and no
      other test in this file would notice.
    */
    const recorder = fakeRecorder();
    const stopped = recorder.stop.bind(recorder);
    let onStop: (() => void) | null = null;
    recorder.stop = async () => {
      onStop?.();
      await stopped();
    };

    const { controller } = await harness({ recorder });
    const id = await controller.start({ title: "One" });
    onStop = () => recorder.emit(fakeSegment(`${id}-mic-9-s000`, 9_000, "the last words"));
    await controller.end();
    await settle();

    const done = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(done.session.transcript.map((s) => s.text)).toEqual(["the last words"]);
  });

  test("a recorder swapped in between meetings leaves nothing attached to the old one", async () => {
    /*
      `retainedRecorder`'s own case, from the other side. A screen remounting
      mid-meeting hands a fresh recorder in and the live one is kept; once the
      meeting ends the *next* configure takes the new object — and the handler
      the old object is holding has to be gone by then, or a shell still
      shipping chunks from the previous capture writes into a finished meeting.
    */
    const first = fakeRecorder();
    const { controller, store, gateway, clock } = await harness({ recorder: first });
    const one = await controller.start({ title: "One" });

    const second = fakeRecorder();
    await controller.configure({
      workspaceId: "ws-1",
      store,
      gateway,
      recorder: second,
      device: DEVICE,
      now: clock.now,
      persistDebounceMs: 0,
    });
    // Live, so the recorder holding the microphone is the one that is kept.
    expect(second.segmentSubscribers).toBe(0);
    first.emit(fakeSegment(`${one}-mic-0-s000`, 0, "mid-meeting, on the retained recorder"));
    await settle();
    expect(controller.getSnapshot().live!.session.transcript).toHaveLength(1);

    await controller.end();
    await settle();
    expect(first.segmentSubscribers).toBe(0);
    expect(first.errorSubscribers).toBe(0);

    const third = fakeRecorder();
    await controller.configure({
      workspaceId: "ws-1",
      store,
      gateway,
      recorder: third,
      device: DEVICE,
      now: clock.now,
      persistDebounceMs: 0,
    });
    const two = await controller.start({ title: "Two" });
    third.emit(fakeSegment(`${two}-mic-0-s000`, 0, "on the new recorder"));
    // And the object the first meeting was recorded on is inert.
    first.emit(fakeSegment(`${one}-mic-1-s000`, 1_000, "from a recorder nobody is holding"));
    await settle();

    const finished = controller.getSnapshot().records.find((r) => r.session.id === one)!;
    expect(finished.session.transcript.map((s) => s.id)).toEqual([`${one}-mic-0-s000`]);
    expect(pendingSteps(finished).filter((step) => step.kind === "segments")).toHaveLength(0);
    expect(controller.getSnapshot().live!.session.transcript.map((s) => s.text)).toEqual([
      "on the new recorder",
    ]);
  });

  test("a second meeting started without ending the first does not feed the first", async () => {
    /*
      Nothing in `start()` refuses to begin while something is live — the
      product's own recovery paths rely on that — so the overlap is reachable,
      and it is the one path to a stale handler that `end()` and `discard()`
      between them do not cover. `listenToRecorder` detaches first, so the
      window is closed here too.
    */
    const { controller, recorder } = await harness();
    const one = await controller.start({ title: "One" });
    const two = await controller.start({ title: "Two" });
    recorder.emit(fakeSegment(`${two}-mic-0-s000`, 0, "second meeting"));
    await settle();

    expect(recorder.segmentSubscribers).toBe(1);
    const first = controller.getSnapshot().records.find((r) => r.session.id === one)!;
    const second = controller.getSnapshot().records.find((r) => r.session.id === two)!;
    expect(first.session.transcript).toHaveLength(0);
    expect(second.session.transcript.map((s) => s.text)).toEqual(["second meeting"]);
  });

  test("a capture failure is delivered once, to the meeting that is recording", async () => {
    /*
      The error subscription, tested by what it *does* rather than by counting
      it. One handler per meeting ever started meant a single refused
      microphone ran the snapshot setter once per meeting; harmless only
      because they all write the same string, and not a property worth relying
      on.
    */
    const { controller, recorder } = await harness();
    await controller.start({ title: "One" });
    await controller.end();
    await settle();
    await controller.start({ title: "Two" });

    let sets = 0;
    const unsubscribe = controller.subscribe(() => {
      sets += 1;
    });
    recorder.fail({ message: "the microphone was taken", recoverable: true });
    unsubscribe();

    expect(sets).toBe(1);
    expect(controller.getSnapshot().captureError).toBe("the microphone was taken");
  });

  test("a session still open takes a late segment; only a finished one refuses", async () => {
    /*
      `acceptsTranscript` is state-shaped, like `can(...)` beside it, rather
      than "after end". The distinction is the whole reason the guard is safe
      to have: transcription lags the audio, so a meeting whose finalize has
      not landed yet must still be able to receive the tail of its own
      transcript. A guard that refused everything after `end()` would silently
      truncate every meeting on a slow engine.
    */
    const gateway = fakeGateway();
    const { controller } = await harness({ gateway });
    const id = await controller.start({ title: "On a plane" });
    // Something in it, so `end()` files it as `finalizing` rather than `empty`.
    // An `empty` session refusing late words is a known, stated residue of this
    // change rather than the case under test here.
    controller.setNotes(id, "typed while it ran");
    gateway.offlineFor(50);
    await controller.end();
    await settle();

    const parked = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(parked.session.state).toBe("finalizing");

    controller.apply(id, {
      type: "segment",
      segment: fakeSegment(`${id}-mic-9-s000`, 9_000, "transcribed late, and mine"),
    });
    await settle();

    const after = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(after.session.transcript.map((s) => s.text)).toEqual(["transcribed late, and mine"]);
  });

  test("a meeting waiting offline is not given the next meeting's words", async () => {
    /*
      THE CASE THIS PULL REQUEST IS ACTUALLY FOR.

      The eight parked entries were refused only because every session they
      named was already `complete` at the gateway. This is the same evening
      with the laptop offline: meeting one's finalize has not drained, so its
      session is still open and `appendSegments` would take anything addressed
      to it. Under the old build the `segments` step queued for it would have
      carried meeting two's words and would have been *accepted*, and the note
      written from that session would have held a conversation from another
      room.

      Three independent things have to hold for that to be closed, and all
      three are asserted here: the handler is gone, the projection holds only
      its own words, and the step the queue will send when the network returns
      names nothing that was not said in this meeting.
    */
    const gateway = fakeGateway();
    const { controller, recorder } = await harness({ gateway });
    const one = await controller.start({ title: "One" });
    recorder.emit(fakeSegment(`${one}-mic-0-s000`, 0, "said in the first meeting"));
    gateway.offlineFor(50);
    await controller.end();
    await settle();

    const waiting = controller.getSnapshot().records.find((r) => r.session.id === one)!;
    expect(waiting.session.state).toBe("finalizing");
    expect(pendingSteps(waiting).some((step) => step.kind === "finalize")).toBe(true);

    const two = await controller.start({ title: "Two" });
    recorder.emit(fakeSegment(`${two}-mic-0-s000`, 0, "said in the second meeting"));
    recorder.emit(fakeSegment(`${two}-mic-1-s000`, 20_000, "and more of it"));
    await settle();

    const still = controller.getSnapshot().records.find((r) => r.session.id === one)!;
    expect(still.session.transcript.map((s) => s.text)).toEqual(["said in the first meeting"]);
    for (const step of pendingSteps(still)) {
      if (step.kind !== "segments") continue;
      for (const segment of step.segments) {
        expect(segment.id.startsWith(`${one}-`)).toBe(true);
      }
    }
  });
});

