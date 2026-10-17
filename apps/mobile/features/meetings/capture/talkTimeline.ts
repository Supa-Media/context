import type { TranscriptSegment } from "../protocol";

/**
 * WHO WAS LOUDER WHILE A LINE WAS SAID: THE MICROPHONE, OR THE CALL.
 *
 * A browser records a call as one file, the microphone and the shared tab
 * mixed, so the transcription engine cannot know which side said what and
 * answers `mixed` for every segment. But the recorder can know: the live card's
 * You and Call meters (board m3) read one analyser per input ten times a
 * second, and the same readings, kept for a few minutes against the session
 * clock, say which side was speaking while each segment was said (board m5,
 * approved by the owner on 2026-10-17: "we should even show that in the
 * transcript to distinguish speakers").
 *
 * The answer is deliberately cautious, because a wrong name in somebody's
 * permanent note is worse than no name:
 *
 *  - A tick counts only when one side is clearly speaking (`VOICE_FLOOR`) and
 *    is clearly louder than the other (`MARGIN`). On speakers rather than
 *    headphones the microphone hears the call too, quieter; the margin is what
 *    keeps that echo from reading as you.
 *  - A segment is `mic` or `system` only when one side holds `DOMINANT` of its
 *    voiced ticks, and there are at least `MIN_VOICED` of them. Both talking at
 *    once, or too little to go on, is `mixed`, which the note draws as
 *    "Speaker".
 *  - With no call reading anywhere in the segment's window there is no answer
 *    at all (`null`), and the segment keeps what the engine said. A room
 *    meeting, a share that carried no sound, and a browser with no analyser
 *    therefore never gain a speaker.
 *
 * Nothing here is audio: a reading is two numbers between 0 and 1, held in
 * memory for `KEEP_MS` and dropped with the recorder.
 */

/** Meter level (0..1 over -55..0 dBFS) below which a side is not speaking: about -41 dBFS. */
export const VOICE_FLOOR = 0.25;
/** How much louder one side must be for a tick to be its: about 5.5 dB. */
export const MARGIN = 0.1;
/** Share of a segment's voiced ticks one side must hold to be named. */
export const DOMINANT = 0.7;
/** Fewer voiced ticks than this (at 10 a second) is too little to name anyone. */
export const MIN_VOICED = 3;
/** How long readings are kept. A segment answers well inside this; see `MAX_INFLIGHT_CHUNKS`. */
export const KEEP_MS = 5 * 60_000;
/** Slack either side of a segment, because an engine's word timings are approximate. */
const PAD_MS = 200;

interface Reading {
  atMs: number;
  you: number | null;
  call: number | null;
}

export interface TalkTimeline {
  /** One meter reading, on the session clock. */
  note(atMs: number, you: number | null, call: number | null): void;
  /** Which side said `[startMs, endMs]`, or `null` when there is no call to compare against. */
  channelFor(startMs: number, endMs: number): TranscriptSegment["channel"] | null;
  /** Forget everything: a new session. */
  clear(): void;
}

export function talkTimeline(): TalkTimeline {
  let readings: Reading[] = [];

  return {
    note(atMs, you, call) {
      if (!Number.isFinite(atMs)) return;
      readings.push({ atMs, you, call });
      const cutoff = atMs - KEEP_MS;
      if (readings.length > 0 && readings[0].atMs < cutoff) {
        readings = readings.filter((reading) => reading.atMs >= cutoff);
      }
    },

    channelFor(startMs, endMs) {
      const from = startMs - PAD_MS;
      const to = Math.max(startMs, endMs) + PAD_MS;
      let heardCall = false;
      let mine = 0;
      let theirs = 0;
      let voiced = 0;
      for (const { atMs, you, call } of readings) {
        if (atMs < from || atMs > to) continue;
        if (call === null) continue;
        heardCall = true;
        const me = you ?? 0;
        if (Math.max(me, call) < VOICE_FLOOR) continue;
        voiced += 1;
        if (me - call >= MARGIN) mine += 1;
        else if (call - me >= MARGIN) theirs += 1;
      }
      if (!heardCall) return null;
      if (voiced < MIN_VOICED) return "mixed";
      if (mine / voiced >= DOMINANT) return "mic";
      if (theirs / voiced >= DOMINANT) return "system";
      return "mixed";
    },

    clear() {
      readings = [];
    },
  };
}
