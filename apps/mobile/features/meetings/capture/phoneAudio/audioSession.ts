import { setAudioModeAsync } from "expo-audio";
import type { AudioMode } from "expo-audio";

/**
 * The audio session a meeting needs, which is the opposite of a voice memo's.
 *
 * Exported so the test can assert the exact object rather than a mock's call
 * count: `interruptionMode` is the field whose default silently breaks the call
 * being recorded, and a regression here is invisible everywhere else.
 */
export const MEETING_AUDIO_MODE: Partial<AudioMode> = Object.freeze({
  allowsRecording: true,
  allowsBackgroundRecording: true,
  playsInSilentMode: true,
  shouldPlayInBackground: true,
  interruptionMode: "mixWithOthers",
});

/** The last-known-good iOS session when its native module rejects the new flag. */
const IOS_FOREGROUND_AUDIO_MODE: Partial<AudioMode> = Object.freeze({
  allowsRecording: true,
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  interruptionMode: "mixWithOthers",
});

/**
 * Ask for the session a meeting needs, and settle for less if this binary
 * cannot give it.
 *
 * Both platforms first use the same background-capable session. An affected
 * iOS native module can reject that newer object before opening the microphone;
 * retrying the old foreground mode restores recording without pretending the
 * downgrade will survive a lock. Android has no safe equivalent because the
 * same switch starts its required foreground service, so it still fails closed.
 */
export async function configureAudioSession(platform: "ios" | "android"): Promise<boolean> {
  try {
    await setAudioModeAsync(MEETING_AUDIO_MODE);
    return true;
  } catch {
    if (platform === "ios") {
      try {
        await setAudioModeAsync(IOS_FOREGROUND_AUDIO_MODE);
        return false;
      } catch {
        // The stable foreground mode also failed; no recorder may be opened.
      }
    }
    throw new Error("Background audio could not be enabled; recording cannot safely continue.");
  }
}
