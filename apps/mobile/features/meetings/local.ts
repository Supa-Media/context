import { currentEpoch } from "../offline/epoch";
import type { KeyValueStore } from "../offline/memory";
import { meetingKey, meetingKeys, meetingKeysForWorkspace } from "./keys";
import { MEETING_RECORD_VERSION, parseRecord, type MeetingRecord } from "./record";

/**
 * Reading and writing meetings on the device.
 *
 * The store itself is `features/offline`'s — `openStore()` on native
 * (`AsyncStorage`, `core` in `native-deps.json`), `store.web.ts` in a browser
 * (`localStorage`, probed with a real write and falling back to memory), and
 * `memoryStore()` in tests. There is one durable store in this app and this
 * feature does not add a second: what it adds is a key space beside the offline
 * one (`keys.ts` says why) and the encode/decode either side of it.
 *
 * ## Why every write takes an epoch
 *
 * The same barrier `features/offline/useOfflineNotes.ts` puts on every write it
 * makes, and for the same measured reason. A recording writes on a timer, on a
 * keystroke and on a transcript segment, all fire-and-forget over an async
 * store; sign-out is a `remove()` loop with an open window behind it. A write
 * in flight when somebody signs out would put their notes back on the device
 * after the clear said they were gone. `epoch.ts` is bumped *before* the
 * removals, each caller captures the number once, and a write whose capture no
 * longer matches is dropped.
 *
 * The epoch is an argument rather than read here so that a test can prove the
 * drop rather than trust it, and so that one mount's captured value is used by
 * every write that mount makes — reading `currentEpoch()` at write time would
 * always agree with itself and guard nothing.
 *
 * ## Why a failed write is not swallowed
 *
 * `store.set` is the one method `features/offline/store.ts` lets throw, because
 * a silent write failure is somebody's typing gone while the screen still says
 * it is safe. That is truer here than there: a note draft can be retyped from
 * the note, and a meeting cannot be re-recorded. So `saveMeeting` reports
 * whether the write landed, and the controller keeps the record in memory
 * either way — what is lost when this returns `false` is surviving a restart,
 * and that is the caller's to say out loud.
 */

/**
 * What a device that will not keep a meeting is told, in one place.
 *
 * Two code paths reach this state — the store saying `durable: false` when the
 * controller opens it, and a write that failed — and two different sentences
 * for one fact is how a person ends up seeing the claim change under them for
 * no reason they can see.
 */
export const NOT_DURABLE_REASON =
  "This device will not keep a meeting if the app closes. Finish and sync before you leave.";

/** The outcome of trying to write a meeting down. */
export interface SaveOutcome {
  /** The record is on the device and will survive the app being killed. */
  persisted: boolean;
  /** Why not, when it is not. Never a reason to hide the meeting. */
  reason?: string;
}

const DROPPED: SaveOutcome = Object.freeze({
  persisted: false,
  reason: "This device signed out while the meeting was being written down.",
});

export async function saveMeeting(
  store: KeyValueStore,
  record: MeetingRecord,
  epoch: number,
): Promise<SaveOutcome> {
  if (epoch !== currentEpoch()) return DROPPED;
  if (!store.durable) {
    // Not a failure — a browser in Private Browsing, or an embedded webview
    // that refused site data. The record is still held in memory and still
    // syncs; what it will not do is survive the tab closing, and `copy.ts`
    // turns this into the sentence somebody reads.
    await write(store, record);
    return { persisted: false, reason: NOT_DURABLE_REASON };
  }
  try {
    await write(store, record);
    return { persisted: true };
  } catch (error) {
    return { persisted: false, reason: messageOf(error) };
  }
}

async function write(store: KeyValueStore, record: MeetingRecord): Promise<void> {
  await store.set(
    meetingKey(record.workspaceId, record.session.id),
    JSON.stringify({ ...record, version: MEETING_RECORD_VERSION }),
  );
}

/**
 * Every meeting held for one context, newest first.
 *
 * Keys that will not parse are counted rather than thrown away silently:
 * a record this build cannot read is still a meeting somebody had, and the list
 * screen says how many rather than pretending the number is zero. That is the
 * same rule `waitingOnDevice` follows for a key it cannot classify — the count
 * over-warns by design, because the other direction is somebody's work
 * disappearing with no sentence anywhere.
 */
export interface RestoredMeetings {
  records: MeetingRecord[];
  /** Records under this feature's namespace that this build could not read. */
  unreadable: number;
}

export async function loadMeetings(
  store: KeyValueStore,
  workspaceId: string,
): Promise<RestoredMeetings> {
  const records: MeetingRecord[] = [];
  let unreadable = 0;

  for (const key of meetingKeysForWorkspace(await store.keys(), workspaceId)) {
    const record = parseRecord(await store.get(key), workspaceId);
    if (record === null) {
      unreadable += 1;
      continue;
    }
    records.push(record);
  }

  records.sort((a, b) => Date.parse(b.session.startedAt) - Date.parse(a.session.startedAt));
  return { records, unreadable };
}

/**
 * Forget one meeting.
 *
 * The only path that removes a person's recording from this device, and it is
 * reachable from exactly one place: a control they pressed. Nothing ages a
 * meeting out and nothing bounds how many are kept — see `record.ts`.
 */
export async function forgetMeeting(
  store: KeyValueStore,
  workspaceId: string,
  meetingId: string,
): Promise<void> {
  await store.remove(meetingKey(workspaceId, meetingId));
}

/**
 * Forget every meeting on this device.
 *
 * Not wired to sign-out yet — `keys.ts` explains why that is one line in
 * `features/offline/forget.ts` rather than something this feature can do to
 * itself, and `__tests__/meetingsController.test.ts` pins the gap. It is exported
 * so that line is a call rather than a second implementation of "which keys is
 * this about", which is the mistake `keysForWorkspace` exists to prevent.
 */
export async function forgetAllMeetings(store: KeyValueStore): Promise<void> {
  for (const key of meetingKeys(await store.keys())) await store.remove(key);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "This device would not write the meeting down.";
}
