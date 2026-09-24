import { Directory, File, Paths } from "expo-file-system";

/** Where `expo-audio` writes: `<caches>/ExpoAudio/recording-<uuid>.m4a`. */
const RECORDING_DIR = "ExpoAudio";

/**
 * Drop anything a previous run of this app left in the recording directory.
 *
 * Called once, when this module is evaluated. That placement is the whole of
 * why it is safe: a module body runs before any recorder in this runtime
 * exists, so there is no open chunk for it to delete out from under a meeting.
 * Doing it at `createRecorder` time would not be safe — every screen in the
 * feature builds one, including on a remount that happens mid-recording.
 *
 * Everything is guarded: a cache directory this build cannot read is not a
 * reason to refuse somebody a meeting.
 */
export function sweepLeftovers(): void {
  try {
    const directory = new Directory(Paths.cache, RECORDING_DIR);
    if (!directory.exists) return;
    for (const entry of directory.list()) {
      try {
        entry.delete();
      } catch {
        // One file that will not go is not a reason to leave the rest.
      }
    }
  } catch {
    // No cache directory, or no permission to read it. Nothing to do.
  }
}

/**
 * Delete, and never let the delete be the thing that breaks a meeting.
 *
 * Takes a uri rather than a `File` because `new File(uri)` is itself a call
 * that can throw — a path the file system will not accept — and the one place
 * that must never throw is the sweep on the way out of a recording.
 */
export function discard(uri: string): void {
  try {
    new File(uri).delete();
  } catch {
    // A file that was never written, one already collected, or a path this
    // build cannot make a handle for. Nothing to do, and nothing worth telling
    // somebody in a meeting about.
  }
}
