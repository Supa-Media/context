/**
 * The full instance shape `MeetingsController` ends up with once its four
 * responsibility mixins (`lifecycle.ts`, `finalizeRecovery.ts`,
 * `snapshotTyping.ts`, `persistence.ts`) are merged onto it — every field and
 * every method, by their original name and signature.
 *
 * Each mixin's own methods declare an explicit `this: MeetingsControllerShape`
 * parameter (type-only, erased at runtime) so a method defined in one file can
 * still call `this.someMethodFromAnotherFile(...)` and read `this.someField`
 * with full type-checking, without importing the class those live in — which
 * would import the facade (`controller.ts`) from a leaf module. This interface
 * is the one place that shape is written down.
 */
import type { MeetingRecorder } from "../capture";
import type { MeetingActivityController } from "../activityCore";
import type { MeetingProjection } from "../session";
import type { MeetingEvent } from "../protocol";
import type { MeetingRecord } from "../record";
import type { ConfigureInput, ContinueInput, MeetingsSnapshot, StartInput } from "./types";

export interface MeetingsControllerShape {
  listeners: Set<() => void>;
  snapshot: MeetingsSnapshot;
  projections: Map<string, MeetingProjection>;
  config: ConfigureInput | null;
  epoch: number;
  persistTimers: Map<string, ReturnType<typeof setTimeout>>;
  syncTimer: ReturnType<typeof setTimeout> | null;
  recorderOff: (() => void)[];
  listeningFor: string | null;
  activityControlTokens: Map<string, string>;
  audioOff: (() => void) | null;
  audioDraining: Promise<void> | null;
  audioAgain: boolean;
  audioRetryTimer: ReturnType<typeof setTimeout> | null;
  offlineNow: boolean;
  activity: MeetingActivityController;
  activityToken: () => string;

  configure(input: ConfigureInput): Promise<void>;
  recoverInterruptedRecordings(now?: number): void;
  recoverStaleFinalizes(now?: number): void;
  retainedRecorder(incoming: MeetingRecorder): MeetingRecorder;
  reset(): void;
  start(input: StartInput): Promise<string>;
  continueMeeting(input: ContinueInput): Promise<string | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  end(): Promise<void>;
  stopAndFold(config: ConfigureInput, activityMeetingId: string | null): Promise<void>;
  setNotes(meetingId: string, markdown: string): void;
  setTitle(meetingId: string, title: string): void;
  updateMeetingActivity(meetingId: string): void;
  consumeActivityControl(meetingId: string, suppliedToken: string): boolean;
  invalidateMeetingActivity(meetingId: string): void;
  discard(meetingId: string): Promise<void>;
  retry(meetingId: string): Promise<void>;
  retryFinalize(meetingId: string): Promise<void>;
  requestSync(): void;
  sync(): Promise<void>;
  setOffline(offline: boolean): void;
  drainAudio(): Promise<void>;
  audioHeld(meetingId: string): boolean;
  requestAudioDrain(): void;
  retryAudioAfter(ms: number): void;
  refreshAudio(): void;
  persistNow(meetingId: string): Promise<void>;
  apply(meetingId: string, event: MeetingEvent): void;
  listenToRecorder(meetingId: string): void;
  detachRecorder(): void;
  put(record: MeetingRecord, options: { immediate: boolean }): void;
  schedulePersist(record: MeetingRecord): void;
  flush(meetingId: string): void;
  cancelPersist(meetingId: string): void;
  persist(record: MeetingRecord): Promise<void>;
  find(meetingId: string): MeetingRecord | undefined;
  nowIso(): string;
  require(): ConfigureInput;
  setEnding(meetingId: string | null): void;
  setTranscribing(meetingId: string | null): void;
  set(snapshot: MeetingsSnapshot): void;
}
