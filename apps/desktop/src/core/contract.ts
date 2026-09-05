/**
 * The contract, in one import.
 *
 * `packages/meetings/src/protocol.js` is the single source of truth for what a
 * meeting is, and it is plain ESM with JSDoc types because the gateway is a
 * dependency-free Workers bundle that imports it directly. This module is the
 * one place in the desktop app that reaches for it, so that:
 *
 *  - a TypeScript file elsewhere writes `import type { DetectionSignals } from
 *    "../contract.ts"` and never has to know the contract is JavaScript, and
 *  - if the contract moves or is versioned, exactly one file changes.
 *
 * Nothing is redefined here. Every type below is re-exported, not restated: a
 * local copy of `TranscriptSegment` that drifts by one field is a wire bug that
 * typechecks, which is the failure this file exists to make impossible.
 */

/**
 * Session ids come from the shared package too.
 *
 * `session.js` already mints them to the contract's alphabet and length, and a
 * second generator on the desktop would be a second thing that can be wrong
 * about what an id looks like. The id is minted **here**, on the machine that
 * is recording, before anything is posted: the gateway upserts on it, so a
 * laptop that recorded a whole meeting on a plane posts under the id it has
 * been using all along and gets one note rather than two.
 */
export { newMeetingId } from "@context/meetings";

export {
  PROTOCOL_VERSION,
  MEETING_TRANSITIONS,
  CLIENT_EVENT_TYPES,
  GATEWAY_EVENT_TYPES,
  MEETING_ID_PREFIX,
  MEETING_ID_ALPHABET,
  MEETING_ID_LENGTH,
  MEETING_SOURCE_KINDS,
  TRANSCRIPT_CHANNELS,
  DEVICE_PLATFORMS,
  isMeetingId,
  ROUTES,
  ERRORS,
  DETECTOR_THRESHOLDS,
  WATCH_FLAG_LABEL_MAX,
} from "@context/meetings/protocol";

export type {
  Attendee,
  CalendarEvent,
  DetectionResult,
  DetectionSignals,
  DetectorState,
  IngestAck,
  MeetingDevice,
  MeetingEvent,
  MeetingSession,
  MeetingSource,
  MeetingState,
  TranscriptSegment,
  WindowSignal,
} from "@context/meetings/protocol";
