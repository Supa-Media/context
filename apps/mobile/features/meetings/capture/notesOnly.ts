import { nextRecorderState } from "@context/meetings/recorder";
import type { MeetingRecorder, RecorderState } from "./index";

/**
 * The recorder that records nothing, and says so.
 *
 * The reason differs by platform because the *work* differs by platform, and a
 * single vague sentence would hide that from whoever picks this up next:
 *
 *  - On **Android** the native side is only half paid for. `expo-audio` is in
 *    the baseline and `RECORD_AUDIO` comes with its plugin, but recording while
 *    the app is backgrounded on Android 14+ additionally needs a foreground
 *    service with the `microphone` type actually started — a notification the
 *    person can see, which is the platform being right about consent. That is a
 *    native target rather than a config line, and shipping the half without it
 *    would give somebody a recorder that stops the moment they look away.
 *  - On the **web** this is now the *fallback* rather than the whole story.
 *    `audio.web.ts` records the microphone through `getUserMedia`, so this
 *    branch is what a browser gets when it has no `MediaRecorder` or no
 *    `mediaDevices` at all — an old embedded webview, or a page served over
 *    plain HTTP, where the API is genuinely absent.
 *
 * The web sentence is unchanged and still true, and the distinction inside it
 * is worth keeping straight: what a browser cannot hear is **system** audio.
 * `getDisplayMedia({ audio: true })` only offers a shared tab or screen, only
 * on some browsers, and only with the person picking a source every time. So
 * even where capture works, the web build hears the room and your own side of a
 * call — not the far side of one on headphones. System audio is the desktop
 * app's job, and no copy anywhere may imply otherwise.
 */
export function notesOnlyRecorder(platform: "ios" | "android" | "web"): MeetingRecorder {
  let state: RecorderState = "idle";
  return {
    capability: {
      audio: false,
      // Nothing is captured at all, so there is nothing to be honest about
      // twice. `audio: false` already says the whole of it.
      systemAudio: false,
      transcribesAt: "nowhere",
      unavailableReason:
        platform === "web"
          ? "This browser can't hear the meeting, so this is a typed session. Your notes still land in your bucket."
          : "Audio capture isn't switched on in this build, so this is a typed session. Your notes still land in your bucket.",
    },
    get state() {
      return state;
    },
    /*
      The moves come from `@context/meetings`, not from four assignments here.

      A recorder that captures nothing still has to *say* the right thing about
      what it is doing — the clock runs, the bar is drawn, and `state` is what
      the honesty check in `capture/index.ts` reads. It used to answer
      `"recording"` to a `resume` after a `stop`, which no real recorder does:
      "a meeting that has ended does not reopen the microphone" was implemented
      twice, in the two files that hold a microphone, and not here.
    */
    async start() {
      state = nextRecorderState(state, "start");
    },
    async pause() {
      state = nextRecorderState(state, "pause");
    },
    async resume() {
      state = nextRecorderState(state, "resume");
    },
    async stop() {
      state = nextRecorderState(state, "stop");
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
