import type { CaptureOptions } from "../index";

/**
 * Every sentence the phone recorder may put in front of somebody, and the two
 * helpers that decide which one. Split out of `audio.ts`; the argument for each
 * message is kept with it below.
 */

export const MIC_DENIED =
  "Context needs microphone access to hear this meeting. This one is a typed session; your notes still land in your bucket.";

export const MIC_REVOKED =
  "Microphone access was turned off, so the rest of this meeting is typed. Your notes still land in your bucket.";

export const INTERRUPTED =
  "Something else took the microphone. Typing still works, and capture picks up when it is free.";

export const NO_TRANSCRIBER =
  "This meeting is not being transcribed — the app could not reach transcription. Your notes still land in your bucket.";

/**
 * The controller always supplies `sessionId`, so this is a caller bug rather
 * than a real-world situation — the same posture `desktop.ts`'s
 * `requireSessionId` takes, and for the same reason: a generated fallback here
 * is how the identity guard above goes back to being inert, quietly, on the day
 * somebody forgets to pass it. Loud on the first press beats quiet until the
 * next contamination review.
 */
export const NO_SESSION_ID =
  "This meeting had no id to record against, so nothing was captured. Start the meeting again.";

/**
 * ONE DEVICE, ONE MEETING — SAID OUT LOUD RATHER THAN BY RETURNING.
 *
 * `start()` used to return silently when this recorder was already recording,
 * which is right for the same meeting twice (a double press is one start) and
 * was quietly wrong for a *different* one. The console's own Record key is
 * drawn whether or not a meeting is live — `MeetingsListScreen` hides its
 * button and `ConsoleBottomBar` does not — so a second meeting really can be
 * started from a device that is already recording one, and the recorder went
 * on minting chunk ids for the meeting it opened with. Before phone ids named
 * their meeting that was silent contamination: the first meeting's audio was
 * folded into the second one's transcript, with the first meeting's offsets.
 * Since they name it, `controller.apply` refuses every one of those segments
 * — which is correct, and turns the same press into a meeting that records
 * *nothing at all* and says nothing about it.
 *
 * Neither is an outcome to leave a person in, and the recorder is the only
 * place that knows both meetings' names, so it refuses. `controller.start`
 * catches a refused start, keeps the session, and puts this sentence on the
 * live screen beside the notepad — the same handling a denied microphone gets,
 * for the same reason: the notes are the product and they keep working.
 */
export const ALREADY_RECORDING =
  "This device is already recording another meeting. End that one first — your notes here are still kept.";

export const CHUNK_FAILED =
  "A few seconds of audio could not be transcribed. Capture is still running.";

/**
 * A send failed and its chunk is still in the spool.
 *
 * Its own sentence rather than `CHUNK_FAILED`, because the two are different
 * facts: that one is a gap in the transcript, and this one is a delay. Telling
 * somebody audio was lost when it is sitting on their phone waiting to be sent
 * is the crying-wolf half of honesty, and it teaches them to stop reading chips.
 */
export const CHUNK_KEPT =
  "A few seconds of audio could not be transcribed yet. They are saved on this phone and will be sent again.";

export const SEND_BACKLOG =
  "Transcription is running behind, so a few seconds of audio were dropped. Capture is still running.";

/*
  WHY THERE IS A SENTENCE FOR SILENCE AT ALL.

  The transcription worker now refuses the segments the engine's own evidence
  says are not speech — ninety seconds of a quiet room produced 166 words and
  filed them into a bucket, so an engine handed silence answers with sentences.
  The refusal is right, and it makes a quiet chunk come back with no words in
  it, which on the glass is exactly what a transcriber that has stopped working
  also looks like: a chip that never appears.

  So the quiet one says so. It fires only when the WHOLE chunk came back empty
  and the worker said why: a meeting with pauses in it refuses the odd segment
  continuously, and a chip per pause is noise that teaches somebody to ignore
  the chip that matters.
*/
export const NO_SPEECH =
  "No speech was heard in the last stretch of audio, so nothing was transcribed from it. Capture is still running.";

export const IOS_BACKGROUND_UNAVAILABLE =
  "Recording works while Context stays open, but locking your phone will stop the audio.";

/**
 * Everything a `RecorderError` from this module may say, and the whole of it.
 *
 * The messages above are what the controller puts on the glass, and until this
 * existed one of them was not ours: a failed send reported
 * `messageOf(error, CHUNK_FAILED)`, which is an arbitrary upstream
 * `Error.message`. That is safe exactly while every refusal on the other end is
 * a fixed string, and it is one deploy away from not being — an
 * argument-too-large error that quotes its payload would put base64 audio on
 * somebody's screen. So the set is closed, and `meetingsCapture.test.ts` asserts
 * every reported message is in it.
 *
 * `MIC_DENIED` is here too even though it is *thrown* from `start()` rather than
 * reported: the controller writes a rejected start onto the same snapshot field.
 */
export const CAPTURE_MESSAGES: readonly string[] = Object.freeze([
  MIC_DENIED,
  MIC_REVOKED,
  INTERRUPTED,
  NO_TRANSCRIBER,
  CHUNK_FAILED,
  CHUNK_KEPT,
  SEND_BACKLOG,
  NO_SPEECH,
  NO_SESSION_ID,
  IOS_BACKGROUND_UNAVAILABLE,
  ALREADY_RECORDING,
]);

/**
 * The meeting this capture belongs to, refused rather than invented.
 *
 * `desktop.ts`'s own function, restated here rather than shared: every chunk id
 * this recorder mints is `${meetingId}-${index}`, and a generated fallback —
 * `Math.random()`, a fresh id, the very `Date.now()` this replaced — would put
 * this recorder back where it started, silently, the one time a caller forgets
 * to pass it. `controller.ts` always does; a caller that does not has a bug and
 * it should be loud on the first press rather than discovered in a
 * contamination review.
 */
export function requireSessionId(options: CaptureOptions | undefined): string {
  const id = options?.sessionId ?? "";
  if (id === "") throw new Error(NO_SESSION_ID);
  return id;
}

/**
 * The one place an upstream sentence still reaches somebody, and why.
 *
 * `start()` fails because of the *device* — a microphone another app is holding,
 * a session this binary has no entitlement for — and `expo-audio` says which,
 * usefully, in words. That error carries no payload and cannot: it is thrown
 * before a byte has been recorded. Every failure that happens with audio in
 * hand goes through `CAPTURE_MESSAGES` instead.
 */
export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
