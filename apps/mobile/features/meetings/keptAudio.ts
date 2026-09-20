import type { SpooledAudioCounts } from "./capture";
import type { MeetingState } from "./protocol";

/**
 * What the screens say about audio kept on this phone, in one place.
 *
 * Three surfaces say it — the recording bar, the live screen's chip, and the
 * meeting's own note — and two sentences for one fact is how a person ends up
 * watching the claim change under them for no reason they can see. So the
 * words are here, pure, and a test reads them without a renderer.
 *
 * The one rule behind all of them: **audio on this phone is not audio lost,
 * and not audio transcribed**, and every sentence has to leave the person
 * knowing which of the three they have. "Offline" is only ever said when the
 * reachability hook said it; otherwise the audio is simply waiting its turn.
 */

/** The sentence the owner asked for, verbatim, while a meeting records offline. */
export const OFFLINE_RECORDING =
  "Offline — recording is saved on this phone and will be transcribed when you're back online";

export function pieces(count: number): string {
  return count === 1 ? "1 piece" : `${count} pieces`;
}

/** The live meeting's chip. `null` when nothing is waiting. */
export function liveAudioLine(
  counts: SpooledAudioCounts | undefined,
  offline: boolean,
): string | null {
  const waiting = counts?.waiting ?? 0;
  if (offline) return waiting > 0 ? `${OFFLINE_RECORDING} · ${pieces(waiting)} waiting` : OFFLINE_RECORDING;
  if (waiting === 0) return null;
  return `Saved on this phone · ${pieces(waiting)} of audio waiting to be transcribed`;
}

/** The recording bar has room for a word or two. The full sentence is its label. */
export function barAudioBadge(
  counts: SpooledAudioCounts | undefined,
  offline: boolean,
): { short: string; label: string } | null {
  const line = liveAudioLine(counts, offline);
  if (line === null) return null;
  const waiting = counts?.waiting ?? 0;
  const short = offline ? (waiting > 0 ? `On phone · ${waiting}` : "On phone") : `${waiting} to send`;
  return { short, label: line };
}

/**
 * What a meeting that has ended says about its audio, or `null` for nothing.
 *
 * `waiting` holds the note back (`controller.ts`'s `sync`), so the sentence
 * says the note is coming and what it is waiting for. Chunks the transcriber
 * refused on their own merits (`kept - waiting`) no longer hold it, and are
 * said separately: they are on the phone, they are the person's, and they are
 * not in the note.
 */
export function endedAudioLine(
  counts: SpooledAudioCounts | undefined,
  offline: boolean,
  state: MeetingState,
): string | null {
  const waiting = counts?.waiting ?? 0;
  const kept = counts?.kept ?? 0;
  const setAside = state === "complete" || state === "empty" ? kept : kept - waiting;
  const parts: string[] = [];
  if (waiting > 0 && state !== "complete" && state !== "empty") {
    parts.push(
      offline
        ? `Offline — ${pieces(waiting)} of this recording ${waiting === 1 ? "is" : "are"} saved on this phone and will be transcribed when you're back online. The note is written once ${waiting === 1 ? "it is" : "they are"} in.`
        : `${pieces(waiting)} of this recording ${waiting === 1 ? "is" : "are"} still being transcribed from this phone. The note is written once ${waiting === 1 ? "it is" : "they are"} in.`,
    );
  }
  if (setAside > 0) {
    parts.push(
      `${pieces(setAside)} of this recording could not be transcribed and ${setAside === 1 ? "is" : "are"} kept on this phone.`,
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
}

/** Under `## Transcript` on the note screen, while the transcript is incomplete. */
export function transcriptIncompleteLine(counts: SpooledAudioCounts | undefined): string | null {
  const kept = counts?.kept ?? 0;
  if (kept === 0) return null;
  return `Incomplete — ${pieces(kept)} of audio on this phone ${kept === 1 ? "is" : "are"} not in this transcript yet.`;
}
