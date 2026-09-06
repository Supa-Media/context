/**
 * Meeting capture: the phone's and the desktop web app's half.
 *
 * A meeting recorder whose notes land as plain Markdown in the customer's own
 * bucket, readable through the Context endpoint by every AI client they have
 * connected. **One file per meeting** — the transcript is a `## Transcript`
 * section of the same note, decided by the owner — so nothing in here refers to
 * a transcript file.
 *
 * Where to start reading:
 *
 *  - `protocol.ts` — the contract, from `packages/meetings`. Not edited here.
 *  - `session.ts` — the fold from an event log onto a session.
 *  - `record.ts` / `sync.ts` — what is on the device and what still has to
 *    reach the gateway.
 *  - `controller.ts` — the state, outside React, so a recording survives a
 *    navigation and a persistent bar needs no provider above it.
 *  - `capture/` — every audio concern, behind one interface, with what a real
 *    implementation needs written out in `capture/audio.ts`.
 */

/*
  The contract first. Re-exported through the feature's own barrel so a caller
  outside `features/meetings` never has to reach into `@context/meetings`
  itself — `protocol.ts` is the one place in this app that crosses that
  boundary, and keeping it that way is what makes "did somebody re-declare a
  meeting type locally" a one-file question.
*/
export {
  ERRORS,
  MEETING_ID_PREFIX,
  MEETING_TRANSITIONS,
  PROTOCOL_VERSION,
  ROUTES,
  isMeetingId,
} from "./protocol";
export type {
  Attendee,
  CalendarEvent,
  IngestAck,
  MeetingDevice,
  MeetingEvent,
  MeetingSession,
  MeetingSource,
  MeetingState,
  TranscriptSegment,
} from "./protocol";

/*
  The way in from outside this feature. One hook, so a layout that wants a
  microphone key has one thing to call and one thing to mount — see
  `useMeetingFlow.ts` for what pressing it does, what it deliberately does not
  do, and the one line the caller still owes (`useMeetingsSetup`).
*/
export {
  useMeetingFlow,
  NOT_READY_REFUSAL,
  type MeetingFlow,
  type MeetingFlowInput,
} from "./useMeetingFlow";
export {
  chooseOffer,
  describeDestination,
  parseDestination,
  recallDestination,
  rememberDestination,
  resolveDestinations,
  sameDestination,
  CONTEXT_ROOT_LABEL,
  INBOX_FOLDER,
  ONLY_YOU,
  READ_ONLY_REFUSAL,
  VISIBLE_TO_TEAM,
  type CurrentPage,
  type DestinationChoice,
  type DestinationContext,
  type DestinationOffer,
  type MeetingDestination,
} from "./destination";
export { DestinationSheet, AUDIO_SENTENCE } from "./components/DestinationSheet";

export { LiveMeetingScreen } from "./LiveMeetingScreen";
export { MeetingNoteScreen } from "./MeetingNoteScreen";
export { MeetingsListScreen } from "./MeetingsListScreen";
export { RecordingBar } from "./components/RecordingBar";
export { NotesPad } from "./components/NotesPad";
export { MeetingRow, RowDivider } from "./components/MeetingRow";
export { Waveform } from "./components/Waveform";

export {
  MeetingsController,
  meetings,
  findSession,
  recordElapsedMs,
  PERSIST_DEBOUNCE_MS,
  SYNC_THROTTLE_MS,
  type MeetingsSnapshot,
  type ConfigureInput,
  type StartInput,
} from "./controller";
export { useMeetingsSetup, useMeetingsSnapshot, useTick, platformFor } from "./useMeetings";

export {
  createHttpGateway,
  gatewayOriginFrom,
  MeetingGatewayError,
  GATEWAY_TIMEOUT_MS,
  type MeetingAddress,
  type MeetingsGateway,
} from "./gateway";
export { fakeGateway, type FakeGateway } from "./fakeGateway";

/*
  Through `./capture`, never past it. That barrel is the one audited door into
  the modules that hold audio, and a deep import from out here is what turned
  the rule into a preference.
*/
export {
  audioRecorder,
  createRecorder,
  fakeRecorder,
  fakeSegment,
  notesOnlyRecorder,
  type FakeRecorder,
  type MeetingRecorder,
  type RecorderCapability,
  type RecorderError,
} from "./capture";

export {
  applyMeetingEvent,
  can,
  elapsedMs,
  isLive,
  projectLog,
  seedProjection,
  seedSession,
  transcriptionFor,
  type MeetingProjection,
} from "./session";

export {
  ackStep,
  classifySyncFailure,
  emptyAck,
  isSynced,
  markSyncFailed,
  markSyncRejected,
  metadataFingerprint,
  parseRecord,
  pendingSteps,
  retrySync,
  MAX_SYNC_ATTEMPTS,
  MEETING_RECORD_VERSION,
  type MeetingAck,
  type MeetingRecord,
  type SyncStep,
} from "./record";

export { drainMeetings, EMPTY_MEETING_REPORT, type MeetingDrainReport } from "./sync";

export {
  forgetAllMeetings,
  forgetMeeting,
  loadMeetings,
  saveMeeting,
  NOT_DURABLE_REASON,
} from "./local";
export {
  destinationKey,
  meetingKey,
  meetingKeys,
  meetingKeysForWorkspace,
  parseMeetingKey,
} from "./keys";

export { newMeetingId } from "./ids";

export { MEETINGS_ROUTE, meetingHref } from "./route";

export {
  attendeeCount,
  clock,
  dayHeading,
  duration,
  groupMeetings,
  meetingBadge,
  meetingSubtitle,
  sourceLabel,
  startsIn,
  timeOfDay,
  type MeetingListSection,
} from "./format";
