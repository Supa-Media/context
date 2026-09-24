import { jest } from "@jest/globals";
import { memoryStore, type KeyValueStore } from "../../features/offline/memory";
import { MeetingsController } from "../../features/meetings/controller";
import { fakeGateway, type FakeGateway } from "../../features/meetings/fakeGateway";
import { fakeRecorder, type FakeRecorder } from "../../features/meetings/capture/fake";
import type { MeetingActivityController } from "../../features/meetings/activityCore";

export { memoryStore, type KeyValueStore, MeetingsController, fakeGateway, type FakeGateway, fakeRecorder, type FakeRecorder };

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

export const DEVICE = { platform: "ios" as const, name: "a phone" };

/** A clock a test moves by hand. Elapsed time is arithmetic, not a wait. */
export function clockFrom(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

export interface Harness {
  controller: MeetingsController;
  store: KeyValueStore;
  gateway: FakeGateway;
  recorder: FakeRecorder;
  clock: ReturnType<typeof clockFrom>;
}

export async function harness(
  options: {
    store?: KeyValueStore;
    recorder?: FakeRecorder;
    gateway?: FakeGateway;
    workspaceId?: string;
    /** Where this launch's clock starts. Defaults to the fixture instant. */
    startAt?: number;
    activity?: MeetingActivityController;
    activityToken?: () => string;
  } = {},
): Promise<Harness> {
  const controller = new MeetingsController(options.activity, options.activityToken);
  const store = options.store ?? memoryStore();
  const gateway = options.gateway ?? fakeGateway();
  const recorder = options.recorder ?? fakeRecorder();
  const clock = clockFrom(options.startAt ?? Date.parse("2026-09-05T18:00:00.000Z"));

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
export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await Promise.resolve();
}

export function fakeActivity() {
  return {
    available: jest.fn(() => true),
    update: jest.fn(),
    end: jest.fn(),
    reconcile: jest.fn(),
  } satisfies MeetingActivityController;
}
