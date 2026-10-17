import { describe, expect, test } from "@jest/globals";
import { MeetingHeldByDevice } from "../../features/meetings/gateway";
import {
  landingKey,
  meetingLanding,
  strandedMeetings,
  unacknowledgedStranded,
} from "../../features/meetings/landing";
import { FINALIZE_TIMEOUT_MS } from "../../features/meetings/recovery";
import { MAX_SYNC_ATTEMPTS, QUEUED_ON_THIS_MACHINE, parseRecord } from "../../features/meetings/record";
import { fakeGateway, harness, settle } from "./fixtures";

/**
 * A MEETING THE DESKTOP SHELL IS STILL SENDING IS NOT "NOT SAVED".
 *
 * Inside the desktop app the shell's durable outbox writes the meeting, and a
 * finalize it has only queued comes back to the page as "queued". Every drain
 * counted that answer as a failed attempt, so six drains after a meeting ended
 * the page parked it as `RETRIES_EXHAUSTED` and drew "Not saved to your
 * context" over the app, with a Retry that could only get "queued" again. The
 * owner's report: "why does desktop always have this? It's blocking
 * everything" (2026-10-17).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. The `MeetingHeldByDevice` branch in `sync.ts` removed.
 *     → **fails**: `however many drains, a held finalize is never parked`.
 *  2. The `handedOver` skip in `recoverStaleFinalizes` removed.
 *     → **fails**: `and recovery never fails it on the clock`.
 *  3. `restoredSyncState`'s repair removed.
 *     → **fails**: `a meeting an earlier build parked over "queued" comes back held`.
 */

function heldGateway() {
  const gateway = fakeGateway();
  const realFinalize = gateway.finalize.bind(gateway);
  let holding = true;
  gateway.finalize = async (to, session, continues) => {
    if (holding) throw new MeetingHeldByDevice(QUEUED_ON_THIS_MACHINE);
    return realFinalize(to, session, continues);
  };
  return { gateway, release: () => (holding = false) };
}

describe("a finalize the desktop shell is holding", () => {
  test("however many drains, a held finalize is never parked", async () => {
    const { gateway } = heldGateway();
    const { controller } = await harness({ gateway });
    const id = await controller.start({ title: "New meeting" });
    controller.setNotes(id, "the words that must not be lost");
    await controller.end();
    await settle();
    for (let i = 0; i < MAX_SYNC_ATTEMPTS * 2; i += 1) await controller.sync();

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.rejection).toBeUndefined();
    expect(record.handedOver).toBe(true);
    expect(record.session.state).toBe("finalizing");
    expect(meetingLanding(record)?.kind).toBe("pending");
    expect(meetingLanding(record)?.detail).toBe(QUEUED_ON_THIS_MACHINE);
    expect(strandedMeetings(controller.getSnapshot().records)).toEqual([]);
  });

  test("and recovery never fails it on the clock", async () => {
    const { gateway } = heldGateway();
    const { controller, clock } = await harness({ gateway });
    const id = await controller.start({ title: "New meeting" });
    controller.setNotes(id, "typed");
    await controller.end();
    await settle();
    await controller.sync();

    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("finalizing");
    expect(strandedMeetings(controller.getSnapshot().records)).toEqual([]);
  });

  test("once the shell answers with the path, the meeting is filed and no longer held", async () => {
    const { gateway, release } = heldGateway();
    const { controller } = await harness({ gateway });
    const id = await controller.start({ title: "New meeting" });
    controller.setNotes(id, "typed");
    await controller.end();
    await settle();
    await controller.sync();

    release();
    await controller.sync();

    const record = controller.getSnapshot().records.find((r) => r.session.id === id)!;
    expect(record.session.state).toBe("complete");
    expect(record.session.notePath).not.toBeNull();
    expect(record.handedOver).toBeUndefined();
  });
});

describe("closing the notice", () => {
  test("hides it for this problem only, and keeps the meeting", async () => {
    const gateway = fakeGateway();
    const { controller, clock } = await harness({ gateway });
    gateway.offlineFor(1000);
    const id = await controller.start({ title: "Stranded" });
    controller.setNotes(id, "typed");
    await controller.end();
    await settle();
    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    clock.advance(FINALIZE_TIMEOUT_MS);
    controller.recoverStaleFinalizes(clock.now());
    expect(unacknowledgedStranded(controller.getSnapshot().records)).toHaveLength(1);

    controller.dismissNotice(id);

    const records = controller.getSnapshot().records;
    expect(unacknowledgedStranded(records)).toEqual([]);
    // Still a stranded meeting for the list and its page, with its words.
    expect(strandedMeetings(records)).toHaveLength(1);
    expect(records.find((r) => r.session.id === id)!.session.notes).toBe("typed");
    expect(records.find((r) => r.session.id === id)!.noticeDismissed).toBe(
      landingKey(meetingLanding(records.find((r) => r.session.id === id)!)!),
    );
  });
});

describe("records written by earlier builds", () => {
  const raw = (over: Record<string, unknown>) =>
    JSON.stringify({
      version: 1,
      workspaceId: "ws-1",
      session: {
        id: "mtg_abcdefghjkmnpqrstv",
        title: "New meeting",
        state: "finalizing",
        startedAt: "2026-10-17T15:00:00.000Z",
        notes: "typed",
        transcript: [],
        attendees: [],
        notePath: null,
      },
      acked: { metadata: null, segmentIds: [], notes: null, finalized: false },
      destination: null,
      runningSince: null,
      updatedAt: 0,
      attempts: 6,
      ...over,
    });

  test('a meeting an earlier build parked over "queued" comes back held', () => {
    const record = parseRecord(
      raw({
        rejection: {
          code: "RETRIES_EXHAUSTED",
          message: `${QUEUED_ON_THIS_MACHINE} It is still on this device after several tries — try again, or copy your notes out.`,
          noticedAt: 1,
        },
      }),
      "ws-1",
    )!;
    expect(record.rejection).toBeUndefined();
    expect(record.handedOver).toBe(true);
    expect(strandedMeetings([record])).toEqual([]);
  });

  test("any other exhausted retry stays parked", () => {
    const record = parseRecord(
      raw({ rejection: { code: "RETRIES_EXHAUSTED", message: "gateway timed out. It is still…", noticedAt: 1 } }),
      "ws-1",
    )!;
    expect(record.rejection?.code).toBe("RETRIES_EXHAUSTED");
    expect(strandedMeetings([record])).toHaveLength(1);
  });

  test("a dismissal survives a restart, and nothing else rides in on it", () => {
    const record = parseRecord(raw({ noticeDismissed: "failed\nx\n", handedOver: "yes" }), "ws-1")!;
    expect(record.noticeDismissed).toBe("failed\nx\n");
    expect(record.handedOver).toBeUndefined();
  });
});
