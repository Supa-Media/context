/**
 * What a recording does with the audio, said once.
 *
 * ## It used to be said before every meeting, and now it is not
 *
 * These sentences lived on the destination sheet, which stood in front of every
 * recording anybody ever started. The sheet is gone — `useMeetingFlow` argues
 * why, in the owner's words — and the sentences did not go with it: they moved
 * to the meetings settings pane, where somebody reads them once, and what stays
 * in front of a recording is the **indicator**, which is the thing
 * `docs/decisions/meetings.md` actually protects. A card that says *recording*,
 * with a clock, a meter and the path the note is going to, for the whole length
 * of the run.
 *
 * They are strings in their own module for the reason the folder rules are: a
 * sentence about what happens to somebody's audio is a claim this product
 * makes, and it belongs somewhere a test can read it without a renderer.
 */

/** What the recording actually does with the audio. */
export const AUDIO_SENTENCE =
  "What you type and the transcript become one Markdown note in storage you own. " +
  "The audio is transcribed and then discarded — it is never written to your bucket.";

/**
 * What a build that hears only the microphone is recording, said plainly.
 *
 * Shown wherever `systemAudio` is not on offer, which is a browser, a phone,
 * and a desktop shell whose build macOS will not hand a loopback tap. It is the
 * sentence `capture/audio.web.ts` and `notesOnly.ts` have always made in their
 * headers. It is said in settings now rather than before every recording; the
 * card that runs beside a meeting says which of the two it is doing.
 */
export const MIC_ONLY_SENTENCE =
  "This records the room and your own side of the call. The far side of a call on headphones is not in the recording.";

/**
 * What a build that takes the machine's own audio records, said plainly.
 *
 * There is no switch beside it any more: the owner removed the setting
 * (2026-10-01) — *"make sure this is default on, I dont know why there is an
 * option to turn it off"*. Two sentences because the two mechanisms cost
 * different things. The desktop app's tap asks nothing; a browser can reach
 * the machine's audio only through its own share picker, which it shows at
 * every recording, and the least confusing answer in it is the whole screen
 * with system audio on, not a tab somebody has to find.
 */
export const BOTH_SIDES_SENTENCE =
  "Meetings record both sides of a call: your microphone and this computer's own audio.";

export const BROWSER_SHARE_SENTENCE =
  "When a recording starts, your browser asks what to share. Choose Entire screen and turn on system audio. Browsers can't hear a computer's audio without asking; the desktop app can.";
