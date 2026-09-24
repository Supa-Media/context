import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { FINALIZE_TIMEOUT_MS } from "../../features/meetings/recovery";
import { pendingSteps } from "../../features/meetings/record";
import { DEVICE, MeetingsController, fakeGateway, fakeRecorder, harness, memoryStore, settle } from "./fixtures";

/**
 * A session stuck finalizing is not left stuck, and a meeting recovery gave
 * up on can still be filed. See `fixtures.ts` for the controller harness and
 * the sabotage record that proves it.
 */

afterEach(() => {
  jest.useRealTimers();
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

  /*
    THE CASE THE RETRY WAS WRITTEN FOR, AND THE ONE IT DID NOT COVER.

    `retryFinalize`'s own header names it: the stuck meeting the owner reported
    is a gateway that *accepted* a finalize and never came back with a path.
    That acknowledgement sets `acked.finalized`, `pendingSteps` then offers no
    finalize step, and `sync.ts` says the answer "arrives through the list" —
    except nothing in this app has ever called `gateway.list()`.

    So the only thing that could ask again was `recoverStaleFinalizes`'s retry
    branch, and it went through `retrySync`, which returns the record unchanged
    when there is no `rejection` and never touches `acked.finalized`. The
    automatic retry was a no-op in exactly the case it exists for: ten minutes
    of nothing, then ten more, then `failed` — with the words on the device and
    a note the gateway may well have written.

    Measured before the fix: `the retry actually asks the gateway again` saw 1
    finalize call where it expects 2, and `and the note lands without anybody
    pressing anything` ended `failed` with `notePath` null.
  */
  test("the retry actually asks the gateway again, rather than stamping a clock", async () => {
    const gateway = fakeGateway();
    gateway.withholdNotePath(1);
    const { controller, clock } = await harness({ gateway });
    const id = await controller.start({ title: "Jhon / Seyi" });
    controller.setNotes(id, "the bit that must not be lost");
    await controller.end();
    await settle();

    const accepted = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(accepted.session.state).toBe("finalizing");
    expect(accepted.acked.finalized).toBe(true);
    expect(accepted.session.notePath).toBeNull();
    const before = gateway.calls.filter((call) => call === "finalize").length;

    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    await controller.sync();
    await settle();

    expect(gateway.calls.filter((call) => call === "finalize").length).toBeGreaterThan(before);
  });

  test("and the note lands without anybody pressing anything", async () => {
    const gateway = fakeGateway();
    gateway.withholdNotePath(1);
    const { controller, clock } = await harness({ gateway });
    const id = await controller.start({ title: "Jhon / Seyi" });
    controller.setNotes(id, "the bit that must not be lost");
    await controller.end();
    await settle();

    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    await controller.sync();
    await settle();

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("complete");
    expect(record.session.notePath).not.toBeNull();
    expect(record.session.notes).toBe("the bit that must not be lost");
    // One meeting, one note: asking again is idempotent, not a second file.
    expect(gateway.notesWritten()).toBe(1);
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

