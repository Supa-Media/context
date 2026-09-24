import type { CaptureOptions } from "../index";

/**
 * The sentences `audio.web.ts` may put on the glass, and the two small
 * helpers that decide when a couple of them apply.
 *
 * Split out of `audio.web.ts` so the recorder closure and the browser-probe
 * helpers are not competing with a wall of copy for space in one file. See
 * `audio.web.ts` for why this closed set exists at all.
 */

/** What we ask for, best first. The browser's own answer is what gets sent. */
export const WEB_MIME_CANDIDATES: readonly string[] = Object.freeze([
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
]);

/** Last resort, when the browser names no type at all for the blob it made. */
export const FALLBACK_MIME = "audio/webm";

export const MIC_DENIED =
  "Context needs microphone access to hear this meeting. This one is a typed session; your notes still land in your bucket.";

export const MIC_LOST =
  "The microphone is no longer available, so the rest of this meeting is typed. Your notes still land in your bucket.";

export const INTERRUPTED =
  "Something else took the microphone. Typing still works, and capture picks up when it is free.";

export const NO_TRANSCRIBER =
  "This meeting is not being transcribed — the app could not reach transcription. Your notes still land in your bucket.";

/** Same rule and same words as `audio.ts`: a caller bug, refused loudly. */
export const NO_SESSION_ID =
  "This meeting had no id to record against, so nothing was captured. Start the meeting again.";

/**
 * Same rule and same words as `audio.ts`, which carries the argument: one
 * device records one meeting, a second `start()` for the *same* meeting is
 * still one start, and a second meeting is refused out loud rather than by
 * returning and going on minting the first meeting's chunk ids.
 */
export const ALREADY_RECORDING =
  "This device is already recording another meeting. End that one first — your notes here are still kept.";

export const CHUNK_FAILED =
  "A few seconds of audio could not be transcribed. Capture is still running.";

export const SEND_BACKLOG =
  "Transcription is running behind, so a few seconds of audio were dropped. Capture is still running.";

/**
 * OFFLINE IN A BROWSER, SAID RATHER THAN HUNG.
 *
 * The phone keeps audio it cannot send (`spool.ts`); a browser does not —
 * `spoolDevice.web.ts` says why — so offline, a chunk here has nowhere to go.
 * It used to be dispatched anyway, into an action that neither resolves nor
 * rejects without a socket, three of them held in memory and the rest dropped
 * under "running behind", which blamed the transcriber for a missing network.
 * Now the chunk is not sent, and the screen says what is true and what still
 * works: the typed notes, and the phone.
 */
export const OFFLINE_NOT_KEPT =
  "You're offline, and this browser can't keep audio to transcribe later, so this part of the meeting isn't being transcribed. Your typed notes are still saved. The phone app keeps audio offline.";

/*
  WHY THERE IS A SENTENCE FOR SILENCE AT ALL. Same rule and same words as
  `audio.ts`, because the browser recorder and the phone's send the same chunks
  to the same worker.

  That worker now refuses the segments the engine's own evidence says are not
  speech — ninety seconds of a quiet room produced 166 words and filed them into
  a bucket, so an engine handed silence answers with sentences. The refusal is
  right, and it makes a quiet chunk come back with no words in it, which on the
  glass is exactly what a transcriber that has stopped working looks like: a
  chip that never appears. So the quiet one says so.

  It fires only when the WHOLE chunk came back empty and the worker said why: a
  meeting with pauses in it refuses the odd segment continuously, and a chip per
  pause teaches somebody to ignore the chip that matters.
*/
export const NO_SPEECH =
  "No speech was heard in the last stretch of audio, so nothing was transcribed from it. Capture is still running.";

/*
  ASKED FOR THE WHOLE CALL AND GIVEN HALF OF IT.

  One sentence for the three ways a browser hands back no shareable audio —
  the picker was cancelled, the source chosen has none, or nothing here can mix
  two inputs into one recording — because the person's next move is the same in
  all three and a sentence per cause is three chances to pick the wrong one.
  `recoverable: true`: the microphone half is running and the meeting is fine.
  It is the *claim* that would have been wrong, not the recording, which is the
  same reason `desktop.ts` reports `micOnly` rather than failing the start.
*/
export const SYSTEM_AUDIO_UNSHARED =
  "Only your microphone is in this recording — the call's own audio was not shared. To capture both sides, start a meeting again and share the tab the call is in, with its audio.";

/** The share was stopped from the browser's own bar, mid-meeting. */
export const SYSTEM_AUDIO_ENDED =
  "Sharing stopped, so the rest of this meeting is your microphone only. What was recorded before it stopped still has both sides.";

/** `navigator.onLine === false`, the one direction of it that is reliable. */
export function browserOffline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: unknown } }).navigator;
  return nav?.onLine === false;
}

/**
 * Everything a `RecorderError` from this module may say, and the whole of it.
 *
 * Same closed set, and the same reason, as `audio.ts`: a failed send used to
 * report `messageOf(error, CHUNK_FAILED)`, which is an arbitrary upstream
 * `Error.message` going straight onto the glass. Safe only while every refusal
 * upstream is a fixed string, and an argument-too-large error that quoted its
 * payload would put base64 audio on somebody's screen.
 */
export const CAPTURE_MESSAGES: readonly string[] = Object.freeze([
  MIC_DENIED,
  MIC_LOST,
  INTERRUPTED,
  NO_TRANSCRIBER,
  CHUNK_FAILED,
  SEND_BACKLOG,
  OFFLINE_NOT_KEPT,
  NO_SPEECH,
  NO_SESSION_ID,
  SYSTEM_AUDIO_UNSHARED,
  SYSTEM_AUDIO_ENDED,
  ALREADY_RECORDING,
]);

/**
 * The one place an upstream sentence still reaches somebody, and why.
 *
 * `start()` fails because of the *device* — `new MediaRecorder(...)` refusing a
 * container this browser cannot make — and that error carries no payload and
 * cannot: it is thrown before a byte has been recorded. Every failure that
 * happens with audio in hand goes through `CAPTURE_MESSAGES` instead.
 */
export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

/**
 * The meeting this capture belongs to, refused rather than invented.
 *
 * Same function as `audio.ts` and `desktop.ts`, restated here for the reason
 * they each restate it: every chunk id this recorder mints is
 * `${meetingId}-${index}`, and a generated fallback would put this recorder
 * back to keying its ids on the clock — unaddressed, and the identity guard
 * `assertSegmentsAddressed`/`foreignSegmentSessions` inert against it — the one
 * time a caller forgets to pass it. `controller.ts` always does.
 */
export function requireSessionId(options: CaptureOptions | undefined): string {
  const id = options?.sessionId ?? "";
  if (id === "") throw new Error(NO_SESSION_ID);
  return id;
}
