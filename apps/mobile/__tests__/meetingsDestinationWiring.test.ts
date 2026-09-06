import { describe, expect, test } from "@jest/globals";

import { MeetingsController } from "../features/meetings/controller";
import { fakeGateway } from "../features/meetings/fakeGateway";
import { fakeRecorder } from "../features/meetings/capture/fake";
import { loadMeetings } from "../features/meetings/local";
import { destinationKey } from "../features/meetings/keys";
import { createHttpGateway } from "../features/meetings/gateway";
import type { MeetingDestination } from "../features/meetings/destination";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import type { MeetingDevice } from "../features/meetings/protocol";

/**
 * The chosen folder, from the press to the note.
 *
 * ## What this is pinning
 *
 * Before this, a meeting's path was decided in exactly one place and it was not
 * on the device: `finalizeSession` in the gateway calls `meetingNotePath`, which
 * derives `0-inbox/meetings/YYYY/MM/…` from the session and consults nothing
 * else. The client never said, so there was nothing to say it with. These tests
 * pin the seam that now exists — the destination is recorded on the meeting, it
 * survives a restart, it is re-validated coming back off the device, and it is
 * on the finalize request, which is the one call that turns a session into a
 * note.
 *
 * ## Sabotage record
 *
 * Each applied to the feature, suite run, named test failed, reverted.
 *
 *  1. `sync.ts` finalizes with `null` rather than `record.destination`.
 *     → `the meeting lands in the folder that was chosen` fails.
 *  2. `controller.start` writes `destination: null` rather than
 *     `input.destination ?? null`.
 *     → `the meeting lands in the folder that was chosen` and `the destination
 *     is written down with the meeting, not held in a screen` fail.
 *  3. `parseRecord` restores `record.destination` with a cast instead of
 *     through `parseDestination`.
 *     → `a destination forged on the device is dropped, and the meeting is not`
 *     fails.
 *  4. `parseRecord` drops the destination on restore, defaulting it to `null`.
 *     → `the destination is written down with the meeting, not held in a
 *     screen` fails.
 *  5. `createHttpGateway` sends a bare `{}` on finalize.
 *     → `the finalize request is where the folder is said` fails.
 *
 * The one that is *not* covered here is the half this app cannot hold: a
 * deployed gateway ignores `folder`, because `FinalizeBody` does not name it.
 * `finalizeBody` in `gateway.ts` says exactly what is missing and where.
 */

const DEVICE: MeetingDevice = { platform: "ios", name: "a phone" };

const IN_A_PROJECT: MeetingDestination = {
  kind: "currentPage",
  contextSlug: "field-notes",
  folder: "1-projects/portal",
  label: "1-projects/portal",
};

async function harness(options: { store?: KeyValueStore } = {}) {
  const controller = new MeetingsController();
  const store = options.store ?? memoryStore();
  const gateway = fakeGateway();
  await controller.configure({
    workspaceId: "ws-1",
    store,
    gateway,
    recorder: fakeRecorder(),
    device: DEVICE,
    persistDebounceMs: 0,
  });
  return { controller, store, gateway };
}

/** Let the debounce timer and the fire-and-forget writes settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await Promise.resolve();
}

/* -------------------------------------------------------------------------- */

describe("a meeting is written where it was sent", () => {
  test("the meeting lands in the folder that was chosen", async () => {
    const { controller } = await harness();

    const id = await controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await controller.end();
    await settle();

    const session = controller.getSnapshot().records.find((r) => r.session.id === id)!.session;
    expect(session.state).toBe("complete");
    expect(session.notePath).toBe(`1-projects/portal/meetings/${id}.md`);
  });

  test("the finalize request is where the folder is said", async () => {
    /*
      Finalize rather than the session upsert, because finalize is the call that
      turns a session into a note in the customer's bucket — it is the request
      whose answer is the path, so it is the request that has to carry where the
      path should be.
    */
    const sent: Array<{ route: string; body: unknown }> = [];
    const gateway = createHttpGateway({
      origin: "https://gateway.invalid",
      authorization: async () => "Bearer test",
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent.push({ route: String(url), body: JSON.parse(String(init.body)) });
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: "mtg_x", state: "complete", notePath: "x.md" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });

    await gateway.finalize("mtg_x", IN_A_PROJECT);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.route).toContain("/meetings/sessions/mtg_x/finalize");
    expect(sent[0]!.body).toEqual({ folder: "1-projects/portal" });
  });

  test("a meeting nobody chose a folder for asks for nothing, and the default stands", async () => {
    /*
      `null` is the honest value for a meeting started before the question
      existed — a record restored from an older build, or the list screen's own
      one-tap record, which sits beside the disclosure already. It is never
      rewritten into a guess, and a bare finalize is exactly what the contract
      calls "no fields".
    */
    const sent: unknown[] = [];
    const gateway = createHttpGateway({
      origin: "https://gateway.invalid",
      authorization: async () => "Bearer test",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: "mtg_x", state: "complete", notePath: "x.md" }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
    });

    await gateway.finalize("mtg_x", null);
    expect(sent[0]).toEqual({});
  });

  test("the existing one-tap record still writes into the inbox", async () => {
    // The meetings list's red disc starts a meeting with no dialog in front of
    // it, and that is a decision this change must not quietly reverse.
    const { controller } = await harness();
    const id = await controller.start({ title: "New meeting" });
    await controller.end();
    await settle();

    const session = controller.getSnapshot().records.find((r) => r.session.id === id)!.session;
    expect(session.notePath).toBe(`0-inbox/meetings/${id}.md`);
  });
});

describe("the destination is a fact about the meeting, not about the screen", () => {
  test("the destination is written down with the meeting, not held in a screen", async () => {
    /*
      A recording outlives the sheet that started it — that is the whole reason
      the controller is not a provider. A destination held in component state
      would be gone by the time the meeting was finalized, which is minutes
      later and possibly a process later.
    */
    const store = memoryStore();
    const first = await harness({ store });
    const id = await first.controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await settle();

    const { records } = await loadMeetings(store, "ws-1");
    expect(records.find((r) => r.session.id === id)?.destination).toEqual(IN_A_PROJECT);
  });

  test("a destination forged on the device is dropped, and the meeting is not", async () => {
    /*
      `recallPlace`'s rule applied to the record: this process wrote it, but it
      is a file on a *device*, and the folder in it becomes a key in a request
      against the customer's own bucket. A record that cannot be trusted about
      where it was going is still somebody's meeting, so the destination is
      dropped and the meeting is kept.
    */
    const store = memoryStore();
    const { controller } = await harness({ store });
    const id = await controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await settle();

    const key = (await store.keys()).find((k) => k.includes(id))!;
    const raw = JSON.parse((await store.get(key))!) as Record<string, unknown>;
    await store.set(
      key,
      JSON.stringify({
        ...raw,
        destination: { kind: "currentPage", contextSlug: "x", folder: "../../etc", label: "x" },
      }),
    );

    const { records, unreadable } = await loadMeetings(store, "ws-1");
    expect(unreadable).toBe(0);
    expect(records.find((r) => r.session.id === id)?.destination).toBeNull();
  });

  test("the remembered choice is not the meeting's destination", async () => {
    // Two different things kept in two different places: what this *device*
    // last chose, and where this *meeting* is going. A meeting reading the
    // device's preference at finalize time would be filed by whatever was
    // chosen for some later meeting.
    const store = memoryStore();
    const { controller } = await harness({ store });
    await controller.start({ title: "Design review", destination: IN_A_PROJECT });
    await settle();

    expect(await store.get(destinationKey())).toBeNull();
  });
});
