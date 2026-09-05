import type { MeetingRecorder, RecorderState } from "./index";

/**
 * The recorder that records nothing, and says so.
 *
 * The reason differs by platform because the *work* differs by platform, and a
 * single vague sentence would hide that from whoever picks this up next:
 *
 *  - On a phone the native side is paid for — `expo-audio` is in the baseline —
 *    and what is missing is the permission strings and a transcriber.
 *  - On the web it is a different feature entirely. `getUserMedia` can capture
 *    the microphone in a browser after a permission prompt, but the thing
 *    people actually want on a desktop is the *other* side of the call, and a
 *    browser tab cannot hear system audio: `getDisplayMedia({ audio: true })`
 *    only offers it for a shared tab or screen, only on some browsers, and only
 *    with the person picking the source every time. So the desktop web build is
 *    a notepad, deliberately, and the desktop app is where system audio lives.
 */
export function notesOnlyRecorder(platform: "ios" | "android" | "web"): MeetingRecorder {
  let state: RecorderState = "idle";
  return {
    capability: {
      audio: false,
      transcribesAt: "nowhere",
      unavailableReason:
        platform === "web"
          ? "This browser can't hear the meeting, so this is a typed session. Your notes still land in your bucket."
          : "Audio capture isn't switched on in this build, so this is a typed session. Your notes still land in your bucket.",
    },
    get state() {
      return state;
    },
    async start() {
      state = "recording";
    },
    async pause() {
      state = "paused";
    },
    async resume() {
      state = "recording";
    },
    async stop() {
      state = "stopped";
    },
    onSegment() {
      // Never called. Returning a working unsubscribe rather than a throw keeps
      // the caller's teardown identical on every platform.
      return () => {};
    },
    onError() {
      return () => {};
    },
  };
}
