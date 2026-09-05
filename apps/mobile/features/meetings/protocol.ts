/**
 * The meeting contract, as TypeScript sees it.
 *
 * `packages/meetings/src/protocol.js` is the single source of truth for what a
 * meeting *is* — three clients capture one and one gateway writes it into the
 * customer's own bucket — and it is plain ESM with JSDoc types so the
 * dependency-free Workers bundle can import it directly. This file is the one
 * place in the app that crosses that boundary.
 *
 * Why it exists at all rather than every module importing
 * `@context/meetings/protocol` itself:
 *
 *  - **One import to audit.** The rule for this app is that the contract is not
 *    edited here. A single crossing point makes "did somebody re-declare a
 *    meeting type locally" a one-file question.
 *  - **The names travel.** A JSDoc `@typedef` is reachable from TypeScript, but
 *    only by naming the module it lives in; re-exporting them means the rest of
 *    the feature reads `import type { MeetingSession } from "../protocol"` like
 *    every other feature in this app reads its own types.
 *
 * Nothing is added, narrowed or renamed on the way through. If a shape here
 * disagrees with `protocol.js`, `protocol.js` is right and this file is the
 * bug — `__tests__/meetingsProtocol.test.ts` asserts the values round-trip.
 */

export {
  CLIENT_EVENT_TYPES,
  DETECTOR_THRESHOLDS,
  DEVICE_PLATFORMS,
  ERRORS,
  GATEWAY_EVENT_TYPES,
  MEETING_ID_ALPHABET,
  MEETING_ID_LENGTH,
  MEETING_ID_PREFIX,
  MEETING_SOURCE_KINDS,
  MEETING_TRANSITIONS,
  PROTOCOL_VERSION,
  ROUTES,
  TRANSCRIPT_CHANNELS,
  WATCH_FLAG_LABEL_MAX,
  isMeetingId,
} from "@context/meetings/protocol";

export type {
  Attendee,
  MeetingSessionSummary,
  SessionList,
  SessionRead,
  CalendarEvent,
  DetectionResult,
  DetectionSignals,
  DetectorState,
  IngestAck,
  MeetingDevice,
  MeetingEvent,
  MeetingFlag,
  MeetingSession,
  MeetingSource,
  MeetingState,
  TranscriptSegment,
  WatchCommand,
  WatchState,
  WindowSignal,
} from "@context/meetings/protocol";
