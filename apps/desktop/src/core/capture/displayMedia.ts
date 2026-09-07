/**
 * What the shell is allowed to answer a `getDisplayMedia` request with.
 *
 * ## The half-truth this file exists to delete
 *
 * `main/capture.ts` used to answer every request with `{ audio: "loopback" }`
 * under a comment claiming that *"`video` is required by the API and
 * immediately discarded in the renderer"*. Both halves were wrong on this
 * Electron, and the second half is what hid the first: the renderer really did
 * stop the video track it never read, so the sentence looked true from inside
 * the app while the request it described had already been refused by Chromium.
 *
 * Measured in the live hidden capture window of the signed, installed build
 * (Chrome/130.0.6723.191, macOS 26.4.1), with the shipping handler answering:
 *
 * ```
 * A  { audio: true, video: false }  -> RESOLVED  audio=1 video=0
 * B  { audio: true }                -> REJECTED  AbortError: Error starting capture
 * C  { audio: true, video: true }   -> REJECTED  AbortError: Error starting capture
 * ```
 *
 * Shape C is what shipped. So `getDisplayMedia` had **never once** resolved on
 * this machine, and Chromium's own message for it — *"Video was requested, but
 * no video stream was provided"* — was thrown back into the handler, where
 * nothing caught it: two `UnhandledPromiseRejectionWarning` lines on stderr
 * every single time somebody pressed Record.
 *
 * The renderer asks for shape A now (`renderer/capture.ts`), which is
 * consistent with what this file answers. What this file adds is that the
 * consistency is **enforced from the shell's side too**: a caller that asks
 * for video is refused explicitly and loudly rather than being handed a shape
 * it did not ask for and left to Chromium to reject.
 *
 * ## Why it is a pure function and not three lines inside the handler
 *
 * `main/capture.ts` cannot be imported by the suite — it imports Electron — so
 * a decision written inline there is a decision nothing can check. This is the
 * same split `capture/permissions.ts` and `main/permissions.ts` already have,
 * and for the same reason.
 */

/** The half of Electron's `DisplayMediaRequestHandlerHandlerRequest` we read. */
export interface DisplayMediaRequest {
  /** True if the web content asked for a video stream. */
  videoRequested: boolean;
  /** True if the web content asked for an audio stream. */
  audioRequested: boolean;
}

/**
 * What to hand `callback`, or why nothing can be handed to it.
 *
 * `refuse` is not an error state — it is the honest answer to a request this
 * app has no source for, and the caller logs `reason` rather than putting it
 * in front of a person: it names an API shape, not something anybody can act
 * on.
 */
export type DisplayMediaAnswer =
  | { kind: "loopback"; streams: { audio: "loopback" } }
  | { kind: "refuse"; reason: string };

/**
 * Answer one display-media request.
 *
 * **The rule: never resolve a shape that was not requested.** This app owns
 * exactly one source — ScreenCaptureKit's system-audio tap, reached through
 * Electron's `audio: "loopback"` — and it has no video to give at all. Handing
 * an audio-only answer to a request that asked for video is what produced the
 * unhandled rejection above, so a video request is refused here by name.
 */
export function answerDisplayMedia(request: DisplayMediaRequest): DisplayMediaAnswer {
  if (request.videoRequested) {
    return {
      kind: "refuse",
      reason:
        "a display-media request asked for video, and this app has only the system-audio loopback tap to give",
    };
  }
  if (!request.audioRequested) {
    return {
      kind: "refuse",
      reason: "a display-media request asked for neither audio nor video",
    };
  }
  return { kind: "loopback", streams: { audio: "loopback" } };
}
